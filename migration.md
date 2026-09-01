# Migrating from 0.1.x to 0.2.x

Version 0.2 replaces the Spark rendering backend with
[`gaussian-splat-lite`](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite)
and makes the application responsible for the scene-level Gaussian renderer.
Existing supported 3D Tiles content, including `EXT_splat_opacity` v1 and v2,
does not need to be converted again.

## Why Gaussian Splat Lite

Gaussian Splat Lite provides camera-relative rendering for large GIS/ECEF
coordinates directly in the renderer. The plugin no longer needs to patch or
rebase renderer state to work around floating-point precision loss. This
removes backend-specific integration code and substantially improves display
precision in large-coordinate scenes.

The new backend also provides:

- Similar CPU and GPU memory usage
- Faster splat sorting
- Faster and more accurate raycasting

These improvements are provided by Gaussian Splat Lite itself, while the
plugin remains focused on loading Gaussian content from 3D Tiles and managing
its tile lifecycle.

## Migration checklist

1. Replace `@sparkjsdev/spark` with `gaussian-splat-lite`.
2. Update Three.js to `0.185.1` or newer.
3. Create one `GaussianSplatRenderer`, retain it, and add it to the scene.
4. Remove `renderer`, `scene`, and `sparkRendererOptions` from the
   `GaussianSplatPlugin` constructor.
5. Move renderer settings to the `GaussianSplatRenderer` constructor.
6. Retune `minRaycastOpacity` if the application raycasts splats.
7. Dispose the application-owned renderer when the scene is permanently torn
   down.

Node.js 20.9 or newer is required when installing or developing the package.

## Update dependencies

If Spark was installed only for this plugin, remove it and install the new
backend:

```bash
npm uninstall @sparkjsdev/spark
npm install 3d-tiles-rendererjs-3dgs-plugin@^0.2.0 gaussian-splat-lite@^0.1.7 three@^0.185.1 3d-tiles-renderer@^0.5.0
```

If the application uses Spark for unrelated content, it can remain installed,
but 0.2.x no longer imports it or manages its renderer.

## Update renderer setup

In 0.1.x, the plugin created and shared a Spark renderer from the `renderer`
and `scene` passed to its constructor:

```ts
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

tiles.registerPlugin(
  new GaussianSplatPlugin({
    renderer,
    scene,
    minRaycastOpacity: 0.1,
    targetCoverageBoostScale: 0.1,
    sparkRendererOptions: {
      focalAdjustment: 2,
      blurAmount: 0.15,
      depthTest: true,
      depthWrite: false,
    },
  }),
);
```

In 0.2.x, create the renderer explicitly and pass only tile-specific options
to the plugin:

```ts
import { GaussianSplatRenderer } from 'gaussian-splat-lite';
import { GaussianSplatPlugin } from '3d-tiles-rendererjs-3dgs-plugin';

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  focalAdjustment: 2,
  blurAmount: 0.15,
  depthTest: true,
  depthWrite: false,
});
scene.add(splatRenderer);

tiles.registerPlugin(
  new GaussianSplatPlugin({
    minRaycastOpacity: 0.1,
    targetCoverageBoostScale: 0.1,
  }),
);
```

The `GaussianSplatRenderer` must be in the scene that contains `tiles.group`.
The plugin does not check for it: tiles can load successfully but remain
invisible if the renderer is missing from the rendered scene.

Use one scene-level `GaussianSplatRenderer` for all Gaussian tile sets in the
same scene. When switching tile sets, dispose the old `TilesRenderer` as usual
and keep the scene-level renderer for the replacement tile set.

## Move renderer options

All settings previously accepted in `sparkRendererOptions` are available on
`GaussianSplatRendererOptions` with the same names:

- `premultipliedAlpha`
- `maxStdDev`, `minPixelRadius`, `maxPixelRadius`, and `minAlpha`
- `preBlurAmount`, `blurAmount`, and `clipXY`
- `focalAdjustment`, `sortRadial`, and `minSortIntervalMs`
- `depthTest` and `depthWrite`

Pass them directly to `new GaussianSplatRenderer(...)`. Gaussian Splat Lite
also provides additional options such as `onDirty`, `autoUpdate`,
`transparent`, custom shaders, and offscreen targets. See its
[`GaussianSplatRenderer` settings](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/main/docs/GaussianSplatRenderer.md)
for the current option and runtime-property reference.

Runtime updates no longer go through the plugin:

```ts
// 0.1.x
updateSharedSparkRendererOptions(scene, {
  blurAmount: 0.2,
  depthWrite: true,
});

// 0.2.x
splatRenderer.blurAmount = 0.2;
splatRenderer.depthWrite = true;
```

For an on-demand render loop, provide `onDirty` to
`GaussianSplatRenderer` so asynchronous loading and sorting can request a new
frame.

## Update removed APIs

The 0.2.x package exports only `GaussianSplatPlugin` and the
`GaussianSplatPluginOptions` type. Replace removed 0.1.x helpers as follows:

| 0.1.x API | 0.2.x replacement |
| --- | --- |
| `getSparkRendererForScene(scene)` | Retain the `GaussianSplatRenderer` reference created by the application. |
| `updateSharedSparkRendererOptions(scene, options)` | Configure `GaussianSplatRenderer` at construction or update its runtime properties. |
| `isGaussianSplat(object)` | Import `SplatMesh` from `gaussian-splat-lite` and use `object instanceof SplatMesh` when inspection is necessary. |
| `isGaussianSplatScene(object)` | No direct replacement. Track application scenes and tile renderers explicitly, or traverse for Gaussian Splat Lite `SplatMesh` instances. |

Plugin-owned mesh tracking is now private. Do not depend on the old
`gaussianSplatScene`, `gaussianSplatMeshes`, or `gaussianSplatExtraBytes`
`userData` fields.

## Review raycast behavior

When `minRaycastOpacity` was omitted, 0.1.x used `0.1`. In 0.2.x, omission
uses the Gaussian Splat Lite default of `0.05`.

The threshold's behavior also changed with the backend:

- In 0.1.x, Spark used it primarily to exclude splats whose decoded peak
  opacity was below the threshold, then raycast an approximate ellipsoid.
- In 0.2.x, Gaussian Splat Lite treats it as a per-splat kernel-alpha
  isosurface. It both excludes splats that never reach the threshold and clips
  each remaining splat's raycast hit area at that alpha, including
  special-shape splats.

As a result, lower values produce larger, more permissive hit areas and higher
values produce smaller, stricter hit areas. Setting `0.1` preserves the old
numeric default, but does not guarantee the same intersections as 0.1.x. Use it
as a starting point and retune picking for the application:

```ts
tiles.registerPlugin(
  new GaussianSplatPlugin({
    minRaycastOpacity: 0.1,
  }),
);
```

`targetCoverageBoostScale` remains a plugin option and still defaults to
`0.1`.

## Dispose owned resources

`tiles.dispose()` continues to dispose tile-owned `SplatMesh` instances. It no
longer disposes the scene-level renderer because that renderer is owned by the
application. On final scene teardown, dispose them in this order:

```ts
tiles.dispose();

scene.remove(splatRenderer);
splatRenderer.dispose();

renderer.dispose(); // Only if the application also owns and is finished with it.
```

Do not dispose `splatRenderer` when merely replacing one Gaussian tile set with
another in the same scene.

## Expected rendering differences

The tile formats and plugin options remain compatible, but 0.2.x decodes,
sorts, and renders splats through a different backend. Small appearance,
sorting, performance, or memory differences are expected. If visual parity is
important, start by setting every renderer option that was explicitly present
in the old `sparkRendererOptions`, then tune the Gaussian Splat Lite renderer
for the application.

`TilesFadePlugin`, explicit and implicit tiling, large GIS/ECEF coordinates,
tile disposal, memory accounting, and `EXT_splat_opacity` v1/v2 remain
supported.

## Troubleshooting

- **Tiles load but no splats are visible:** confirm that a
  `GaussianSplatRenderer` was added to the same scene as `tiles.group`.
- **npm reports a peer dependency conflict:** ensure the resolved Three.js
  version is at least `0.185.1` and `gaussian-splat-lite` is at least `0.1.7`.
- **Raycast results changed:** set `minRaycastOpacity: 0.1` to preserve the
  old numeric default, then retune it because 0.2.x uses kernel-alpha
  isosurfaces to determine each splat's hit area.
- **An on-demand view stops before splats appear:** connect the renderer's
  `onDirty` callback to the application's render scheduler.
- **Custom Spark meshes or edits no longer render with the tiles:** port them
  to Gaussian Splat Lite or continue rendering that unrelated Spark content
  through a separately managed Spark renderer.
