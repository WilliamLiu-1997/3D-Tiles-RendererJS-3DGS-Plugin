<div align="center">

# 3d-tiles-rendererjs-3dgs-plugin

[![npm version](https://img.shields.io/npm/v/3d-tiles-rendererjs-3dgs-plugin)](https://www.npmjs.com/package/3d-tiles-rendererjs-3dgs-plugin)
[![CI](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/3D-Tiles-RendererJS-3DGS-Plugin.png" alt="3D-Tiles-RendererJS-3DGS-Plugin" width="960" />

</div>

`3d-tiles-rendererjs-3dgs-plugin` adds Gaussian splat tile support to
[`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS) by
parsing glTF / GLB tile payloads that use `KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2`, then rendering them through
[`gaussian-splat-lite`](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite).

This plugin loads 3D Tiles content; it does not load raw `.ply` splat files
directly. To generate 3D tiles from PLY-format 3D Gaussian Splatting
data, use
[`3DGS-PLY-3DTiles-Converter`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter).

The package is designed for `three.js` applications that already use
`TilesRenderer` and want streamed Gaussian splat content to behave like normal
tile content, including tile disposal, byte accounting, and fade plugin
compatibility.

## Features

- Supports both explicit and implicit 3D Tiles tiling schemes
- Supports `gltf` and `glb` tile payloads containing compressed Gaussian splats
- Builds `SplatMesh` instances from SPZ-compressed primitive data
- Supports legacy v1 and converter v2 `EXT_splat_opacity` payloads
- Shares one Gaussian Splat Lite renderer per scene / WebGLRenderer pair
- Accepts `gaussianSplatRendererOptions` to forward a supported subset of its `GaussianSplatRenderer` settings
- Uses Gaussian Splat Lite's automatic camera-relative coordinate handling to
  reduce large-world precision issues
- Tracks extra GPU / buffer memory through `calculateBytesUsed`
- Uses complementary screen-space coverage for `TilesFadePlugin` transitions
  without scaling the source Gaussian opacity

## Requirements

The package peer dependency ranges are:

- `three@>=0.185.0`
- `3d-tiles-renderer@^0.5.0`
- `gaussian-splat-lite@^0.1.3`

The browser must support fixed-width WebAssembly SIMD. Version 2 opacity
retargeting uses an embedded WASM module with no JavaScript execution fallback;
it does not fetch a separate `.wasm` asset at runtime. If the host page uses a
Content Security Policy, its effective `script-src` must permit WebAssembly
compilation, normally with `'wasm-unsafe-eval'`.

## Installation

```bash
npm install 3d-tiles-rendererjs-3dgs-plugin three 3d-tiles-renderer gaussian-splat-lite
```

## Usage

```ts
import { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { TilesFadePlugin } from '3d-tiles-renderer/plugins';
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
tiles.registerPlugin(new TilesFadePlugin());
tiles.registerPlugin(
  new GaussianSplatPlugin({
    renderer,
    scene,
    minRaycastOpacity: 0.05,
    // Optional: maximum converter coverage boost retained by v2 content.
    targetCoverageBoostScale: 0.1,
    gaussianSplatRendererOptions: {
      focalAdjustment: 2,
    },
  }),
);

scene.add(tiles.group);

function frame() {
  tiles.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

frame();
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

## Gaussian Splat Lite Renderer Options

`GaussianSplatPlugin` accepts an optional `gaussianSplatRendererOptions` object on the
constructor host:

```ts
new GaussianSplatPlugin({
  renderer,
  scene,
  gaussianSplatRendererOptions: {
    focalAdjustment: 2,
    blurAmount: 0.15,
  },
});
```

Supported keys are `premultipliedAlpha`, `autoUpdate`, `preUpdate`,
`maxStdDev`, `minPixelRadius`, `maxPixelRadius`, `minAlpha`, `enable2DGS`,
`preBlurAmount`, `blurAmount`, `clipXY`, `focalAdjustment`, `sortRadial`,
`minSortIntervalMs`, `depthTest`, and `depthWrite`.

Unspecified options use Gaussian Splat Lite defaults.

Because one Gaussian Splat Lite renderer is shared per `scene` / `WebGLRenderer` pair,
explicit `gaussianSplatRendererOptions` from later `GaussianSplatPlugin` instances are
merged into that existing shared renderer. Omitted keys do not reset previously
applied values, and changed explicit values log a warning so shared-state
updates remain visible.

To update options on an existing shared Gaussian Splat Lite renderer at runtime, call
`updateSharedGaussianSplatRendererOptions` with the scene and options:

```ts
import { updateSharedGaussianSplatRendererOptions } from '3d-tiles-rendererjs-3dgs-plugin';

updateSharedGaussianSplatRendererOptions(scene, {
  blurAmount: 0.2,
});
```

Omitted keys keep their current values.

## Rendering Note

When compositing Gaussian splats with an ellipsoid globe or imagery tiles, keep
the globe in the opaque render path whenever possible.

Gaussian Splat Lite splats render as transparent, depth-tested geometry. If the globe is also
rendered as transparent tile meshes, then both systems end up in Three.js'
transparent queue, where sorting is primarily object-level instead of
per-pixel. At grazing / horizon views this can make the globe appear to occlude
an entire splat set at once.

To avoid that artifact:

- Prefer globe materials with `transparent = false` and `depthWrite = true`
- Or use separate render passes for the globe and splats if the globe must stay transparent

Using a separate render pass for the splats is also a valid approach when you
need to keep the globe in a transparent pipeline.

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

If you prefer explicit pass ordering instead, split the globe and splats into
different scenes and render them sequentially without clearing depth between
passes:

```ts
const globeScene = new Scene();
const splatScene = new Scene();

const imageryTiles = new TilesRenderer(
  'https://example.com/imagery/tileset.json',
);
imageryTiles.setCamera(camera);
imageryTiles.setResolutionFromRenderer(camera, renderer);

const imageryOverlay = new XYZTilesOverlay({
  levels: 18,
  url: '...',
});
imageryTiles.registerPlugin(
  new GeneratedSurfacePlugin({
    overlay: imageryOverlay,
    shape: 'ellipsoid',
    center: true,
    applyOverlayTexture: true,
  }),
);
globeScene.add(imageryTiles.group);

const splatTiles = new TilesRenderer('https://example.com/splats/tileset.json');
splatTiles.setCamera(camera);
splatTiles.setResolutionFromRenderer(camera, renderer);
splatTiles.registerPlugin(new TilesFadePlugin());
splatTiles.registerPlugin(
  new GaussianSplatPlugin({ renderer, scene: splatScene }),
);
splatScene.add(splatTiles.group);

renderer.autoClear = false;

function frame() {
  imageryTiles.update();
  splatTiles.update();

  renderer.clear();
  renderer.render(globeScene, camera);
  renderer.render(splatScene, camera);

  requestAnimationFrame(frame);
}

frame();
```

This keeps the globe and splats out of the same transparent sort queue while
still letting the globe depth buffer occlude splats behind the horizon.

## Supported Content

This plugin supports both explicit and implicit tiling tilesets, but it only
intercepts tile payloads when all of the following are true:

- The tile content is `gltf` or `glb`
- The glTF scene contains `KHR_gaussian_splatting`
- Each Gaussian primitive uses `KHR_gaussian_splatting_compression_spz_2`

`KHR_gaussian_splatting_compression_spz_2` is the only supported Gaussian
compression path at the moment. Raw, uncompressed Gaussian primitives and other
compression schemes are rejected intentionally.

Tiles may also include the draft `EXT_splat_opacity` extension:

- Legacy v1 supplies display-ready Gaussian Splat Lite opacity in a `FLOAT / SCALAR`
  accessor.
- Version 2 supplies binary16 source opacity, the pre-boost shape ratio, and
  the converter's `opacity_anisotropic_v1` coverage strength. The plugin uses
  this metadata to reduce the converter boost to at most the configured
  `targetCoverageBoostScale` (default `0.1`), compensates opacity for the
  retained two-axis area growth, then writes the result using Gaussian Splat Lite's native
  high-opacity encoding. This processing applies only when the extension's
  source opacity is greater than `1`; other splats retain their SPZ-decoded
  scale and opacity.

Converter-authored v2 data is interleaved in the existing GLB buffer. The plugin
reads it without another request, payload copy, or deinterleave, then applies it
in one pass before Gaussian Splat Lite creates its textures. Unknown metadata and malformed or
unavailable accessors leave the complete decoded SPZ opacity and boosted scales
unchanged. An invalid individual value leaves only that splat at the same SPZ
fallback. See [`EXT_splat_opacity.md`](EXT_splat_opacity.md) for the complete
binary layout, restoration formula, and fallback contract.

Opacity retargeting runs directly on the decoded splat arrays in one in-place
pass without copying them.

## API

### `new GaussianSplatPlugin(host)`

Creates a tile parser plugin.

`host` must contain:

- `renderer: WebGLRenderer`
- `scene: Scene`
- `minRaycastOpacity?: number`
- `gaussianSplatRendererOptions?: supported Gaussian Splat Lite renderer option subset`
- `targetCoverageBoostScale?: number`

`minRaycastOpacity` is forwarded to each Gaussian Splat Lite `SplatMesh` created by the
plugin. It defaults to `0.05`.

`targetCoverageBoostScale` is the maximum converter coverage boost retained
when reading `EXT_splat_opacity` version 2. It defaults to `0.1`; use `0` to
remove the recorded boost completely. A file whose recorded boost is lower
than the configured target is left at that lower value rather than boosted.

The same `scene` and `renderer` pair must stay in a strict 1:1:1 relationship
with the shared Gaussian Splat Lite renderer manager used by the plugin. If multiple plugin
instances reuse that pair, they also reuse the same Gaussian Splat Lite renderer and merge
their explicit `gaussianSplatRendererOptions` into it.

### `isGaussianSplat(object)`

Type guard for Gaussian Splat Lite `SplatMesh` nodes created by this plugin.

### `isGaussianSplatScene(object)`

Type guard for the `Group` wrapper that owns one parsed Gaussian tile scene.

### `getGaussianSplatRendererForScene(scene)`

Returns the shared Gaussian Splat Lite renderer currently attached to a scene, or `null` if
the plugin has not initialized one for that scene or it has already been
disposed. The returned renderer is owned by the plugin.

### `updateSharedGaussianSplatRendererOptions(scene, options)`

Applies explicit supported `gaussianSplatRendererOptions` to the existing shared Gaussian Splat Lite
renderer for `scene`. This is intended for runtime UI controls or other
configuration changes after the plugin has initialized. It does nothing if no
shared renderer exists for the scene.

## Public Exports

```ts
import {
  GaussianSplatPlugin,
  getGaussianSplatRendererForScene,
  isGaussianSplat,
  isGaussianSplatScene,
  updateSharedGaussianSplatRendererOptions,
} from '3d-tiles-rendererjs-3dgs-plugin';
```

## Development

Development and release checks require Node.js 20.9 or newer and a Rust
toolchain.

```bash
npm install
npm run build:wasm
npm run check
npm run build
```

Building the embedded opacity module requires a Rust toolchain. The build script
installs the `wasm32-unknown-unknown` target through `rustup` when needed. The
generated `src/opacity_retarget.wasm` is a local build input and is not committed
or published as a separate package file.

## Examples

Two sample tilesets live under [data/](data/) — `gaussianSplat1`
and `gaussianSplat2`. Both are wired into a single demo page
at [examples/index.html](examples/index.html) that uses
[`lil-gui`](https://lil-gui.georgealways.com/) to switch between them at runtime
and to recentre the camera on the current tileset.

The sample data in [data/](data/) was converted from PLY-format 3D Gaussian
Splatting files with
[`3DGS-PLY-3DTiles-Converter`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter).

The page composes the splat tileset on top of an ArcGIS World Imagery globe
served through `GeneratedSurfacePlugin` and `XYZTilesOverlay` so the Gaussian
content sits in a real ECEF frame. A custom `CameraController` ([examples/shared/cameraController.js](examples/shared/cameraController.js))
drives orbit / pan / zoom using raycasts against the scene and the WGS84
ellipsoid, with inertial damping.

Controls:

- Left-drag: orbit
- Right-drag (or Shift + left-drag): pan
- Scroll: zoom
- GUI `Tileset` dropdown: swap the active tileset
- GUI `Error target` slider: adjust level of detail on a logarithmic 4–64 scale
- GUI `Move to tileset` button: frame the camera on the current tileset

```bash
npm start               # dev server with HMR, opens examples/index.html
npm run build-examples  # bundle the demo to examples/bundle/
```

`build-examples` emits a self-contained static site (HTML + JS + the two
datasets) in `examples/bundle/`. Serve that directory with any static file
server to view the demo.

## License

Apache-2.0
