import './style.css';
import * as THREE from 'three/webgpu';
import { applyI18n, t } from './i18n';
import { loadChoice, resolveQuality } from './engine/quality';
import { backendName, createRenderer, DynamicResolution, webGPUAvailable } from './engine/renderer';
import { Input } from './input/input';
import { canGrow, createWorld } from './game/world';
import { createVegetation } from './game/vegetation';
import { loadProps } from './game/props';
import { createGrass } from './game/grass';
import { createAtmosphere, SKY_SUN } from './game/sky';
import { PostStack } from './engine/post';
import { createTerrainMaterial } from './game/terrainMaterial';
import { Player } from './game/player';
import { loadCharacter } from './game/character';
import { ThirdPersonCamera } from './game/camera';
import { BANDIT_CAMP, DAIS, groundAt, RUINS_CENTER, streamQuery, VILLAGE_CENTER, VILLAGE_RADIUS } from './game/terrain';
import { audio, type MusicTrack } from './game/audio';
import { hideLoading, nextFrame, setProgress, showError } from './ui/loading';
import { Hud } from './ui/hud';
import { CombatHud } from './ui/combatHud';
import { EnemyManager } from './game/enemies';
import { Vfx } from './game/vfx';
import type { CombatEvents } from './game/combat';
import { Npc, INTERACT_RANGE } from './game/npc';
import { GameState } from './rpg/state';
import { ITEMS } from './rpg/items';
import { NPC_NAMES, QUESTS, dialogFor, type NpcId } from './rpg/quests';
import { RpgUi } from './ui/rpgUi';
import { Minimap } from './ui/minimap';
import { CombatTutorial, PointerGate } from './ui/guide';
import type { Chest } from './game/world';
import type { ColliderWorld } from './game/colliders';

async function main(): Promise<void> {
  applyI18n();
  setProgress(0.05, 'loading.renderer');
  await nextFrame();

  const choice = loadChoice();
  const quality = resolveQuality(choice, webGPUAvailable());
  const container = document.getElementById('app')!;
  const renderer = await createRenderer(container, quality);
  const backend = backendName(renderer);

  setProgress(0.3, 'loading.world');
  await nextFrame();
  const cameraFar = quality.fogFar + 40;
  const t0 = performance.now();
  const terrainMat = await createTerrainMaterial(quality);
  const { atmosphere, fogNode } = await createAtmosphere(quality, cameraFar * 0.9, quality.fogFar);
  const props = await loadProps(quality);
  const world = createWorld(quality, terrainMat.material, atmosphere, fogNode, props);
  const vegetation = await createVegetation(renderer, quality, world.scene, world.colliders, canGrow);
  const grass = createGrass(quality, world.terrain, terrainMat.grass, world.scene);
  console.info(`world built in ${Math.round(performance.now() - t0)} ms`);

  setProgress(0.4, 'loading.player');
  // Load all character models in parallel; progress is the average.
  const names = ['heroine', 'bandit', 'skeleton', 'knight', 'chief', 'merchant', 'hunter'] as const;
  const fractions = names.map(() => 0);
  const modelDir = { low: 'low/', medium: '', high: 'hd/' }[quality.tier];
  const [heroine, bandit, skeleton, knight, chiefModel, merchantModel, hunterModel] = await Promise.all(
    names.map((n, i) => loadCharacter(`models/${modelDir}${n}.glb`, (f) => {
      fractions[i] = f;
      setProgress(0.4 + (fractions.reduce((a, b) => a + b) / names.length) * 0.5, 'loading.player');
    })),
  );
  setProgress(0.92, 'loading.enemies');
  await nextFrame();
  const state = new GameState();
  const enemies = new EnemyManager({ bandit, skeleton, knight }, state.data.bossDefeated);
  world.scene.add(enemies.group);
  const vfx = new Vfx(world.scene);
  const input = new Input(renderer.domElement);
  const player = new Player(heroine);
  // Dev-only handle for inspecting the scene from the browser console.
  if (import.meta.env.DEV) Object.assign(window, { __game: { player, enemies, input, audio } });
  const applyGear = () => {
    player.setStats(state.stats());
    player.setLook(ITEMS[state.data.equipped.weapon], ITEMS[state.data.equipped.armor], ITEMS[state.data.equipped.shield]);
  };
  applyGear();
  player.hp = player.stats.maxHp;
  let gearKey = '';
  // Jingles for progress: level ups, quest steps and loot.
  let progress = { level: state.data.level, gold: state.data.gold, quests: JSON.stringify(Object.values(state.data.quests).map((q) => q.state)) };
  state.onChange(() => {
    const quests = JSON.stringify(Object.values(state.data.quests).map((q) => q.state));
    if (state.data.level > progress.level) audio.play('levelup', { bus: 'ui' });
    else if (quests !== progress.quests) audio.play('confirm', { bus: 'ui' });
    else if (state.data.gold > progress.gold) audio.play('coins', { bus: 'ui', volume: 0.6 });
    progress = { level: state.data.level, gold: state.data.gold, quests };
  });
  state.onChange(() => {
    const key = `${state.data.equipped.weapon}|${state.data.equipped.armor}|${state.data.equipped.shield}|${state.data.level}|${JSON.stringify(state.data.attrs)}`;
    if (key !== gearKey) {
      gearKey = key;
      applyGear();
    }
  });

  const vx = VILLAGE_CENTER.x;
  const vz = VILLAGE_CENTER.y;
  const npcs = [
    new Npc('chief', chiefModel, vx, vz + 19.5, Math.PI, world.colliders),
    new Npc('merchant', merchantModel, vx - 9, vz - 4, Math.atan2(9, 4), world.colliders),
    new Npc('hunter', hunterModel, vx + 11, vz - 8, Math.atan2(-11, 8), world.colliders),
  ];
  npcs.forEach((n) => world.scene.add(n.root));
  const questOf: Record<NpcId, string> = { chief: 'main_knight', hunter: 'side_bandits', merchant: 'side_undead' };
  // `?spawn=road|camp|ruins` starts elsewhere; handy for testing encounters.
  const spawns: Record<string, [number, number]> = {
    road: [-4, 2], chief: [VILLAGE_CENTER.x + 1, VILLAGE_CENTER.y + 17], camp: [BANDIT_CAMP.x - 14, BANDIT_CAMP.y], ruins: [RUINS_CENTER.x, RUINS_CENTER.y + 40],
  };
  const spawnAt = spawns[new URLSearchParams(location.search).get('spawn') ?? ''] ?? [VILLAGE_CENTER.x + 4, VILLAGE_CENTER.y - 8];
  player.spawn(spawnAt[0], spawnAt[1]);
  world.scene.add(player.root);
  const cam = new ThirdPersonCamera(window.innerWidth / window.innerHeight, cameraFar);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __game: object }).__game, { cam, world });
  const post = new PostStack(renderer, world.scene, cam.camera, quality, SKY_SUN);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __game: object }).__game, { post, atmosphere, vegetation, grass });
  cam.yaw = player.facing + Math.PI;
  cam.snapTo(player.position, player.eyeHeight);
  vegetation.update(cam.camera);
  grass.update(cam.camera, player.position);

  // Compile shaders before revealing the scene to avoid first-frame hitches.
  // WebGL compiles in parallel and polls for completion; never let a stalled
  // poll (throttled background tab) hold the loading screen forever.
  await Promise.race([renderer.compileAsync(world.scene, cam.camera), new Promise((r) => setTimeout(r, 8000))]);

  const dynRes = new DynamicResolution(renderer, quality);
  const hud = new Hud(input, quality, choice, backend, state);
  const combatHud = new CombatHud(cam.camera, input.touch);
  const ui = new RpgUi(state);
  const minimap = new Minimap(world.colliders);
  minimap.onOpen = () => {
    if (!ui.menuOpen && !ui.dialogOpen) minimap.show();
  };
  const gate = new PointerGate(input);
  const tutorial = new CombatTutorial(input);
  tutorial.onFinish = () => state.finishTutorial();
  if (import.meta.env.DEV) bindColliderDebug(world.scene, world.colliders);

  // Treasure chests: loot once, remembered in the save.
  const CHEST_RANGE = 2.8;
  const isOpened = (c: Chest) => state.data.openedChests.includes(c.id);
  const unopened = () => world.chests.filter((c) => !isOpened(c));
  // Looted chests are darkened so it reads why they no longer open.
  const dimChest = (c: Chest) => {
    c.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.dimmed) return;
      mesh.userData.dimmed = true;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const d = m.clone() as THREE.MeshStandardMaterial;
        d.color?.multiplyScalar(0.4);
        return d;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    });
  };
  world.chests.filter(isOpened).forEach(dimChest);
  let chestAnim: { chest: Chest; t: number } | null = null;
  const openChest = (chest: Chest) => {
    if (!state.openChest(chest.id, chest.loot)) return;
    chestAnim = { chest, t: 0 };
    const at = chest.position.clone().setY(chest.position.y + 0.5);
    audio.play('step_wood', { at, rate: 0.6, volume: 1 });
    audio.play('leather', { at, delay: 0.15 });
    audio.play('magic', { at, delay: 0.35, volume: 0.8 });
    vfx.ring(chest.position.clone().setY(chest.position.y + 0.05), 1.4, 0xffd27a, 0.6);
  };
  const animateChest = (dt: number) => {
    if (!chestAnim) return;
    const a = chestAnim;
    a.t += dt;
    const o = a.chest.object;
    // Rattle, pop, then a shower of gold.
    const k = Math.max(0, 1 - a.t / 0.6);
    o.rotation.z = Math.sin(a.t * 45) * 0.06 * k;
    const pop = a.t > 0.3 && a.t < 0.7 ? Math.sin(((a.t - 0.3) / 0.4) * Math.PI) * 0.12 : 0;
    o.scale.setScalar(1 + pop);
    if (a.t > 0.35 && a.t - dt <= 0.35) {
      const at = a.chest.position.clone().setY(a.chest.position.y + 0.7);
      vfx.spark(at, 0xffd27a, 18);
      vfx.burst(at, 1.2, 0xffc040, 0.5);
    }
    if (a.t > 0.8) {
      o.rotation.z = 0;
      o.scale.setScalar(1);
      dimChest(a.chest);
      chestAnim = null;
    }
  };

  // Where the quest tracker points: the main quest first, then active side quests.
  const objective = new THREE.Vector2();
  const npcPos = (id: NpcId) => npcs.find((n) => n.id === id)!.position;
  const questObjective = (): THREE.Vector2 | null => {
    const main = state.quest('main_knight');
    if (main.state === 'inactive' || main.state === 'ready') return objective.set(npcPos('chief').x, npcPos('chief').z);
    if (main.state === 'active') return objective.set(DAIS.x, DAIS.z);
    for (const id of ['side_bandits', 'side_undead']) {
      const q = state.quest(id);
      if (q.state === 'ready') return objective.set(npcPos(QUESTS[id].giver).x, npcPos(QUESTS[id].giver).z);
      if (q.state === 'active') return id === 'side_bandits' ? objective.set(BANDIT_CAMP.x, BANDIT_CAMP.y) : objective.set(RUINS_CENTER.x, RUINS_CENTER.y + 25);
    }
    return null;
  };
  const questMark = (id: NpcId) => {
    const q = state.quest(questOf[id]).state;
    return q === 'inactive' ? '!' : q === 'ready' ? '?' : '';
  };

  const usePotion = (id?: string) => {
    const missing = player.stats.maxHp - player.hp;
    const pick = id ?? (missing > 100 && state.data.inventory.hi_potion ? 'hi_potion' : state.data.inventory.potion ? 'potion' : 'hi_potion');
    if (!player.alive || missing <= 0 || !state.removeItem(pick)) return;
    player.heal(ITEMS[pick].heal ?? 0);
    audio.play('potion', { bus: 'ui' });
    vfx.ring(player.position, 1.2, 0x6dff9a, 0.6);
  };
  ui.onUsePotion = (id) => usePotion(id);
  let talkingTo: Npc | null = null;
  ui.onDialogAction = (npcId, action) => {
    const quest = questOf[npcId];
    if (action === 'accept') state.acceptQuest(quest);
    if (action === 'turnIn') state.turnInQuest(quest);
    if (action === 'shop') ui.openMenu('shop');
  };

  let hitStop = 0;
  const events: CombatEvents = {
    damage: (target, amount, crit, byPlayer) => combatHud.damageNumber(target, amount, crit, byPlayer),
    hitStop: (s) => (hitStop = Math.max(hitStop, s)),
    shake: (s) => (cam.shake = Math.max(cam.shake, s)),
  };
  player.onKill = (enemy) => {
    const def = enemy.def;
    state.addGold(def.gold[0] + Math.floor(Math.random() * (def.gold[1] - def.gold[0] + 1)));
    if (Math.random() < 0.2) state.addItem('potion');
    state.recordKill(def.kind);
    state.addXp(def.xp);
    if (def.boss) {
      combatHud.showBanner(t('hud.bossDefeated'), 4);
      state.addItem('knight_plate');
      state.addItem('knight_shield');
    }
  };
  player.onGuard = (result, at) => {
    audio.play(result === 'parry' ? 'bell' : result === 'block' ? 'plate' : 'plate_heavy', { at, volume: result === 'block' ? 0.9 : 1 });
    if (result !== 'block') audio.play('metal_heavy', { at, volume: result === 'parry' ? 0.7 : 1, rate: result === 'parry' ? 1.2 : 0.85 });
    if (result === 'parry') {
      vfx.spark(at, 0xbfe8ff, 14);
      vfx.ring(at.clone().setY(player.position.y + 0.05), 1.6, 0x9fd8ff, 0.35);
      events.hitStop(0.14);
      events.shake(0.3);
    } else if (result === 'block') {
      vfx.spark(at, 0xffd27a, 5);
      events.shake(0.15);
    } else {
      vfx.spark(at, 0xff6040, 10);
      events.shake(0.45);
    }
  };
  let deadTime = 0;
  // The mouse is recaptured when a menu or dialog closes (that click or key press is the gesture).
  let wantedLock = true;

  window.addEventListener('resize', () => {
    cam.setAspect(window.innerWidth / window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    dynRes.apply();
  });

  if (import.meta.env.DEV) Object.assign(window, { game: { renderer, world, player, cam, input, enemies, state, QUESTS } });

  setProgress(1, 'loading.ready');
  hideLoading();
  // High tier streams sharper ground textures after the game is playable.
  terrainMat.upgrade().catch((e) => console.warn('texture upgrade failed', e));

  // Sound loads in the background; the first tap or key press unlocks it.
  audio.load();
  audio.loop('amb_birds', undefined, 0.45);
  audio.loop('amb_fire', new THREE.Vector3(BANDIT_CAMP.x, groundAt(BANDIT_CAMP.x, BANDIT_CAMP.y) + 0.5, BANDIT_CAMP.y), 1.2, 3);
  const stream = audio.loop('amb_water', new THREE.Vector3(), 0.9, 4);
  const streamPos = new THREE.Vector3();
  let soundTick = 0;
  let calm = 0;
  const chooseMusic = (dt: number): MusicTrack => {
    const boss = enemies.boss;
    if (boss?.alive && boss.engaged && boss.position.distanceTo(player.position) < 40) return 'boss';
    const fighting = player.alive && enemies.list.some((e) => e.alive && e.engaged && e.position.distanceTo(player.position) < 25);
    // Stay on the battle theme a few seconds after the last enemy falls.
    calm = fighting ? 0 : calm + dt;
    if (calm < 5) return 'battle';
    return Math.hypot(player.position.x - VILLAGE_CENTER.x, player.position.z - VILLAGE_CENTER.y) < VILLAGE_RADIUS + 10 ? 'village' : 'explore';
  };
  calm = 99;

  const lockPos = new THREE.Vector3();
  let last = performance.now();
  const minFrameMs = quality.frameCap ? 1000 / quality.frameCap - 2 : 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // Phones render at 30 fps: skip display refreshes that come too soon.
    if (now - last < minFrameMs) return;
    // Clamp so a background tab doesn't teleport the player on return.
    const realDt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Hit-stop: briefly slow the world when a blow lands, for weight.
    hitStop = Math.max(0, hitStop - realDt);
    const dt = hitStop > 0 ? realDt * 0.08 : realDt;

    input.update(realDt);
    // Modal layers: map, menu, settings. Tab/M/Esc close whichever is on top.
    const closing = input.wasPressed('menu') || input.wasPressed('map') || input.wasPressed('back');
    if (minimap.open) {
      if (closing) minimap.close();
    } else if (ui.menuOpen) {
      if (input.wasPressed('menu') || input.wasPressed('back')) ui.closeMenu();
    } else if (hud.panelOpen) {
      if (closing) hud.closePanel();
    } else if (!ui.dialogOpen) {
      if (input.wasPressed('menu')) ui.toggleMenu();
      else if (input.wasPressed('map')) minimap.show();
    }
    const modal = minimap.open || ui.menuOpen || hud.panelOpen;
    // Mouse players need the pointer captured; until then the game waits behind a gate.
    const needsGate = !input.touch && !input.hasPad && !modal && !ui.dialogOpen && !input.pointerLocked;
    gate.set(needsGate);
    const wantLock = !input.touch && !modal && !ui.dialogOpen;
    if (wantLock && !wantedLock) input.requestLock();
    wantedLock = wantLock;
    const paused = modal || gate.visible;
    if (ui.dialogOpen) {
      if (input.wasPressed('interact') || input.wasPressed('dodge')) ui.advance();
      input.suppress();
    } else if (paused) {
      input.suppress();
    } else {
      if (!state.data.tutorialDone && enemies.list.some((e) => e.alive && e.engaged && e.position.distanceTo(player.position) < 25)) tutorial.start();
      tutorial.update(realDt, player);
    }
    if (talkingTo && !ui.dialogOpen) {
      talkingTo.talking = false;
      talkingTo = null;
    }

    // Of the NPCs and chests in range, prefer what the player faces, then the nearest.
    let near: Npc | null = null;
    let nearChest: Chest | null = null;
    let best = Infinity;
    const fx = Math.sin(player.facing);
    const fz = Math.cos(player.facing);
    const score = (p: THREE.Vector3) => {
      const dx = p.x - player.position.x;
      const dz = p.z - player.position.z;
      const d = Math.hypot(dx, dz);
      const facing = (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5;
      return d + (facing ? 0 : 100);
    };
    for (const n of npcs) {
      if (n.position.distanceTo(player.position) >= INTERACT_RANGE) continue;
      const s = score(n.position);
      if (s < best) [near, best] = [n, s];
    }
    for (const c of world.chests) {
      if (c.position.distanceTo(player.position) >= CHEST_RANGE) continue;
      const s = score(c.position);
      if (s < best) [near, nearChest, best] = [null, c, s];
    }
    const key = input.touch ? '' : input.hasPad && !input.pointerLocked ? '[B] ' : '[F] ';
    const chestEmpty = !!nearChest && (isOpened(nearChest) || chestAnim?.chest === nearChest);
    if (!player.alive) ui.setPrompt(null);
    else if (near) ui.setPrompt(`與 ${NPC_NAMES[near.id]} 交談`, '交談', key);
    else if (nearChest) ui.setPrompt(chestEmpty ? '空的寶箱' : '打開寶箱', '開啟', key, chestEmpty);
    else ui.setPrompt(null);
    if (player.alive && input.wasPressed('interact') && !ui.dialogOpen) {
      if (near) {
        const q = state.quest(questOf[near.id]);
        talkingTo = near;
        near.talking = true;
        ui.openDialog(near.id, dialogFor(near.id, q.state, q.progress));
        input.suppress();
      } else if (nearChest && !chestEmpty) {
        openChest(nearChest);
      }
    }
    if (input.wasPressed('potion')) usePotion();

    const worldDt = paused ? 0 : dt;
    player.update(worldDt, input, cam.yaw, world.colliders, enemies.list, events, vfx);
    enemies.update(worldDt, player, world.colliders, events);
    npcs.forEach((n) => n.update(worldDt, player.position));
    vfx.update(worldDt);
    animateChest(worldDt);
    const lock = player.lockTarget ? player.lockTarget.chest(lockPos) : null;
    cam.update(realDt, input, player.position, player.eyeHeight, world.cameraBlockers, lock);
    world.follow(player.position, realDt);
    vegetation.update(cam.camera);
    grass.update(cam.camera, player.position);
    input.endFrame();

    if (!player.alive) {
      deadTime += realDt;
      if (deadTime > 3.5) {
        deadTime = 0;
        state.addGold(-Math.floor(state.data.gold * 0.1));
        player.revive(VILLAGE_CENTER.x + 4, VILLAGE_CENTER.y - 8);
        cam.snapTo(player.position, player.eyeHeight);
      }
    }
    combatHud.update(player, enemies.list, enemies.boss);
    ui.updateTags(npcs, cam.camera, player.position, questOf);
    minimap.update(realDt, cam.yaw, {
      player: player.position,
      facing: player.facing,
      npcs: npcs.map((n) => ({ position: n.position, mark: questMark(n.id) })),
      enemies: enemies.list.filter((e) => e.alive).map((e) => ({ position: e.position, boss: !!e.def.boss })),
      chests: unopened().map((c) => c.position),
      objective: questObjective(),
    });

    audio.setListener(cam.camera);
    soundTick -= realDt;
    if (soundTick <= 0) {
      soundTick = 0.25;
      // The stream sounds from its nearest point.
      const q = streamQuery(player.position.x, player.position.z);
      stream?.setPosition(streamPos.set(q.x, q.level + 0.2, q.z));
      audio.music(chooseMusic(0.25));
    }

    post.render();
    dynRes.update(dt);
    hud.update(dt, dynRes.scale);
  });
}

/** Dev only: the backquote key toggles wireframes of every collider. */
function bindColliderDebug(scene: THREE.Scene, colliders: ColliderWorld): void {
  let lines: THREE.LineSegments | null = null;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote') return;
    if (!lines) {
      const pts: number[] = [];
      const seg = (ax: number, az: number, bx: number, bz: number) => pts.push(ax, groundAt(ax, az) + 0.3, az, bx, groundAt(bx, bz) + 0.3, bz);
      for (const c of colliders.all()) {
        if (c.kind === 'circle') {
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
            seg(c.x + Math.cos(a) * c.r, c.z + Math.sin(a) * c.r, c.x + Math.cos(b) * c.r, c.z + Math.sin(b) * c.r);
          }
        } else {
          const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
          const corner = (lx: number, lz: number): [number, number] => [c.x + lx * cos + lz * sin, c.z - lx * sin + lz * cos];
          const k = [corner(-c.hw, -c.hd), corner(c.hw, -c.hd), corner(c.hw, c.hd), corner(-c.hw, c.hd)];
          for (let i = 0; i < 4; i++) seg(...k[i], ...k[(i + 1) % 4]);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff2bd6, depthTest: false }));
      lines.renderOrder = 999;
      lines.frustumCulled = false;
      lines.visible = false;
      scene.add(lines);
    }
    lines.visible = !lines.visible;
  });
}

main().catch((err) => {
  console.error(err);
  showError(`${t('error.renderer')}\n${String(err)}`);
});
