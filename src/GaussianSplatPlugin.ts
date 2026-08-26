import {
  SplatMesh,
  type GaussianSplatRendererOptions,
  type SplatMeshOptions,
} from 'gaussian-splat-lite';
import { Group, Matrix4, Object3D, WebGLRenderer, type Scene } from 'three';
import type { Tile, TilesRenderer } from '3d-tiles-renderer';
import {
  buildGaussianPrimitiveSources,
  collectGaussianBufferIndices,
  buildGaussianDescriptors,
  buildGaussianSplats,
  createAbortError,
  parseGlb,
  parseGltfJson,
  resolveGltfBuffers,
  type GaussianSplatPrimitiveDescriptor,
} from './GaussianSplatLoader';
import { DEFAULT_TARGET_COVERAGE_BOOST_SCALE } from './GaussianSplatOpacityExtension';
import {
  type SharedGaussianSplatRendererManager,
  getSharedGaussianSplatRendererManager,
} from './SharedGaussianSplatRendererManager';
import {
  createGaussianFadeMaterial,
  type GaussianSplatFadeMaterial,
} from './GaussianSplatFade';

type TileWithEngineData = Tile & {
  engineData: Record<string, any>;
};

type TilesRendererPluginHooks = {
  preprocessURL?: (url: string, tile: TileWithEngineData | null) => string;
  fetchData?: (url: string, options: RequestInit) => unknown;
};

type TilesRendererWithHooks = TilesRenderer & {
  fetchOptions: RequestInit;
  invokeAllPlugins(
    callback: (plugin: TilesRendererPluginHooks) => unknown,
  ): void;
  invokeOnePlugin<T>(
    callback: (plugin: TilesRendererPluginHooks) => T,
  ): T | null;
};

export const GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS = [
  'premultipliedAlpha',
  'autoUpdate',
  'preUpdate',
  'maxStdDev',
  'minPixelRadius',
  'maxPixelRadius',
  'minAlpha',
  'enable2DGS',
  'preBlurAmount',
  'blurAmount',
  'clipXY',
  'focalAdjustment',
  'sortRadial',
  'minSortIntervalMs',
  'depthTest',
  'depthWrite',
] as const;

export type SupportedGaussianSplatRendererOptionKey =
  (typeof GAUSSIAN_SPLAT_RENDERER_OPTION_KEYS)[number];

export type SupportedGaussianSplatRendererOptions = Pick<
  GaussianSplatRendererOptions,
  SupportedGaussianSplatRendererOptionKey
>;

export type GaussianSplatPluginHost = {
  renderer: WebGLRenderer;
  scene: Scene;
  minRaycastOpacity?: SplatMeshOptions['minRaycastOpacity'];
  gaussianSplatRendererOptions?: SupportedGaussianSplatRendererOptions;
  targetCoverageBoostScale?: number;
};

type GaussianSplatSceneGroup = Group & {
  userData: {
    gaussianSplatScene: true;
    gaussianSplatExtraBytes?: number;
    gaussianSplatMeshes?: SplatMesh[];
  };
};

type GaussianSplatMesh = SplatMesh & {
  material: GaussianSplatFadeMaterial;
};

const DEFAULT_MIN_RAYCAST_OPACITY = 0.05;

const _sceneMatrix = new Matrix4();

function makeGaussianSceneMatrix(
  tiles: TilesRenderer | null,
  tile: TileWithEngineData,
) {
  const target = _sceneMatrix.identity();
  // NOTE: _upRotationMatrix is an internal API of TilesRenderer — may change across versions.
  const upRotationMatrix = (
    tiles as (TilesRenderer & { _upRotationMatrix?: Matrix4 }) | null
  )?._upRotationMatrix;
  if (upRotationMatrix) {
    target.copy(upRotationMatrix);
  }

  const transform = tile.engineData?.transform;
  if (transform) {
    target.premultiply(transform);
  }

  return target;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}

async function fetchArrayBufferWithPlugins(
  tiles: TilesRendererWithHooks | null,
  url: string,
  tile: TileWithEngineData | null,
  abortSignal: AbortSignal,
) {
  let processedUrl = url;
  if (tiles) {
    tiles.invokeAllPlugins((plugin) => {
      processedUrl = plugin.preprocessURL
        ? plugin.preprocessURL(processedUrl, tile)
        : processedUrl;
    });
  }

  const fetchOptions = {
    ...(tiles?.fetchOptions ?? {}),
    signal: abortSignal,
  };
  const result = tiles
    ? await tiles.invokeOnePlugin(
        (plugin) =>
          plugin.fetchData && plugin.fetchData(processedUrl, fetchOptions),
      )
    : await fetch(processedUrl, fetchOptions);

  if (result instanceof Response) {
    if (!result.ok) {
      throw new Error(
        `GaussianSplatPlugin: Failed to load glTF buffer "${processedUrl}" with status ${result.status}.`,
      );
    }

    return new Uint8Array(await result.arrayBuffer());
  }

  if (result instanceof ArrayBuffer) {
    return new Uint8Array(result);
  }

  if (ArrayBuffer.isView(result)) {
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  }

  throw new Error(
    `GaussianSplatPlugin: Unexpected glTF buffer response for "${processedUrl}".`,
  );
}

export function isGaussianSplat(
  object: Object3D | undefined | null,
): object is SplatMesh {
  return Boolean(object?.userData?.gaussianSplat);
}

export function isGaussianSplatScene(
  scene: Object3D | undefined | null,
): scene is GaussianSplatSceneGroup {
  return Boolean(scene?.userData?.gaussianSplatScene);
}

export class GaussianSplatPlugin {
  name = 'GAUSSIAN_SPLAT_PLUGIN';
  priority = 1;
  tiles: TilesRenderer | null = null;
  #host: GaussianSplatPluginHost;
  #gaussianSplatRendererManager: SharedGaussianSplatRendererManager | null =
    null;
  #targetCoverageBoostScale: number;
  #lifecycleGeneration = 0;

  constructor(host: GaussianSplatPluginHost) {
    const targetCoverageBoostScale =
      host.targetCoverageBoostScale ?? DEFAULT_TARGET_COVERAGE_BOOST_SCALE;
    if (
      !Number.isFinite(targetCoverageBoostScale) ||
      targetCoverageBoostScale < 0
    ) {
      throw new Error(
        'GaussianSplatPlugin: targetCoverageBoostScale must be a finite non-negative number.',
      );
    }

    this.#host = host;
    this.#targetCoverageBoostScale = targetCoverageBoostScale;
  }

  init(tiles: TilesRenderer) {
    this.#lifecycleGeneration++;
    this.tiles = tiles;
    this.#gaussianSplatRendererManager =
      getSharedGaussianSplatRendererManager(this.#host);
    this.#gaussianSplatRendererManager.retain(tiles);
  }

  dispose() {
    if (!this.tiles) return;

    this.#lifecycleGeneration++;
    const tiles = this.tiles;

    tiles.forEachLoadedModel((scene) => {
      const group = scene as Group;
      if (isGaussianSplatScene(group)) {
        this.#disposeSplatScene(group);
      }
    });

    if (this.#gaussianSplatRendererManager) {
      this.#gaussianSplatRendererManager.release(tiles);
      this.#gaussianSplatRendererManager = null;
    }

    this.tiles = null;
  }

  disposeTile(tile: TileWithEngineData) {
    const scene = tile.engineData?.scene as Group | undefined;
    if (!isGaussianSplatScene(scene)) {
      return;
    }

    this.#disposeSplatScene(scene);
  }

  #disposeSplatScene(scene: GaussianSplatSceneGroup) {
    for (const mesh of scene.userData.gaussianSplatMeshes ?? []) {
      mesh.removeFromParent();
      mesh.dispose();
    }

    scene.userData.gaussianSplatMeshes = [];
    scene.userData.gaussianSplatExtraBytes = 0;
  }

  async #createMeshForDescriptor(
    descriptor: GaussianSplatPrimitiveDescriptor,
    abortSignal: AbortSignal,
  ) {
    const splats = await buildGaussianSplats(
      descriptor,
      abortSignal,
      this.#targetCoverageBoostScale,
    );
    if (abortSignal.aborted) {
      splats.dispose();
      throw createAbortError();
    }

    const mesh = new SplatMesh({
      splats,
      minRaycastOpacity:
        this.#host.minRaycastOpacity ?? DEFAULT_MIN_RAYCAST_OPACITY,
    }) as GaussianSplatMesh;

    mesh.material = createGaussianFadeMaterial(mesh);
    mesh.name = 'GaussianSplatTileMesh';
    mesh.matrix.copy(descriptor.matrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    mesh.userData.gaussianSplat = true;

    let byteLength =
      splats.splatArrays[0].byteLength + splats.splatArrays[1].byteLength;
    for (const value of Object.values(splats.extra)) {
      if (ArrayBuffer.isView(value)) {
        byteLength += value.byteLength;
      }
    }

    return {
      mesh,
      byteLength,
    };
  }

  parseTile(
    buffer: ArrayBuffer,
    tile: TileWithEngineData,
    extension: string,
    uri: string,
    abortSignal: AbortSignal,
  ) {
    const tiles = this.tiles as TilesRendererWithHooks | null;
    if (!tiles) {
      return null;
    }

    const lifecycleGeneration = this.#lifecycleGeneration;
    const isStale = () =>
      abortSignal.aborted ||
      this.#lifecycleGeneration !== lifecycleGeneration;

    const normalizedExtension = extension.toLowerCase();
    if (!/^(gltf|glb)$/.test(normalizedExtension)) {
      return null;
    }

    let json: any;
    let embeddedBuffer: Uint8Array | null = null;

    if (normalizedExtension === 'glb') {
      const glb = parseGlb(buffer);
      if (!glb) {
        return null;
      }

      json = glb.json;
      embeddedBuffer = glb.embeddedBuffer;
    } else {
      json = parseGltfJson(buffer);
    }

    const sources = buildGaussianPrimitiveSources(json);
    if (!sources) {
      return null;
    }

    const bufferIndices = collectGaussianBufferIndices(json, sources);

    return (async () => {
      const buffers = await resolveGltfBuffers(
        json,
        uri,
        bufferIndices.required,
        (bufferUri, signal) =>
          fetchArrayBufferWithPlugins(
            tiles,
            bufferUri,
            tile,
            signal ?? abortSignal,
          ),
        abortSignal,
        embeddedBuffer,
        bufferIndices.optional,
      );
      if (isStale()) {
        return null;
      }

      const descriptors = buildGaussianDescriptors(json, buffers, sources);
      const sceneMatrix = makeGaussianSceneMatrix(tiles, tile);

      const scene = new Group() as GaussianSplatSceneGroup;
      scene.name = 'GaussianSplatScene';
      scene.userData.gaussianSplatScene = true;
      scene.applyMatrix4(sceneMatrix);
      scene.matrixAutoUpdate = false;

      const settled = await Promise.allSettled(
        descriptors.map((descriptor) =>
          this.#createMeshForDescriptor(descriptor, abortSignal),
        ),
      );

      const results: { mesh: SplatMesh; byteLength: number }[] = [];
      let firstError: unknown = null;

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
        } else if (!firstError && !isAbortError(outcome.reason)) {
          firstError = outcome.reason;
        }
      }

      const stale = isStale();
      if (stale || firstError) {
        for (const { mesh } of results) {
          mesh.dispose();
        }

        if (stale) {
          return null;
        }

        throw firstError;
      }

      let totalByteLength = 0;
      scene.userData.gaussianSplatMeshes = results.map(({ mesh }) => mesh);
      for (const { mesh, byteLength } of results) {
        scene.add(mesh);
        totalByteLength += byteLength;
      }

      scene.userData.gaussianSplatExtraBytes = totalByteLength;

      tile.engineData.scene = scene;
      tile.engineData.geometry = [];
      tile.engineData.materials = [];
      tile.engineData.textures = [];

      return scene;
    })();
  }

  calculateBytesUsed(_tile: TileWithEngineData, scene?: Group) {
    return scene?.userData?.gaussianSplatExtraBytes ?? 0;
  }
}
