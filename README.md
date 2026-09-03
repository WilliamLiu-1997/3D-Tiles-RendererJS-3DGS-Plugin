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

> [!IMPORTANT]
> **Upgrading from 0.1.x to 0.2.x?**
> Follow the [0.1.x to 0.2.x migration guide](migration.md) before updating.

## Requirements

- `three@>=0.185.1`
- `3d-tiles-renderer@^0.5.0`
- `gaussian-splat-lite@^0.1.13`
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
WebXR applications must switch `TilesRenderer` between the normal camera and
Three.js' XR `ArrayCamera` as sessions start and end. See the
[WebXR / VR integration guide](docs/webxr.md) for the complete setup.

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
| `minRaycastOpacity` | Gaussian Splat Lite default (`0.05`) | Per-splat kernel-alpha threshold that clips the raycast hit area. |
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
