# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic
Versioning.

## [Unreleased]

## [0.2.0] - 2026-08-28

### Added

- Added a 0.1.x to 0.2.x migration guide covering the backend, API, ownership,
  and default-value changes.

### Changed

- Replaced `@sparkjsdev/spark` with `gaussian-splat-lite@0.1.7` for native
  large-coordinate precision, faster sorting, and faster, more accurate
  raycasting while retaining similar CPU and GPU memory usage; raised the
  Three.js peer requirement to `>=0.185.1`.
- Applications now create, configure, attach, and dispose their own scene-level
  `GaussianSplatRenderer`. The plugin constructor only accepts optional
  `GaussianSplatPluginOptions`.
- Splat tiles now create Gaussian Splat Lite `SplatMesh` instances directly
  from SPZ bytes and use the library's built-in camera-relative rendering.
- `EXT_splat_opacity` v1/v2 conversion now runs as a serializable `postDecode`
  expression in the SPZ decode worker and passes semantic opacity in the
  `[0, 1000]` range to Gaussian Splat Lite.
- `TilesFadePlugin` integration now combines `fadeIn` and `fadeOut` coverage at
  render time without modifying decoded source opacity.
- `minRaycastOpacity` now uses the Gaussian Splat Lite default when omitted.
- Raycasting now uses Gaussian Splat Lite's kernel-alpha isosurface, so
  `minRaycastOpacity` also controls each splat's hit area rather than only
  filtering splats by their decoded peak opacity.
- Plugin-owned mesh tracking and byte accounting are now private, so
  application-created `SplatMesh` objects are neither counted nor disposed as
  tile content.
- Simplified the examples and updated documentation and issue templates for the
  Gaussian Splat Lite backend.

### Removed

- Removed the shared Spark renderer manager, automatic renderer creation, and
  the `renderer`, `scene`, and renderer-option constructor fields.
- Removed the public renderer lookup/update helpers and the `isGaussianSplat`
  and `isGaussianSplatScene` guards.
- Removed the plugin-local opacity WASM/preload pipeline, Rust build, and
  main-thread decoded-array processing.
- Removed redundant `UnloadTilesPlugin` and `unloadPercent` example setup.

### Fixed

- Ignored macOS AppleDouble HTML metadata files when collecting Vite example
  entry points.
- Deduplicated Three.js in the Vite example build.

## [0.1.16] - 2026-08-06

### Added

- Added `EXT_splat_opacity` version 2 support for converter-authored binary16
  source opacity, normalized pre-boost `sMid / sMax` ratios, and
  `opacity_anisotropic_v1` coverage metadata while preserving version 1
  compatibility.
- Added the `targetCoverageBoostScale` plugin option to cap the converter
  coverage boost retained from version 2 content. It defaults to `0.1`, accepts
  `0` to remove the recorded boost, and never increases the boost beyond the
  value recorded in the file.

### Changed

- Raised the minimum supported Three.js version from `0.180.0` to `0.185.0`.
- Version 2 processing retargets the recorded anisotropic scale boost, divides
  source opacity by the retained two-axis area growth, and applies Spark's
  high-opacity encoding. Splats with source opacity less than or equal to `1`
  retain their SPZ-decoded scales and opacity.
- Optimized version 2 loading for the converter's interleaved layout: the plugin
  reads the already-loaded GLB bytes without copying or deinterleaving them and
  validates and applies matched splats in one pass before Spark texture creation.
- Version 2 extension buffers remain optional. Unsupported metadata and
  malformed or unavailable accessors leave the complete SPZ fallback intact;
  invalid individual values and unmatched splats keep their own SPZ-decoded
  opacity and boosted scales while other valid splats can still be applied.
- Reworked the shared example camera controller to consume rotate, drag, and
  zoom input through bounded damping, preserve interaction anchors and
  ellipsoid-up alignment, and track movement lifecycle events consistently.
- Replaced the example camera controller's `enableDamping` / `dampingFactor`
  settings with `damping` (default `0.15`), exported its state constants, and
  added `getPivotPoint()`.

### Removed

- Removed `encodeLinear` from the supported `sparkRendererOptions` subset.

### Fixed

- Hardened `EXT_splat_opacity` accessor validation for component types,
  normalization, strides, and declared and loaded byte bounds.
- Kept the example camera pivot indicator visible briefly after interaction and
  above Gaussian splats with both standard and reversed depth buffers.
- Fixed duplicate pointer coordinate conversion in the example camera
  controller so picking remains aligned when its DOM element is offset within
  the viewport.

## [0.1.15] - 2026-07-15

### Changed

- Updated the `3d-tiles-renderer` peer and development dependency to `^0.5.0`.

### Fixed

- Preserved Gaussian primitive transforms when
  `3d-tiles-renderer@0.5.x` activates a tile by synchronizing each primitive's
  position, quaternion, and scale with its local matrix.

## [0.1.14] - 2026-06-19

### Added

- Added `EXT_splat_opacity` support for SPZ-compressed Gaussian splat
  primitives so tiles can carry Spark-compatible per-splat opacity values in a
  `FLOAT` / `SCALAR` accessor.
- Added an `EXT_splat_opacity` extension note describing the extension shape,
  accessor requirements, and value semantics.

### Changed

- Split Gaussian splat fade handling and splat opacity extension loading into
  focused helper modules.
- Applied `EXT_splat_opacity` values before Spark texture creation so the
  decoded splat data includes overrides during initial upload.

## [0.1.13] - 2026-06-08

### Fixed

- Restored the active renderer viewport after camera-relative Spark updates so
  WebXR eye viewports are not overwritten by Spark's render-target passes.

## [0.1.12] - 2026-06-05

### Fixed

- Relaxed the Three.js peer dependency range to `>=0.180.0` so newer Three.js
  `0.x` releases can install without npm peer dependency conflicts.

## [0.1.11] - 2026-06-01

### Added

- Added `minRaycastOpacity` on the `GaussianSplatPlugin` host so callers can
  configure the Spark `SplatMesh` raycast opacity threshold.

## [0.1.10] - 2026-05-22

### Added

- Added `getSparkRendererForScene` and `updateSharedSparkRendererOptions`
  public exports for inspecting the shared Spark renderer and updating supported
  Spark renderer options at runtime.

### Changed

- Made runtime shared Spark renderer option updates apply without logging the
  shared-options warning.
- Avoided recursively cloning camera children when reusing camera-relative Spark
  update and render cameras.

## [0.1.9] - 2026-05-22

### Changed

- Added `premultipliedAlpha` to the supported `sparkRendererOptions` subset.
- Reduced camera-relative Spark renderer hot-path overhead by removing unused
  traversal state, limiting rebased-root pool cleanup to the previous frame's
  active range, and restoring rebased root matrices in a single pass.
- Clarified the Spark accumulator timing assumption used when fixing
  camera-relative `viewToWorld` state after an update.
- Removed `accumExtSplats` from the supported `sparkRendererOptions` subset
  and documentation because Spark's default packed accumulator already encodes
  intermediary splats relative to the camera origin.

### Fixed

- Applied shared `depthTest` and `depthWrite` option updates to the Spark
  material instead of the renderer object.
- Cleared pending Spark update/sort timers and splat state before shared Spark
  renderer disposal, and deferred final disposal while an active sort is still
  completing.
- Updated the shared example viewer to listen for the current
  `load-tileset` event name.

## [0.1.8] - 2026-05-21

### Changed

- Updated the Spark peer and development dependency range to `^2.1.0`.
- Updated the 3D Tiles Renderer peer and development dependency range to
  `^0.4.25`.
- Updated the documentation and example imagery globe setup to use
  `GeneratedSurfacePlugin` with `XYZTilesOverlay` instead of deprecated
  image-format plugin APIs.

## [0.1.7] - 2026-05-10

### Changed

- Camera-relative Spark updates now reuse Spark's internal auto-update skip
  logic while still updating with the identity-rebased camera used by the
  plugin.
- Simplified camera-relative root traversal to carry ancestor state during the
  visible scene walk, avoiding repeated parent-chain scans and explicit
  splat/edit state snapshots in the render path.
- Constrained the Spark peer and development dependency range to `~2.0.0`.

## [0.1.6] - 2026-05-06

### Fixed

- Preserved WebXR `ArrayCamera.matrixWorld` during camera-relative Spark update
  checks by reading the camera pose directly from `matrixWorld` instead of
  calling Three.js world-pose helpers that recompute the matrix.

### Changed

- Documented the WebXR camera/session switching pattern with a VRButton-based
  example aligned with the upstream 3D Tiles Renderer VR example.
- Clarified that AR needs its own placement, hit-test, reference-space, depth,
  and occlusion handling in addition to the 3D Tiles XR camera pattern.

## [0.1.5] - 2026-05-03

### Fixed

- Rebased Spark global `SplatEdit` roots alongside camera-relative Gaussian
  splat roots and tracked edit/SDF state changes so crop boxes stay aligned and
  refresh correctly when edited.

## [0.1.4] - 2026-04-22

### Added

- Added optional `sparkRendererOptions` on the `GaussianSplatPlugin` host so
  callers can forward a supported subset of Spark renderer settings into the
  shared camera-relative Spark renderer.

### Changed

- Shared Spark renderer setup now normalizes tracked option values and keeps
  `focalAdjustment: 2` as the plugin default while leaving other unspecified
  settings on Spark defaults.
- When multiple `GaussianSplatPlugin` instances reuse the same `Scene` /
  `WebGLRenderer` pair, explicit `sparkRendererOptions` from later instances
  are merged into the existing shared renderer instead of being ignored.

### Fixed

- Avoided dirtying the shared Spark renderer when a later plugin instance
  repeats the renderer's current option value for a key that was not previously
  tracked by the manager.

## [0.1.3] - 2026-04-20

### Fixed

- Updated camera-relative Spark invalidation to snapshot Gaussian splat world
  transforms and opacity, so rebased splat movement now triggers a refresh.
- Continued the Spark update check for one frame after rebasing ends, which
  prevents stale accumulation state when camera-relative splats disappear.

## [0.1.2] - 2026-04-19

### Fixed

- Updated camera-relative Spark invalidation to track Gaussian splat node
  state, not just UUID presence, so opacity changes and GaussianSplatScene-only
  visibility changes correctly trigger a refresh.

## [0.1.1] - 2026-04-17

### Fixed

- Corrected the package repository, homepage, and issue tracker URLs to match
  the actual GitHub repository so npm metadata and trusted publishing resolve
  against the right repo.
- Added an npm publish workflow for tag-based releases and updated it to use
  `npm publish --access public`.
- Upgraded the publish workflow to use Node.js 24 and npm 11.10.0+ so Trusted
  Publishing runs against a supported CLI/runtime combination.

## [0.1.0] - 2026-04-17

### Added

- Initial public npm release for `3d-tiles-rendererjs-3dgs-plugin`.
- Gaussian splat tile parsing for `gltf` and `glb` payloads that use
  `KHR_gaussian_splatting` with
  `KHR_gaussian_splatting_compression_spz_2`.
- Rendering support for both explicit and implicit 3D Tiles tiling schemes.
- Shared Spark renderer management, camera-relative rebasing, byte accounting,
  and fade-plugin-compatible opacity handling.
- Browser demo and sample datasets for explicit and implicit tilesets.
