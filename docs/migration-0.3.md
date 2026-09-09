# Migrating from 0.2.x to 0.3.x

Version 0.3 updates the rendering dependency to Gaussian Splat Lite 1.0 and
adds support for Three.js `WebGPURenderer`. The `GaussianSplatPlugin`
constructor and tile format requirements are unchanged. Existing supported
SPZ-compressed glTF/GLB tiles do not need to be converted again.

## Update dependencies

```bash
npm install 3d-tiles-rendererjs-3dgs-plugin@^0.3.0 gaussian-splat-lite@^1.0.0 three@^0.186.0 3d-tiles-renderer@^0.5.0
```

The minimum Three.js version is now `0.186.0`. GSL `0.1.x` is outside the
supported dependency range for this release.

## Choose a renderer

Existing `WebGLRenderer` applications can keep their renderer setup. To use
WebGPU, initialize `WebGPURenderer` before constructing the scene-level Splat
renderer:

```ts
import { WebGPURenderer } from 'three/webgpu';
import { GaussianSplatRenderer } from 'gaussian-splat-lite';

const renderer = new WebGPURenderer({ antialias: false });
await renderer.init();
const splatRenderer = new GaussianSplatRenderer({ renderer });
scene.add(splatRenderer);
```

`WebGPURenderer` supports native WebGPU, automatic WebGL2 fallback, and
`forceWebGL: true`. The application still owns and disposes the Splat renderer.
Native WebGPU requires a compatible browser/GPU and HTTPS or localhost.

For camera resolution, use the overload supported by both renderer types:

```ts
import { Vector2 } from 'three';

const size = new Vector2();
tiles.setCamera(camera);
tiles.setResolution(camera, renderer.getSize(size));
// Repeat after resizing the renderer.
```

This avoids the WebGL-only TypeScript parameter on
`setResolutionFromRenderer` in `3d-tiles-renderer@0.5.0`.

## Review appearance and picking

The plugin inherits renderer and mesh defaults from the installed GSL version.
With GSL 1.0:

| Setting | GSL 1.0 behavior | Upgrade guidance |
| --- | --- | --- |
| `preBlurAmount` / `blurAmount` | Defaults are `0.3` / `0` | Set `0` / `0.3` on `GaussianSplatRenderer` to restore the GSL 0.1 defaults, or retain your application's explicit values. |
| `minPixelRadius` | Measures screen pixels independently of `focalAdjustment` | Divide the previous value by `focalAdjustment` to retain the previous effective cutoff. The numeric default remains `1`. |
| `minRaycastOpacity` | Defaults to `0.15` | Pass an explicit value to `GaussianSplatPlugin` to retain the threshold used by your previous GSL version. Earlier 0.1 releases used `0.05`; GSL 0.1.16 used `0.1`. |

Native WebGPU uses GPU sorting; both WebGL2 paths use asynchronous Worker/WASM
sorting. Small appearance differences between backends are possible, and
equal-depth Splats have no guaranteed source order on native WebGPU.

GSL custom GLSL shaders remain specific to `WebGLRenderer`; they are not
accepted by `WebGPURenderer`, including its WebGL2 backend. See the
[GSL 1.0 release notes](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/releases/tag/v1.0.0)
and [renderer reference](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/v1.0.0/docs/GaussianSplatRenderer.md)
for the complete backend and default changes.

## Tile integration

Explicit and implicit 3D Tiles, GIS/ECEF transforms, `TilesFadePlugin`, tile
disposal, and memory accounting remain supported.
`targetCoverageBoostScale` still defaults to `0.1`.

This plugin continues to load glTF/GLB tile content with
`KHR_gaussian_splatting` and `KHR_gaussian_splatting_compression_spz_2`.
GSL's standalone PLY, SOG, RAD, and streaming scheduler APIs do not add new
3D Tiles payload formats to this plugin.

For applications still using plugin 0.1.x, first apply the
[Spark-to-GSL migration](../migration.md), then the dependency and renderer
changes above.
