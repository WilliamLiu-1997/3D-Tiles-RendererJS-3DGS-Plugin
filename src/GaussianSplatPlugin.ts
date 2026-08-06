import {
  SplatMesh,
  type SparkRendererOptions,
  type SplatMeshOptions,
} from '@sparkjsdev/spark';
import { Group, Matrix4, Object3D, WebGLRenderer, type Scene } from 'three';
import type { Tile, TilesRenderer } from '3d-tiles-renderer';
import {
  buildGaussianPrimitiveSources,
  collectGaussianBufferIndices,
  buildGaussianDescriptors,
  buildGaussianMeshSource,
  createAbortError,
  parseGlb,
  parseGltfJson,
  resolveGltfBuffers,
  type GaussianSplatPrimitiveDescriptor,
} from './GaussianSplatLoader';
import { DEFAULT_TARGET_COVERAGE_BOOST_SCALE } from './GaussianSplatOpacityExtension';
import {
  type SharedSparkRendererManager,
  getSharedSparkRendererManager,
} from './SharedSparkRendererManager';
import {
  createGaussianFadeMaterial,
  createGaussianFadeModifier,
  createGaussianFadeState,
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

export const SPARK_RENDERER_OPTION_KEYS = [
  'premultipliedAlpha',
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

export type SupportedSparkRendererOptionKey =
  (typeof SPARK_RENDERER_OPTION_KEYS)[number];

export type SupportedSparkRendererOptions = Pick<
  SparkRendererOptions,
  SupportedSparkRendererOptionKey
>;

export type GaussianSplatPluginHost = {
  renderer: WebGLRenderer;
  scene: Scene;
  minRaycastOpacity?: SplatMeshOptions['minRaycastOpacity'];
  sparkRendererOptions?: SupportedSparkRendererOptions;
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

const MAX_GAUSSIAN_MESH_INIT_CONCURRENCY = 4;
const DEFAULT_MIN_RAYCAST_OPACITY = 0.1;

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

async function allSettledWithConcurrencyLimit<T, R>(
  values: readonly T[],
  limit: number,
  callback: (value: T, index: number) => Promise<R>,
) {
  if (values.length === 0) {
    return [] as PromiseSettledResult<R>[];
  }

  const settled = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= values.length) {
        return;
      }

      nextIndex++;

      try {
        const value = await callback(values[currentIndex], currentIndex);
        settled[currentIndex] = {
          status: 'fulfilled',
          value,
        };
      } catch (reason) {
        settled[currentIndex] = {
          status: 'rejected',
          reason,
        };
      }
    }
  };

  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return settled;
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
  #sparkManager: SharedSparkRendererManager | null = null;
  #targetCoverageBoostScale: number;

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
    this.tiles = tiles;
    this.#sparkManager = getSharedSparkRendererManager(this.#host);
    this.#sparkManager.retain(tiles);
  }

  dispose() {
    if (!this.tiles) return;

    const tiles = this.tiles;

    tiles.forEachLoadedModel((scene) => {
      const group = scene as Group;
      if (isGaussianSplatScene(group)) {
        this.#disposeSplatScene(group);
      }
    });

    if (this.#sparkManager) {
      this.#sparkManager.release(tiles);
      this.#sparkManager = null;
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
    const splatMeshes = this.#getSplatMeshes(scene);

    for (const mesh of splatMeshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }

    scene.userData.gaussianSplatMeshes = [];
    scene.userData.gaussianSplatExtraBytes = 0;
  }

  #getSplatMeshes(scene: Group) {
    if (isGaussianSplatScene(scene) && scene.userData.gaussianSplatMeshes) {
      return scene.userData.gaussianSplatMeshes;
    }

    const splatMeshes: SplatMesh[] = [];
    scene.traverse((child) => {
      if (child !== scene && isGaussianSplat(child)) {
        splatMeshes.push(child);
      }
    });

    return splatMeshes;
  }

  async #createMeshForDescriptor(
    descriptor: GaussianSplatPrimitiveDescriptor,
    abortSignal: AbortSignal,
  ) {
    const source = await buildGaussianMeshSource(
      descriptor,
      abortSignal,
      this.#targetCoverageBoostScale,
    );
    if (abortSignal.aborted) {
      source.extSplats.dispose();
      throw createAbortError();
    }
    let byteLength = 0;
    const fadeState = createGaussianFadeState();

    const mesh = new SplatMesh({
      extSplats: source.extSplats,
      raycastable: true,
      minRaycastOpacity:
        this.#host.minRaycastOpacity ?? DEFAULT_MIN_RAYCAST_OPACITY,
      objectModifier: createGaussianFadeModifier(fadeState.opacityUniform),
    }) as GaussianSplatMesh;

    const originalMaterial = mesh.material;
    mesh.material = createGaussianFadeMaterial(mesh, fadeState);
    if (originalMaterial && typeof originalMaterial.dispose === 'function') {
      originalMaterial.dispose();
    }
    mesh.name = 'GaussianSplatTileMesh';
    mesh.matrix.copy(descriptor.matrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
    mesh.userData.gaussianSplat = true;

    await mesh.initialized;
    if (abortSignal.aborted) {
      mesh.dispose();
      throw createAbortError();
    }
    const ext = source.extSplats;
    if (ext.extArrays) {
      byteLength =
        (ext.extArrays[0]?.byteLength ?? 0) +
        (ext.extArrays[1]?.byteLength ?? 0);
    }
    for (const tex of ext.textures) {
      const texData = tex?.image?.data;
      if (texData && 'byteLength' in texData) {
        byteLength += (texData as ArrayBufferView).byteLength;
      }
    }
    if (ext.extra) {
      for (const value of Object.values(ext.extra)) {
        if (ArrayBuffer.isView(value)) {
          byteLength += value.byteLength;
        }
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
    const normalizedExtension = extension.toLowerCase();
    if (!/^(gltf|glb)$/.test(normalizedExtension)) {
      return null;
    }

    const tiles = this.tiles as TilesRendererWithHooks | null;
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
      if (abortSignal.aborted) {
        return null;
      }

      const descriptors = buildGaussianDescriptors(json, buffers, sources);
      if (abortSignal.aborted) {
        return null;
      }

      const sceneMatrix = makeGaussianSceneMatrix(this.tiles, tile);

      const scene = new Group() as GaussianSplatSceneGroup;
      scene.name = 'GaussianSplatScene';
      scene.userData.gaussianSplatScene = true;
      scene.applyMatrix4(sceneMatrix);
      scene.matrixAutoUpdate = false;

      const settled = await allSettledWithConcurrencyLimit(
        descriptors,
        MAX_GAUSSIAN_MESH_INIT_CONCURRENCY,
        (descriptor) => this.#createMeshForDescriptor(descriptor, abortSignal),
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

      if (abortSignal.aborted || firstError) {
        for (const { mesh } of results) {
          mesh.removeFromParent();
          mesh.dispose();
        }

        if (abortSignal.aborted) {
          return null;
        }

        console.error(
          'GaussianSplatPlugin: Failed to parse gaussian tile',
          firstError,
        );
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
