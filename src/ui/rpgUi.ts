import { ITEMS } from '../rpg/items';
import { NPC_NAMES, QUESTS, SHOP_STOCK, type DialogPage, type DialogAction, type NpcId } from '../rpg/quests';
import { xpToNext, type Attributes, type GameState } from '../rpg/state';
import * as THREE from 'three/webgpu';
import type { Npc } from '../game/npc';
import { audio } from '../game/audio';

type Tab = 'character' | 'inventory' | 'quests' | 'shop';

const el = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

/** Toasts, quest tracker, interaction prompt, dialog box and the game menu. */
export class RpgUi {
  private hud = document.getElementById('hud')!;
  private toasts = el('<div id="toasts"></div>');
  private tracker = el('<div id="quest-tracker"></div>');
  private prompt = el('<div id="prompt"></div>');
  private info = el('<div id="player-info"></div>');
  private dialog = el('<div id="dialog" hidden><div class="who"></div><div class="text"></div><div class="choices"></div></div>');
  private menu = el('<div id="menu" hidden><div class="menu-box"><div class="tabs"></div><div class="body"></div><button class="close">✕</button></div></div>');
  private interactBtn = document.querySelector<HTMLElement>('.tb-interact');
  private tab: Tab = 'character';
  private tags = new Map<Npc, HTMLElement>();
  private tagLayer = el('<div id="npc-tags"></div>');
  private tmp = new THREE.Vector3();
  private pages: DialogPage[] = [];
  private page = 0;
  private dialogNpc: NpcId | null = null;
  /** Invoked when the player picks a dialog choice. */
  onDialogAction: ((npc: NpcId, action: DialogAction) => void) | null = null;
  onUsePotion: ((id: string) => void) | null = null;

  constructor(private state: GameState) {
    this.hud.append(this.tagLayer, this.toasts, this.tracker, this.prompt);
    document.getElementById('player-bars')?.prepend(this.info);
    document.body.append(this.dialog, this.menu);
    this.menu.querySelector('.close')!.addEventListener('click', () => this.closeMenu());
    this.menu.addEventListener('click', (e) => {
      if (e.target === this.menu) this.closeMenu();
    });
    this.dialog.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.advance();
    });
    document.getElementById('btn-menu')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });
    state.onChange(() => this.refresh());
    state.onNotify = (text) => this.toast(text);
    this.refresh();
  }

  get dialogOpen(): boolean {
    return !this.dialog.hidden;
  }

  get menuOpen(): boolean {
    return !this.menu.hidden;
  }

  toast(text: string): void {
    const t = el(`<div class="toast">${text}</div>`);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  setPrompt(npc: NpcId | null): void {
    this.prompt.textContent = npc && !this.dialogOpen ? `[F] 與 ${NPC_NAMES[npc]} 交談` : '';
    this.prompt.style.display = npc && !this.dialogOpen ? '' : 'none';
    if (this.interactBtn) this.interactBtn.hidden = !npc || this.dialogOpen;
  }

  /** Name tags with quest markers: ! = new quest, ? = ready to turn in. */
  updateTags(npcs: Npc[], camera: THREE.PerspectiveCamera, player: THREE.Vector3, questOf: Record<NpcId, string>): void {
    for (const n of npcs) {
      let tag = this.tags.get(n);
      if (!tag) {
        tag = el(`<div class="npc-tag"><b></b><span>${NPC_NAMES[n.id]}</span></div>`);
        this.tagLayer.append(tag);
        this.tags.set(n, tag);
      }
      const d = n.position.distanceTo(player);
      this.tmp.copy(n.head(this.tmp)).project(camera);
      const visible = d < 40 && this.tmp.z < 1 && !this.dialogOpen;
      tag.style.display = visible ? '' : 'none';
      if (!visible) continue;
      tag.style.left = `${(this.tmp.x * 0.5 + 0.5) * window.innerWidth}px`;
      tag.style.top = `${(-this.tmp.y * 0.5 + 0.5) * window.innerHeight}px`;
      tag.style.opacity = String(Math.min(1, (40 - d) / 10));
      const q = this.state.quest(questOf[n.id]).state;
      tag.querySelector('b')!.textContent = q === 'inactive' ? '!' : q === 'ready' ? '?' : '';
    }
  }

  // ------------------------------------------------------------------ dialog
  openDialog(npc: NpcId, pages: DialogPage[]): void {
    document.exitPointerLock?.();
    this.dialogNpc = npc;
    this.pages = pages;
    this.page = 0;
    this.dialog.hidden = false;
    audio.play('page', { bus: 'ui', volume: 0.7 });
    this.renderPage();
  }

  closeDialog(): void {
    this.dialog.hidden = true;
    this.dialogNpc = null;
  }

  /** Next page, or close on the last page when it has no choices. */
  advance(): void {
    if (!this.dialogOpen) return;
    const current = this.pages[this.page];
    if (current.choices) return;
    if (this.page < this.pages.length - 1) {
      this.page++;
      audio.play('page', { bus: 'ui', volume: 0.6 });
      this.renderPage();
    } else {
      this.closeDialog();
    }
  }

  private renderPage(): void {
    const p = this.pages[this.page];
    this.dialog.querySelector('.who')!.textContent = NPC_NAMES[this.dialogNpc!];
    this.dialog.querySelector('.text')!.textContent = p.text;
    const choices = this.dialog.querySelector('.choices')!;
    choices.innerHTML = '';
    if (!p.choices) {
      choices.append(el(`<span class="more">${this.page < this.pages.length - 1 ? '繼續 ▸' : '結束 ▸'}</span>`));
      return;
    }
    for (const c of p.choices) {
      const b = el(`<button>${c.label}</button>`);
      b.addEventListener('click', () => {
        const npc = this.dialogNpc!;
        this.closeDialog();
        this.onDialogAction?.(npc, c.action);
      });
      choices.append(b);
    }
  }

  // ------------------------------------------------------------------ menu
  toggleMenu(tab?: Tab): void {
    if (this.menuOpen && !tab) this.closeMenu();
    else this.openMenu(tab ?? (this.tab === 'shop' ? 'character' : this.tab));
  }

  openMenu(tab: Tab): void {
    document.exitPointerLock?.();
    this.tab = tab;
    if (this.menu.hidden) audio.play('book_open', { bus: 'ui', volume: 0.7 });
    this.menu.hidden = false;
    this.renderMenu();
  }

  closeMenu(): void {
    if (!this.menu.hidden) audio.play('book_close', { bus: 'ui', volume: 0.6 });
    this.menu.hidden = true;
  }

  private refresh(): void {
    const d = this.state.data;
    this.info.innerHTML = `<span class="lv">Lv.${d.level}</span><span class="xp"><i style="transform:scaleX(${d.xp / xpToNext(d.level)})"></i></span><span class="gold">◈ ${d.gold}</span>${d.points ? '<span class="pts">＋</span>' : ''}`;
    const active = Object.entries(d.quests).filter(([, q]) => q.state === 'active' || q.state === 'ready');
    this.tracker.innerHTML = active.map(([id, q]) => {
      const def = QUESTS[id];
      const goal = q.state === 'ready' ? `回報 ${NPC_NAMES[def.giver]}` : `${def.target.label} ${q.progress}/${def.target.count}`;
      return `<div class="q${def.main ? ' main' : ''}"><b>${def.title}</b><span>${goal}</span></div>`;
    }).join('');
    if (this.menuOpen) this.renderMenu();
  }

  private renderMenu(): void {
    const tabs: [Tab, string][] = [['character', '角色'], ['inventory', '背包'], ['quests', '任務']];
    if (this.tab === 'shop') tabs.push(['shop', '商店']);
    const tabsEl = this.menu.querySelector('.tabs')!;
    tabsEl.innerHTML = '';
    for (const [id, label] of tabs) {
      const b = el(`<button class="${id === this.tab ? 'active' : ''}">${label}</button>`);
      b.addEventListener('click', () => {
        this.tab = id;
        audio.play('page', { bus: 'ui', volume: 0.5 });
        this.renderMenu();
      });
      tabsEl.append(b);
    }
    const body = this.menu.querySelector('.body')!;
    body.innerHTML = '';
    if (this.tab === 'character') body.append(this.characterTab());
    if (this.tab === 'inventory') body.append(this.inventoryTab());
    if (this.tab === 'quests') body.append(this.questsTab());
    if (this.tab === 'shop') body.append(this.shopTab());
  }

  private characterTab(): HTMLElement {
    const d = this.state.data;
    const s = this.state.stats();
    const attrs: [keyof Attributes, string, string][] = [['str', '力量', '提升攻擊力'], ['vit', '體質', '提升生命與防禦'], ['agi', '敏捷', '提升暴擊率']];
    const box = el(`<div class="char">
      <div class="row big">Lv.${d.level}　<small>經驗 ${d.xp} / ${xpToNext(d.level)}</small></div>
      <div class="row">可用屬性點：<b>${d.points}</b></div>
      <div class="attrs"></div>
      <div class="derived">生命 ${s.maxHp}　攻擊 ${s.atk}　防禦 ${s.def}　暴擊 ${Math.round(s.critChance * 100)}%</div>
      <div class="row">武器：${ITEMS[d.equipped.weapon].name}　盾牌：${ITEMS[d.equipped.shield].name}　防具：${ITEMS[d.equipped.armor].name}</div>
      <div class="row">金幣：◈ ${d.gold}</div></div>`);
    const list = box.querySelector('.attrs')!;
    for (const [key, name, hint] of attrs) {
      const row = el(`<div class="attr"><span>${name} <b>${d.attrs[key]}</b></span><small>${hint}</small><button ${d.points ? '' : 'disabled'}>＋</button></div>`);
      row.querySelector('button')!.addEventListener('click', () => this.state.spendPoint(key));
      list.append(row);
    }
    return box;
  }

  private inventoryTab(): HTMLElement {
    const d = this.state.data;
    const box = el('<div class="items"></div>');
    for (const [id, n] of Object.entries(d.inventory)) {
      const def = ITEMS[id];
      if (!def) continue;
      const equipped = d.equipped.weapon === id || d.equipped.armor === id || d.equipped.shield === id;
      const stat = def.kind === 'shield' ? `格擋 ${Math.round((def.guard ?? 0) * 100)}%${def.def ? `・防禦 +${def.def}` : ''}` : def.atk ? `攻擊 +${def.atk}` : def.def !== undefined && def.kind === 'armor' ? `防禦 +${def.def}${def.hp ? `・生命 +${def.hp}` : ''}` : '';
      const action = def.kind === 'consumable' ? '使用' : equipped ? '已裝備' : '裝備';
      const row = el(`<div class="item"><div><b>${def.name}</b>${n > 1 ? ` ×${n}` : ''}<small>${def.desc} ${stat}</small></div><button ${equipped ? 'disabled' : ''}>${action}</button></div>`);
      row.querySelector('button')!.addEventListener('click', () => {
        if (def.kind === 'consumable') this.onUsePotion?.(id);
        else {
          audio.play('equip', { bus: 'ui', volume: 0.8 });
          this.state.equip(id);
        }
      });
      box.append(row);
    }
    return box;
  }

  private questsTab(): HTMLElement {
    const box = el('<div class="items"></div>');
    const label = { inactive: '', active: '進行中', ready: '可回報', done: '已完成' };
    const entries = Object.entries(this.state.data.quests).filter(([, q]) => q.state !== 'inactive');
    if (!entries.length) box.append(el('<div class="empty">尚未接受任務。和村裡的人們聊聊吧。</div>'));
    for (const [id, q] of entries) {
      const def = QUESTS[id];
      box.append(el(`<div class="item"><div><b>${def.main ? '【主線】' : '【支線】'}${def.title}</b><small>${def.target.label} ${q.progress}/${def.target.count}・委託人：${NPC_NAMES[def.giver]}</small></div><span class="tag">${label[q.state]}</span></div>`));
    }
    return box;
  }

  private shopTab(): HTMLElement {
    const box = el(`<div class="items"><div class="row">持有金幣：◈ ${this.state.data.gold}</div></div>`);
    for (const id of SHOP_STOCK) {
      const def = ITEMS[id];
      const row = el(`<div class="item"><div><b>${def.name}</b><small>${def.desc}</small></div><button ${this.state.data.gold < def.price ? 'disabled' : ''}>◈ ${def.price}</button></div>`);
      row.querySelector('button')!.addEventListener('click', () => {
        if (this.state.buy(id)) audio.play('coins', { bus: 'ui' });
        else audio.play('error', { bus: 'ui' });
      });
      box.append(row);
    }
    return box;
  }
}
