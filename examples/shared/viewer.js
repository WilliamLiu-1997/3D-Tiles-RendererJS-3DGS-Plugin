import {
  Color,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  ImplicitTilingPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UnloadTilesPlugin,
  XYZTilesPlugin,
} from '3d-tiles-renderer/plugins';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';
import { CameraController } from './cameraController';

const SATELLITE_IMAGERY = {
  url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  levels: 18,
};

function forceOpaqueMaterial(material) {
  if (!material) return;

  if (Array.isArray(material)) {
    material.forEach(forceOpaqueMaterial);
    return;
  }

  material.transparent = false;
}

function forceOpaqueScene(root) {
  root.traverse((child) => {
    if (child.material) {
      forceOpaqueMaterial(child.material);
    }
  });
}

export function runExample({ tilesets, initial = 0 }) {
  const renderer = new WebGLRenderer({
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    reversedDepthBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0xffffff);

  const camera = new PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    2e7,
  );
  camera.position.set(0, 0, 1.75e7);

  const imageryTiles = new TilesRenderer();
  imageryTiles.registerPlugin(
    new XYZTilesPlugin({
      shape: 'ellipsoid',
      center: true,
      levels: SATELLITE_IMAGERY.levels,
      url: SATELLITE_IMAGERY.url,
    }),
  );
  imageryTiles.registerPlugin(new TilesFadePlugin());
  imageryTiles.registerPlugin(new TileCompressionPlugin());
  imageryTiles.registerPlugin(new UnloadTilesPlugin());
  imageryTiles.setCamera(camera);
  imageryTiles.setResolutionFromRenderer(camera, renderer);
  imageryTiles.addEventListener('load-model', ({ scene: modelScene }) => {
    forceOpaqueScene(modelScene);
  });
  scene.add(imageryTiles.group);

  const controls = new CameraController(renderer, scene, camera);
  controls.setEllipsoid(imageryTiles.ellipsoid);

  const sphere = new Sphere();
  let tiles = null;

  function frameTileset() {
    if (!tiles || !tiles.getBoundingSphere(sphere)) return false;
    const surfaceNormal =
      sphere.center.lengthSq() > 0
        ? sphere.center.clone().normalize()
        : new Vector3(0, 1, 0);
    const cameraPosition = new Vector3()
      .copy(sphere.center)
      .addScaledVector(surfaceNormal, sphere.radius);
    camera.position.copy(cameraPosition);
    camera.up.set(0, 1, 0);
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld();
    return true;
  }

  function loadTileset(url) {
    if (tiles) {
      scene.remove(tiles.group);
      tiles.dispose();
      tiles = null;
    }
    const next = new TilesRenderer(url);
    next.registerPlugin(new TilesFadePlugin());
    next.registerPlugin(new TileCompressionPlugin());
    next.registerPlugin(new UnloadTilesPlugin());
    next.registerPlugin(new ImplicitTilingPlugin());
    next.registerPlugin(new GaussianSplatPlugin({ renderer, scene }));
    next.setCamera(camera);
    next.setResolutionFromRenderer(camera, renderer);
    scene.add(next.group);

    let framed = false;
    next.addEventListener('load-tile-set', () => {
      if (framed) return;
      if (frameTileset()) framed = true;
    });
    tiles = next;
  }

  loadTileset(tilesets[initial].url);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    tiles?.setResolutionFromRenderer(camera, renderer);
    imageryTiles.setResolutionFromRenderer(camera, renderer);
  });

  function frame() {
    controls.update();
    imageryTiles.update();
    tiles?.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();

  return {
    switchTileset(url) {
      loadTileset(url);
    },
    moveToTileset() {
      frameTileset();
    },
  };
}
