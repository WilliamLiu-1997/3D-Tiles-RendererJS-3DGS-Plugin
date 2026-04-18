<div align="center">

# 3d-tiles-rendererjs-3dgs-plugin

[![npm version](https://img.shields.io/npm/v/3d-tiles-rendererjs-3dgs-plugin)](https://www.npmjs.com/package/3d-tiles-rendererjs-3dgs-plugin)
[![CI](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin/main/3D-Tiles-RendererJS-3DGS-Plugin.png" alt="3D-Tiles-RendererJS-3DGS-Plugin" width="960" />

</div>

`3d-tiles-rendererjs-3dgs-plugin` adds Gaussian splat tile support to
[`3d-tiles-renderer`](https://www.npmjs.com/package/3d-tiles-renderer) by
parsing glTF / GLB tile payloads that use `KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2`, then rendering them through
[`@sparkjsdev/spark`](https://www.npmjs.com/package/@sparkjsdev/spark).

The package is designed for `three.js` applications that already use
`TilesRenderer` and want streamed Gaussian splat content to behave like normal
tile content, including tile disposal, byte accounting, and fade plugin
compatibility.

## Features

- Supports both explicit and implicit 3D Tiles tiling schemes
- Supports `gltf` and `glb` tile payloads containing compressed Gaussian splats
- Builds `SplatMesh` instances from SPZ-compressed primitive data
- Shares one Spark renderer per scene / WebGLRenderer pair
- Re-bases splat rendering around the active camera to reduce large-world
  precision issues
- Tracks extra GPU / buffer memory through `calculateBytesUsed`
- Preserves opacity updates from tile fade transitions

## Requirements

As of April 17, 2026, Spark `2.0.0` declares a peer dependency on
`three@^0.180.0`, so this package currently targets the same `three` major
range.

- `three@^0.180.0`
- `3d-tiles-renderer@^0.4.24`
- `@sparkjsdev/spark@^2.0.0`

## Installation

```bash
npm install 3d-tiles-rendererjs-3dgs-plugin three 3d-tiles-renderer @sparkjsdev/spark
```

## Usage

```ts
import { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

const renderer = new WebGLRenderer({ antialias: true });
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
tiles.registerPlugin(new GaussianSplatPlugin({ renderer, scene }));

scene.add(tiles.group);

function frame() {
  tiles.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

frame();
```

## Rendering Note

When compositing Gaussian splats with an ellipsoid globe or imagery tiles, keep
the globe in the opaque render path whenever possible.

Spark splats render as transparent, depth-tested geometry. If the globe is also
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
const imageryTiles = new TilesRenderer();
imageryTiles.registerPlugin(
  new XYZTilesPlugin({
    shape: 'ellipsoid',
    center: true,
    levels: 18,
    url: '...',
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
imageryTiles.registerPlugin(
  new XYZTilesPlugin({
    shape: 'ellipsoid',
    center: true,
    levels: 18,
    url: '...',
  }),
);
globeScene.add(imageryTiles.group);

const splatTiles = new TilesRenderer('https://example.com/splats/tileset.json');
splatTiles.setCamera(camera);
splatTiles.setResolutionFromRenderer(camera, renderer);
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

## API

### `new GaussianSplatPlugin(host)`

Creates a tile parser plugin.

`host` must contain:

- `renderer: WebGLRenderer`
- `scene: Scene`

The same `scene` and `renderer` pair must stay in a strict 1:1:1 relationship
with the shared Spark renderer manager used by the plugin.

### `isGaussianSplat(object)`

Type guard for Spark `SplatMesh` nodes created by this plugin.

### `isGaussianSplatScene(object)`

Type guard for the `Group` wrapper that owns one parsed Gaussian tile scene.

## Public Exports

```ts
import {
  GaussianSplatPlugin,
  isGaussianSplat,
  isGaussianSplatScene,
} from '3d-tiles-rendererjs-3dgs-plugin';
```

## Development

```bash
npm install
npm run check
npm run build
```

## Examples

Two sample tilesets live under [data/](data/) — `gaussianSplat` (implicit tiling)
and `gaussianSplat1` (explicit tiling). Both are wired into a single demo page
at [examples/index.html](examples/index.html) that uses
[`lil-gui`](https://lil-gui.georgealways.com/) to switch between them at runtime
and to recentre the camera on the current tileset.

The sample data in [data/](data/) was converted from PLY-format 3D Gaussian
Splatting files with
[`3DGS-PLY-3DTiles-Converter`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter).

The page composes the splat tileset on top of an ArcGIS World Imagery globe
served through `XYZTilesPlugin` so the Gaussian content sits in a real ECEF
frame. A custom `CameraController` ([examples/shared/cameraController.js](examples/shared/cameraController.js))
drives orbit / pan / zoom using raycasts against the scene and the WGS84
ellipsoid, with inertial damping.

Controls:

- Left-drag: orbit
- Right-drag (or Shift + left-drag): pan
- Scroll: zoom
- GUI `Tileset` dropdown: swap the active tileset
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
