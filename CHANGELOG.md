# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic
Versioning.

## [Unreleased]

### Fixed

- Reworked camera-relative Spark invalidation to update immediately from
  camera pose and per-splat world-state snapshots, so transform, opacity,
  removal, and rebase-state changes no longer leave stale splat data behind.

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
