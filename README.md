<div align="center">

# 3d-tiles-rendererjs-3dgs-plugin

[![npm version](https://img.shields.io/npm/v/3d-tiles-rendererjs-3dgs-plugin)](https://www.npmjs.com/package/3d-tiles-rendererjs-3dgs-plugin)
[![CI](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/3D-Tiles-RendererJS-3DGS-Plugin.png" alt="3D-Tiles-RendererJS-3DGS-Plugin" width="960" />

</div>

Gaussian splat tile support for
[`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS), rendered
with [`Gaussian Splat Lite`](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite).

The plugin loads glTF/GLB tile payloads that use `KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2`. It supports explicit and implicit
3D Tiles, tile disposal and memory accounting, large GIS/ECEF coordinates, and
`TilesFadePlugin` transitions.

> This package loads tiled Gaussian content, not standalone `.ply` files. Use
> [`3DGS-PLY-3DTiles-Converter`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
> to convert PLY data to 3D Tiles.

## Features

- Explicit and implicit 3D Tiles tiling
- SPZ-compressed Gaussian primitives in glTF and GLB tiles
- `EXT_splat_opacity` v1 and v2
- Tile lifecycle, memory accounting, and fade transitions
- Camera-relative rendering for large GIS/ECEF coordinates

## Requirements

- `three@>=0.185.1`
- `3d-tiles-renderer@^0.5.0`
- `gaussian-splat-lite@^0.1.7`
- A modern browser with WebGL2, WebAssembly, Web Workers, and ES modules

## Installation

```bash
npm install 3d-tiles-rendererjs-3dgs-plugin three 3d-tiles-renderer gaussian-splat-lite
```

## Quick start

```ts
import { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { GaussianSplatRenderer } from 'gaussian-splat-lite';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

const renderer = new WebGLRenderer({ antialias: false });
const scene = new Scene();
const camera = new PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  10000,
);

const tiles = new TilesRenderer('https://example.com/tileset.json');
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
// The application owns one scene-level Gaussian renderer.
const splatRenderer = new GaussianSplatRenderer({ renderer });
scene.add(splatRenderer);
tiles.registerPlugin(new TilesFadePlugin());
tiles.registerPlugin(new GaussianSplatPlugin());

scene.add(tiles.group);

renderer.setAnimationLoop(() => {
  tiles.update();
  renderer.render(scene, camera);
});
```

## WebXR / VR

The Gaussian splat renderer is WebXR-aware when `renderer.xr.isPresenting`.
For a pure WebXR render loop, use the same session-switching pattern as the
upstream
[3D Tiles Renderer VR example](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/example/three/vr.js):
register the normal camera outside XR, switch `TilesRenderer` to Three.js' XR
`ArrayCamera` when an XR session starts, and switch back when the session ends.

```js
import { Scheduler } from '3d-tiles-renderer';
import { VRButton } from 'three/addons/webxr/VRButton.js';

tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);

renderer.xr.enabled = true;
document.body.appendChild(VRButton.createButton(renderer));

let xrSession = null;

function clearTilesCameras() {
  for (const registeredCamera of [...tiles.cameras]) {
    tiles.deleteCamera(registeredCamera);
  }
}

function syncTilesCameraForXR() {
  if (renderer.xr.isPresenting) {
    camera.updateMatrixWorld();
    renderer.xr.updateCamera(camera);

    const xrCamera = renderer.xr.getCamera();

    if (xrSession === null) {
      clearTilesCameras();
      tiles.setCamera(xrCamera);

      xrSession = renderer.xr.getSession();
      Scheduler.setXRSession(xrSession);
    }

    const firstViewCamera = xrCamera.cameras[0];
    if (firstViewCamera) {
      tiles.setResolution(
        xrCamera,
        firstViewCamera.viewport.z,
        firstViewCamera.viewport.w,
      );
    }
  } else if (xrSession !== null) {
    clearTilesCameras();
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    xrSession = null;
    Scheduler.setXRSession(null);
  }
}

renderer.setAnimationLoop(() => {
  syncTilesCameraForXR();
  tiles.update();
  renderer.render(scene, camera);
});
```

The important ordering is `camera.updateMatrixWorld()` before
`renderer.xr.updateCamera(camera)`, and `syncTilesCameraForXR()` before
`tiles.update()`. That makes tile visibility and LOD use the headset camera
during XR. Re-run `tiles.setResolutionFromRenderer(camera, renderer)` from your
resize handler when the canvas size changes. For AR placement and hit testing,
use an AR-specific flow such as the
[Three.js AR hit-test example](https://threejs.org/examples/#webxr_ar_hittest)
in addition to this 3D Tiles camera/session pattern. AR applications still need
application-level reference-space alignment, anchors, real-world depth, and
occlusion handling.

## Gaussian Splat Lite renderer

`GaussianSplatPlugin` does not create, configure, or dispose a
`GaussianSplatRenderer`. Create one, retain its reference, and add it directly
to the scene before rendering:

```ts
const gaussianSplatRenderer = new GaussianSplatRenderer({
  renderer,
  focalAdjustment: 2,
  blurAmount: 0.15,
});
scene.add(gaussianSplatRenderer);

tiles.registerPlugin(new GaussianSplatPlugin());
```

The plugin does not validate that the renderer exists. Without one, tile
`SplatMesh` instances still load but are not drawn. Pass render settings such as
`blurAmount`, `focalAdjustment`, `depthTest`, and `depthWrite` directly to
Gaussian Splat Lite, not to this plugin.

For the complete list of options, defaults, runtime properties, and on-demand
rendering setup, see the
[`GaussianSplatRenderer` settings page](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/main/docs/GaussianSplatRenderer.md).

## Rendering with a globe

When compositing Gaussian splats with an ellipsoid globe or imagery tiles, keep
the globe in the opaque render path whenever possible.

Gaussian splats are transparent, depth-tested geometry. If the globe is also
transparent, both systems enter Three.js' object-sorted transparent queue. Near
the horizon, the globe may then occlude an entire splat set at once.

To avoid that artifact, keep globe materials in the opaque pass with
`transparent = false` and `depthWrite = true` whenever possible.

For example, the demo forces each imagery tile back into the opaque pass when
it loads:

```ts
const imageryOverlay = new XYZTilesOverlay({
  levels: 18,
  url: '...',
});

const imageryTiles = new TilesRenderer();
imageryTiles.registerPlugin(
  new GeneratedSurfacePlugin({
    overlay: imageryOverlay,
    shape: 'ellipsoid',
    center: true,
    applyOverlayTexture: true,
  }),
);

imageryTiles.addEventListener('load-model', ({ scene: modelScene }) => {
  modelScene.traverse((child) => {
    if (!child.material) return;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const material of materials) {
      material.transparent = false;
    }
  });
});
```

## Supported content

A tile is handled when:

- The tile content is `gltf` or `glb`
- The glTF scene contains `KHR_gaussian_splatting`
- Each Gaussian primitive uses `KHR_gaussian_splatting_compression_spz_2`

Raw, uncompressed Gaussian primitives and other compression schemes are not
supported. Tiles may also use `EXT_splat_opacity` v1 or v2; see
[`EXT_splat_opacity.md`](EXT_splat_opacity.md) for its binary layout, processing
rules, and fallback behavior.

## API

```ts
new GaussianSplatPlugin({
  minRaycastOpacity: 0.05,
  targetCoverageBoostScale: 0.1,
});
```

| Option | Default | Description |
| --- | --- | --- |
| `minRaycastOpacity` | Gaussian Splat Lite default | Minimum opacity used when raycasting a splat mesh. |
| `targetCoverageBoostScale` | `0.1` | Maximum converter coverage boost retained for `EXT_splat_opacity` v2. Use `0` to remove it. |

Public exports:

```ts
import {
  GaussianSplatPlugin,
  type GaussianSplatPluginOptions,
} from '3d-tiles-rendererjs-3dgs-plugin';
```

## Example and development

The [`examples/`](examples/) demo includes explicit and implicit sample
tilesets, a globe, tileset switching, and LOD controls. Development requires
Node.js 20.9 or newer.

The sample data in [`data/`](data/) was converted from PLY-format 3D Gaussian
Splatting files with
[`3DGS-PLY-3DTiles-Converter`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter).

```bash
npm install
npm start               # Run the demo with Vite
npm run check           # Type-check the package
npm run build           # Build the npm package
npm run build-examples  # Build the static demo
```

## License

Apache-2.0
