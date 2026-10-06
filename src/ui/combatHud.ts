import * as THREE from 'three/webgpu';
import { t } from '../i18n';
import type { Combatant } from '../game/combat';
import type { Enemy } from '../game/enemy';
import { SKILLS, type Player } from '../game/player';

const SKILL_KEYS = { skill1: 'Q', skill2: 'E', ultimate: 'R' } as const;
type SkillName = keyof typeof SKILL_KEYS;

/** Health/ult bars, skill cooldowns, floating enemy bars, damage numbers, lock reticle, boss bar. */
export class CombatHud {
  private hud = document.getElementById('hud')!;
  private hpFill: HTMLElement;
  private ultBar: HTMLElement;
  private ultFill: HTMLElement;
  private skillEls = new Map<SkillName, HTMLElement[]>();
  private enemyLayer: HTMLElement;
  private dmgLayer: HTMLElement;
  private reticle: HTMLElement;
  private bossBar: HTMLElement;
  private bossFill: HTMLElement;
  private death: HTMLElement;
  private banner: HTMLElement;
  private bars = new Map<Enemy, HTMLElement>();
  private tmp = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, touch: boolean) {
    const el = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html.trim();
      return d.firstElementChild as HTMLElement;
    };
    const bars = el(`<div id="player-bars">
      <div class="bar hp"><i></i></div>
      <div class="bar ult"><i></i></div></div>`);
    this.hud.append(bars);
    this.hpFill = bars.querySelector('.hp > i')!;
    this.ultBar = bars.querySelector('.ult')!;
    this.ultFill = bars.querySelector('.ult > i')!;

    for (const name of Object.keys(SKILL_KEYS) as SkillName[]) this.skillEls.set(name, []);
    if (!touch) {
      const bar = el('<div id="skillbar"></div>');
      for (const name of Object.keys(SKILL_KEYS) as SkillName[]) {
        const s = el(`<div class="skill"><b>${SKILL_KEYS[name]}</b>${t(`skill.${name}`)}</div>`);
        bar.append(s);
        this.skillEls.get(name)!.push(s);
      }
      this.hud.append(bar);
    }
    document.querySelectorAll<HTMLElement>('#touch-buttons .tb').forEach((b) => {
      const name = b.dataset.action as SkillName;
      if (name in SKILL_KEYS) this.skillEls.get(name)!.push(b);
    });

    this.enemyLayer = el('<div id="enemy-bars"></div>');
    this.dmgLayer = el('<div id="damage-numbers"></div>');
    this.reticle = el('<div id="lock-reticle"></div>');
    this.bossBar = el(`<div id="boss-bar"><div class="name">${t('enemy.knight')}</div><div class="bar"><i></i></div></div>`);
    this.bossFill = this.bossBar.querySelector('i')!;
    this.banner = el('<div id="banner"></div>');
    this.hud.append(this.enemyLayer, this.dmgLayer, this.reticle, this.bossBar, this.banner);
    this.death = el(`<div id="death"><div class="big">${t('hud.dead')}</div><div>${t('hud.respawn')}</div></div>`);
    document.body.append(this.death);
  }

  /** Projects a world point to CSS pixels; null when behind the camera. */
  private project(p: THREE.Vector3): { x: number; y: number } | null {
    this.tmp.copy(p).project(this.camera);
    if (this.tmp.z > 1) return null;
    return { x: (this.tmp.x * 0.5 + 0.5) * window.innerWidth, y: (-this.tmp.y * 0.5 + 0.5) * window.innerHeight };
  }

  damageNumber(target: Combatant, amount: number, crit: boolean, byPlayer: boolean): void {
    const anchor = (target as Enemy).chest ? (target as Enemy).chest(new THREE.Vector3()) : target.position.clone().setY(target.position.y + 1.6);
    anchor.y += 0.4;
    const s = this.project(anchor);
    if (!s) return;
    const d = document.createElement('div');
    d.className = `dmg${crit ? ' crit' : ''}${byPlayer ? '' : ' taken'}`;
    d.textContent = String(amount);
    d.style.left = `${s.x + (Math.random() - 0.5) * 30}px`;
    d.style.top = `${s.y}px`;
    this.dmgLayer.append(d);
    setTimeout(() => d.remove(), 800);
  }

  showBanner(text: string, seconds = 3): void {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    setTimeout(() => this.banner.classList.remove('show'), seconds * 1000);
  }

  update(player: Player, enemies: Enemy[], boss: Enemy | undefined): void {
    this.hpFill.style.transform = `scaleX(${player.hp / player.stats.maxHp})`;
    this.ultFill.style.transform = `scaleX(${player.ultCharge / 100})`;
    const ultReady = player.ultCharge >= 100;
    this.ultBar.classList.toggle('full', ultReady);
    for (const [name, els] of this.skillEls) {
      const total = SKILLS[name].cooldown ?? 0;
      const cd = name === 'ultimate' ? 1 - player.ultCharge / 100 : total ? player.cooldowns[name] / total : 0;
      for (const e of els) {
        e.style.setProperty('--cd', String(cd));
        e.classList.toggle('ready-ult', name === 'ultimate' && ultReady);
      }
    }

    // Floating bars for engaged regular enemies.
    for (const e of enemies) {
      const show = e.alive && e.engaged && !e.def.boss && e.position.distanceTo(player.position) < 30;
      let bar = this.bars.get(e);
      if (!show) {
        if (bar) bar.style.display = 'none';
        continue;
      }
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'ebar';
        bar.innerHTML = '<i></i>';
        this.enemyLayer.append(bar);
        this.bars.set(e, bar);
      }
      const s = this.project(e.chest(this.tmp).setY(this.tmp.y + 0.75));
      if (!s) {
        bar.style.display = 'none';
        continue;
      }
      bar.style.display = '';
      bar.style.left = `${s.x}px`;
      bar.style.top = `${s.y}px`;
      bar.classList.toggle('telegraph', e.telegraphing);
      (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${e.hp / e.stats.maxHp})`;
    }

    const lock = player.lockTarget;
    const ls = lock ? this.project(lock.chest(new THREE.Vector3())) : null;
    this.reticle.style.display = ls ? 'block' : 'none';
    if (ls) {
      this.reticle.style.left = `${ls.x}px`;
      this.reticle.style.top = `${ls.y}px`;
    }

    const bossVisible = !!boss && boss.alive && boss.engaged;
    this.bossBar.style.display = bossVisible ? 'block' : 'none';
    if (boss && bossVisible) this.bossFill.style.transform = `scaleX(${boss.hp / boss.stats.maxHp})`;

    this.death.style.display = player.alive ? 'none' : 'flex';
  }
}
