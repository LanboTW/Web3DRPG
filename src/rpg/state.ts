import type { Stats } from '../game/combat';
import type { EnemyKind } from '../game/enemy';
import { ITEMS } from './items';
import { QUESTS, type QuestState } from './quests';

export interface Attributes {
  /** 力量: attack. */
  str: number;
  /** 體質: health and defense. */
  vit: number;
  /** 敏捷: critical chance. */
  agi: number;
}

export interface SaveData {
  version: 1;
  level: number;
  xp: number;
  points: number;
  attrs: Attributes;
  gold: number;
  inventory: Record<string, number>;
  equipped: { weapon: string; armor: string; shield: string };
  quests: Record<string, { state: QuestState; progress: number }>;
  bossDefeated: boolean;
}

const SAVE_KEY = 'web3drpg.save';
const POINTS_PER_LEVEL = 3;

export function xpToNext(level: number): number {
  return Math.round(60 * Math.pow(level, 1.5));
}

function fresh(): SaveData {
  return {
    version: 1, level: 1, xp: 0, points: 0,
    attrs: { str: 3, vit: 3, agi: 3 },
    gold: 30,
    inventory: { iron_sword: 1, cloth: 1, wood_shield: 1, potion: 3 },
    equipped: { weapon: 'iron_sword', armor: 'cloth', shield: 'wood_shield' },
    quests: Object.fromEntries(Object.keys(QUESTS).map((id) => [id, { state: 'inactive' as QuestState, progress: 0 }])),
    bossDefeated: false,
  };
}

type Listener = () => void;

/** All persistent RPG progress; UI subscribes via `onChange`. */
export class GameState {
  data: SaveData;
  private listeners = new Set<Listener>();
  /** Fired with a message for toasts (level up, loot, quest updates). */
  onNotify: ((text: string) => void) | null = null;

  constructor() {
    this.data = GameState.load() ?? fresh();
  }

  static load(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? GameState.validate(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  /** Accepts a parsed save only if it has the expected shape; fills new quests. */
  static validate(d: unknown): SaveData | null {
    const s = d as SaveData;
    if (!s || s.version !== 1 || typeof s.level !== 'number' || !s.attrs || !s.inventory || !s.equipped) return null;
    const base = fresh();
    for (const id of Object.keys(base.quests)) s.quests[id] ??= base.quests[id];
    // Saves from before shields existed start with the wooden one.
    if (!s.equipped.shield) {
      s.equipped.shield = 'wood_shield';
      s.inventory.wood_shield ??= 1;
    }
    return s;
  }

  save(): void {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch { /* storage unavailable */ }
  }

  exportJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  importJson(json: string): boolean {
    try {
      const d = GameState.validate(JSON.parse(json));
      if (!d) return false;
      this.data = d;
      this.save();
      this.changed();
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.data = fresh();
    this.save();
    this.changed();
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  changed(): void {
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  private notify(text: string): void {
    this.onNotify?.(text);
  }

  /** Combat stats derived from level, attributes and gear. */
  stats(): Stats {
    const { str, vit, agi } = this.data.attrs;
    const w = ITEMS[this.data.equipped.weapon];
    const a = ITEMS[this.data.equipped.armor];
    const sh = ITEMS[this.data.equipped.shield];
    return {
      maxHp: 100 + vit * 12 + (this.data.level - 1) * 6 + (a?.hp ?? 0),
      atk: 8 + str * 2 + (this.data.level - 1) + (w?.atk ?? 0),
      def: 2 + Math.floor(vit * 0.5) + (a?.def ?? 0) + (sh?.def ?? 0),
      critChance: Math.min(0.6, 0.04 + agi * 0.012 + (w?.crit ?? 0)),
    };
  }

  addXp(amount: number): boolean {
    const d = this.data;
    d.xp += amount;
    let leveled = false;
    while (d.xp >= xpToNext(d.level)) {
      d.xp -= xpToNext(d.level);
      d.level++;
      d.points += POINTS_PER_LEVEL;
      leveled = true;
      this.notify(`等級提升！ Lv.${d.level}（獲得 ${POINTS_PER_LEVEL} 點屬性點）`);
    }
    this.changed();
    return leveled;
  }

  spendPoint(attr: keyof Attributes): void {
    if (this.data.points <= 0) return;
    this.data.points--;
    this.data.attrs[attr]++;
    this.changed();
  }

  addGold(n: number): void {
    this.data.gold = Math.max(0, this.data.gold + n);
    this.changed();
  }

  addItem(id: string, n = 1): void {
    this.data.inventory[id] = (this.data.inventory[id] ?? 0) + n;
    this.notify(`獲得 ${ITEMS[id].name}${n > 1 ? ` ×${n}` : ''}`);
    this.changed();
  }

  removeItem(id: string, n = 1): boolean {
    const have = this.data.inventory[id] ?? 0;
    if (have < n) return false;
    if (have === n) delete this.data.inventory[id];
    else this.data.inventory[id] = have - n;
    this.changed();
    return true;
  }

  equip(id: string): void {
    const def = ITEMS[id];
    if (!def || !this.data.inventory[id]) return;
    if (def.kind === 'weapon') this.data.equipped.weapon = id;
    if (def.kind === 'armor') this.data.equipped.armor = id;
    if (def.kind === 'shield') this.data.equipped.shield = id;
    this.changed();
  }

  buy(id: string): boolean {
    const def = ITEMS[id];
    if (this.data.gold < def.price) return false;
    this.data.gold -= def.price;
    this.addItem(id);
    return true;
  }

  quest(id: string) {
    return this.data.quests[id];
  }

  acceptQuest(id: string): void {
    const q = this.data.quests[id];
    if (q.state !== 'inactive') return;
    q.state = 'active';
    q.progress = 0;
    this.notify(`接受任務：${QUESTS[id].title}`);
    // The boss may already be dead if the player wandered there first.
    if (id === 'main_knight' && this.data.bossDefeated) this.recordKill('knight');
    this.changed();
  }

  /** Counts a kill toward every active quest that wants that enemy kind. */
  recordKill(kind: EnemyKind): void {
    if (kind === 'knight') this.data.bossDefeated = true;
    for (const [id, q] of Object.entries(this.data.quests)) {
      const def = QUESTS[id];
      if (q.state !== 'active' || def.target.kind !== kind) continue;
      q.progress = Math.min(def.target.count, q.progress + 1);
      if (q.progress >= def.target.count) {
        q.state = 'ready';
        this.notify(`任務目標完成：${def.title}（回報給委託人）`);
      }
    }
    this.changed();
  }

  turnInQuest(id: string): void {
    const q = this.data.quests[id];
    const def = QUESTS[id];
    if (q.state !== 'ready') return;
    q.state = 'done';
    this.notify(`任務完成：${def.title}`);
    this.addGold(def.reward.gold);
    for (const [item, n] of Object.entries(def.reward.items ?? {})) this.addItem(item, n);
    this.addXp(def.reward.xp);
  }
}
