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
  const names = ['heroine', 'bandit', 'skeleton', 'knight'] as const;
  const fractions = names.map(() => 0);
  const [heroine, bandit, skeleton, knight] = await Promise.all(
    names.map((n, i) => loadCharacter(`models/${n}.glb`, (f) => {
      fractions[i] = f;
      setProgress(0.4 + (fractions.reduce((a, b) => a + b) / names.length) * 0.5, 'loading.player');
    })),
  );
  setProgress(0.92, 'loading.enemies');
  await nextFrame();
  const enemies = new EnemyManager({ bandit, skeleton, knight });
  world.scene.add(enemies.group);
  const vfx = new Vfx(world.scene);
  const input = new Input(renderer.domElement);
  const player = new Player(heroine);
  // `?spawn=road|camp|ruins` starts elsewhere; handy for testing encounters.
  const spawns: Record<string, [number, number]> = {
    road: [-4, 2], camp: [BANDIT_CAMP.x - 14, BANDIT_CAMP.y], ruins: [RUINS_CENTER.x, RUINS_CENTER.y + 40],
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
  const hud = new Hud(input, quality, choice, backend);
  const combatHud = new CombatHud(cam.camera, input.touch);

  let hitStop = 0;
  const events: CombatEvents = {
    damage: (target, amount, crit, byPlayer) => combatHud.damageNumber(target, amount, crit, byPlayer),
    hitStop: (s) => (hitStop = Math.max(hitStop, s)),
    shake: (s) => (cam.shake = Math.max(cam.shake, s)),
  };
  player.onKill = (enemy) => {
    if (enemy.def.boss) combatHud.showBanner(t('hud.bossDefeated'), 4);
  };
  let deadTime = 0;

  window.addEventListener('resize', () => {
    cam.setAspect(window.innerWidth / window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    dynRes.apply();
  });

  if (import.meta.env.DEV) Object.assign(window, { game: { renderer, world, player, cam, input, enemies } });

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
    player.update(dt, input, cam.yaw, world.colliders, enemies.list, events, vfx);
    enemies.update(dt, player, world.colliders, events);
    vfx.update(dt);
    const lock = player.lockTarget ? player.lockTarget.chest(lockPos) : null;
    cam.update(realDt, input, player.position, player.eyeHeight, world.cameraBlockers, lock);
    world.follow(player.position);
    input.endFrame();

    if (!player.alive) {
      deadTime += realDt;
      if (deadTime > 3.5) {
        deadTime = 0;
        player.revive(VILLAGE_CENTER.x + 4, VILLAGE_CENTER.y - 8);
        cam.snapTo(player.position, player.eyeHeight);
      }
    }
    combatHud.update(player, enemies.list, enemies.boss);

    renderer.render(world.scene, cam.camera);
    dynRes.update(dt);
    hud.update(dt, dynRes.scale);
  });
}

main().catch((err) => {
  console.error(err);
  showError(`${t('error.renderer')}\n${String(err)}`);
});
