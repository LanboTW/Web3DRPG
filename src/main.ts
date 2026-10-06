import './style.css';
import * as THREE from 'three/webgpu';
import { applyI18n, t } from './i18n';
import { loadChoice, resolveQuality } from './engine/quality';
import { backendName, createRenderer, DynamicResolution, webGPUAvailable } from './engine/renderer';
import { Input } from './input/input';
import { createEnvironment, createWorld } from './game/world';
import { Player } from './game/player';
import { loadCharacter } from './game/character';
import { ThirdPersonCamera } from './game/camera';
import { BANDIT_CAMP, RUINS_CENTER, VILLAGE_CENTER } from './game/terrain';
import { hideLoading, nextFrame, setProgress, showError } from './ui/loading';
import { Hud } from './ui/hud';
import { CombatHud } from './ui/combatHud';
import { EnemyManager } from './game/enemies';
import { Vfx } from './game/vfx';
import type { CombatEvents } from './game/combat';
import { Npc, INTERACT_RANGE } from './game/npc';
import { GameState } from './rpg/state';
import { ITEMS } from './rpg/items';
import { QUESTS, dialogFor, type NpcId } from './rpg/quests';
import { RpgUi } from './ui/rpgUi';

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
  const world = createWorld(quality, cameraFar);
  world.scene.environment = await createEnvironment(renderer);
  world.scene.environmentIntensity = 0.8;
  console.info(`world built in ${Math.round(performance.now() - t0)} ms`);

  setProgress(0.4, 'loading.player');
  // Load all character models in parallel; progress is the average.
  const names = ['heroine', 'bandit', 'skeleton', 'knight', 'chief', 'merchant', 'hunter'] as const;
  const fractions = names.map(() => 0);
  const [heroine, bandit, skeleton, knight, chiefModel, merchantModel, hunterModel] = await Promise.all(
    names.map((n, i) => loadCharacter(`models/${n}.glb`, (f) => {
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
  const applyGear = () => {
    player.setStats(state.stats());
    player.setLook(ITEMS[state.data.equipped.weapon], ITEMS[state.data.equipped.armor]);
  };
  applyGear();
  player.hp = player.stats.maxHp;
  let gearKey = '';
  state.onChange(() => {
    const key = `${state.data.equipped.weapon}|${state.data.equipped.armor}|${state.data.level}|${JSON.stringify(state.data.attrs)}`;
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
  cam.yaw = player.facing + Math.PI;
  cam.snapTo(player.position, player.eyeHeight);

  // Compile shaders before revealing the scene to avoid first-frame hitches.
  await renderer.compileAsync(world.scene, cam.camera);

  const dynRes = new DynamicResolution(renderer, quality);
  const hud = new Hud(input, quality, choice, backend, state);
  const combatHud = new CombatHud(cam.camera, input.touch);
  const ui = new RpgUi(state);

  const usePotion = (id?: string) => {
    const missing = player.stats.maxHp - player.hp;
    const pick = id ?? (missing > 100 && state.data.inventory.hi_potion ? 'hi_potion' : state.data.inventory.potion ? 'potion' : 'hi_potion');
    if (!player.alive || missing <= 0 || !state.removeItem(pick)) return;
    player.heal(ITEMS[pick].heal ?? 0);
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
    }
  };
  let deadTime = 0;

  window.addEventListener('resize', () => {
    cam.setAspect(window.innerWidth / window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    dynRes.apply();
  });

  if (import.meta.env.DEV) Object.assign(window, { game: { renderer, world, player, cam, input, enemies, state, QUESTS } });

  setProgress(1, 'loading.ready');
  hideLoading();

  const lockPos = new THREE.Vector3();
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // Clamp so a background tab doesn't teleport the player on return.
    const realDt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Hit-stop: briefly slow the world when a blow lands, for weight.
    hitStop = Math.max(0, hitStop - realDt);
    const dt = hitStop > 0 ? realDt * 0.08 : realDt;

    input.update(realDt);
    if (input.wasPressed('menu') && !ui.dialogOpen) ui.toggleMenu();
    const paused = ui.menuOpen;
    if (ui.dialogOpen) {
      if (input.wasPressed('interact') || input.wasPressed('attack')) ui.advance();
      input.suppress();
    } else if (paused) {
      input.suppress();
    }
    if (talkingTo && !ui.dialogOpen) {
      talkingTo.talking = false;
      talkingTo = null;
    }

    // Nearest NPC in range offers a conversation.
    let near: Npc | null = null;
    for (const n of npcs) {
      if (n.position.distanceTo(player.position) < INTERACT_RANGE && (!near || n.position.distanceTo(player.position) < near.position.distanceTo(player.position))) near = n;
    }
    ui.setPrompt(near && player.alive ? near.id : null);
    if (near && input.wasPressed('interact') && !ui.dialogOpen) {
      const q = state.quest(questOf[near.id]);
      talkingTo = near;
      near.talking = true;
      ui.openDialog(near.id, dialogFor(near.id, q.state, q.progress));
      input.suppress();
    }
    if (input.wasPressed('potion')) usePotion();

    const worldDt = paused ? 0 : dt;
    player.update(worldDt, input, cam.yaw, world.colliders, enemies.list, events, vfx);
    enemies.update(worldDt, player, world.colliders, events);
    npcs.forEach((n) => n.update(worldDt, player.position));
    vfx.update(worldDt);
    const lock = player.lockTarget ? player.lockTarget.chest(lockPos) : null;
    cam.update(realDt, input, player.position, player.eyeHeight, world.cameraBlockers, lock);
    world.follow(player.position);
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

    renderer.render(world.scene, cam.camera);
    dynRes.update(dt);
    hud.update(dt, dynRes.scale);
  });
}

main().catch((err) => {
  console.error(err);
  showError(`${t('error.renderer')}\n${String(err)}`);
});
