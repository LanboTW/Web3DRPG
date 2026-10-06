import './style.css';
import { applyI18n, t } from './i18n';
import { loadChoice, resolveQuality } from './engine/quality';
import { backendName, createRenderer, DynamicResolution, webGPUAvailable } from './engine/renderer';
import { Input } from './input/input';
import { createWorld } from './game/world';
import { Player } from './game/player';
import { ThirdPersonCamera } from './game/camera';
import { VILLAGE_CENTER } from './game/terrain';
import { hideLoading, nextFrame, setProgress, showError } from './ui/loading';
import { Hud } from './ui/hud';

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
  console.info(`world built in ${Math.round(performance.now() - t0)} ms`);

  setProgress(0.75, 'loading.player');
  await nextFrame();
  const input = new Input(renderer.domElement);
  const player = new Player();
  player.spawn(VILLAGE_CENTER.x + 4, VILLAGE_CENTER.y - 8);
  world.scene.add(player.root);
  const cam = new ThirdPersonCamera(window.innerWidth / window.innerHeight, cameraFar);
  cam.yaw = player.facing + Math.PI;
  cam.snapTo(player.position, player.eyeHeight);

  // Compile shaders before revealing the scene to avoid first-frame hitches.
  await renderer.compileAsync(world.scene, cam.camera);

  const dynRes = new DynamicResolution(renderer, quality);
  const hud = new Hud(input, quality, choice, backend);

  window.addEventListener('resize', () => {
    cam.setAspect(window.innerWidth / window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    dynRes.apply();
  });

  if (import.meta.env.DEV) Object.assign(window, { game: { renderer, world, player, cam, input } });

  setProgress(1, 'loading.ready');
  hideLoading();

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // Clamp so a background tab doesn't teleport the player on return.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    input.update(dt);
    player.update(dt, input, cam.yaw, world.colliders);
    cam.update(dt, input, player.position, player.eyeHeight, world.cameraBlockers);
    world.follow(player.position);
    input.endFrame();

    renderer.render(world.scene, cam.camera);
    dynRes.update(dt);
    hud.update(dt, dynRes.scale);
  });
}

main().catch((err) => {
  console.error(err);
  showError(`${t('error.renderer')}\n${String(err)}`);
});
