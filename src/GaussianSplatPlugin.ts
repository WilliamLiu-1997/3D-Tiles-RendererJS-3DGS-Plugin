import {
  SplatFileType,
  SplatMesh,
  type SplatMeshOptions,
} from 'gaussian-splat-lite';
import { Group, Matrix4 } from 'three';
import type { Tile, TilesRenderer } from '3d-tiles-renderer';
import {
  buildGaussianPrimitiveSources,
  collectGaussianBufferIndices,
  buildGaussianDescriptors,
  parseGlb,
  parseGltfJson,
  resolveGltfBuffers,
  type GaussianSplatPrimitiveDescriptor,
} from './GaussianSplatLoader';
import {
  DEFAULT_TARGET_COVERAGE_BOOST_SCALE,
  createSplatOpacityPostDecode,
} from './GaussianSplatOpacityExtension';
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

export type GaussianSplatPluginOptions = {
  minRaycastOpacity?: SplatMeshOptions['minRaycastOpacity'];
  targetCoverageBoostScale?: number;
};

type GaussianSplatMesh = SplatMesh & {
  material: GaussianSplatFadeMaterial;
};

const _sceneMatrix = new Matrix4();
// Account for the retained splat data plus the renderer-side working copies.
const SPLAT_MEMORY_ESTIMATE_MULTIPLIER = 1.5;

function makeGaussianSceneMatrix(
  tiles: TilesRenderer,
  tile: TileWithEngineData,
) {
  const target = _sceneMatrix.identity();
  // NOTE: _upRotationMatrix is an internal API of TilesRenderer — may change across versions.
  const upRotationMatrix = (
    tiles as TilesRenderer & { _upRotationMatrix?: Matrix4 }
  )._upRotationMatrix;
  if (upRotationMatrix) {
    target.copy(upRotationMatrix);
  }

  const transform = tile.engineData?.transform;
  if (transform) {
    target.premultiply(transform);
  }

  return target;
}

async function fetchArrayBufferWithPlugins(
  tiles: TilesRendererWithHooks,
  url: string,
  tile: TileWithEngineData,
  abortSignal: AbortSignal,
) {
  let processedUrl = url;
  tiles.invokeAllPlugins((plugin) => {
    processedUrl = plugin.preprocessURL
      ? plugin.preprocessURL(processedUrl, tile)
      : processedUrl;
  });

  const fetchOptions = {
    ...tiles.fetchOptions,
    signal: abortSignal,
  };
  const result = await tiles.invokeOnePlugin(
    (plugin) =>
      plugin.fetchData && plugin.fetchData(processedUrl, fetchOptions),
  );

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

export class GaussianSplatPlugin {
  name = 'GAUSSIAN_SPLAT_PLUGIN';
  priority = 1;
  tiles: TilesRenderer | null = null;
  #minRaycastOpacity: SplatMeshOptions['minRaycastOpacity'];
  #targetCoverageBoostScale: number;
  #lifecycleGeneration = 0;
  #splatMeshesByScene = new WeakMap<Group, readonly SplatMesh[]>();

  constructor({
    minRaycastOpacity,
    targetCoverageBoostScale = DEFAULT_TARGET_COVERAGE_BOOST_SCALE,
  }: GaussianSplatPluginOptions = {}) {
    if (
      !Number.isFinite(targetCoverageBoostScale) ||
      targetCoverageBoostScale < 0
    ) {
      throw new Error(
        'GaussianSplatPlugin: targetCoverageBoostScale must be a finite non-negative number.',
      );
    }

    this.#minRaycastOpacity = minRaycastOpacity;
    this.#targetCoverageBoostScale = targetCoverageBoostScale;
  }

  init(tiles: TilesRenderer) {
    this.#lifecycleGeneration++;
    this.tiles = tiles;
  }

  dispose() {
    if (!this.tiles) return;

    this.#lifecycleGeneration++;
    const tiles = this.tiles;

    tiles.forEachLoadedModel((scene) => {
      this.#disposeSplatScene(scene as Group);
    });

    this.tiles = null;
  }

  disposeTile(tile: TileWithEngineData) {
    const scene = tile.engineData?.scene as Group | undefined;
    if (scene) {
      this.#disposeSplatScene(scene);
    }
  }

  #disposeSplatScene(scene: Group) {
    const meshes = this.#splatMeshesByScene.get(scene);
    if (!meshes) {
      return;
    }

    this.#splatMeshesByScene.delete(scene);
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
  }

  async #createMeshForDescriptor(
    descriptor: GaussianSplatPrimitiveDescriptor,
    abortSignal: AbortSignal,
  ) {
    abortSignal.throwIfAborted();

    const mesh = new SplatMesh({
      fileBytes: descriptor.data.bytes,
      fileType: SplatFileType.SPZ,
      postDecode: createSplatOpacityPostDecode(
        descriptor.data.opacityExtensionData,
        this.#targetCoverageBoostScale,
      ),
      minRaycastOpacity: this.#minRaycastOpacity,
    }) as GaussianSplatMesh;

    try {
      await mesh.initialized;
      abortSignal.throwIfAborted();
    } catch (error) {
      mesh.dispose();
      throw error;
    }

    mesh.material = createGaussianFadeMaterial(mesh);
    mesh.name = 'GaussianSplatTileMesh';
    mesh.applyMatrix4(descriptor.matrix);
    mesh.matrixAutoUpdate = false;

    return mesh;
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

      const scene = new Group();
      scene.name = 'GaussianSplatScene';
      scene.applyMatrix4(sceneMatrix);

      const settled = await Promise.allSettled(
        descriptors.map((descriptor) =>
          this.#createMeshForDescriptor(descriptor, abortSignal),
        ),
      );

      const meshes = settled.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? [outcome.value] : [],
      );
      const failure = settled.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      );

      const stale = isStale();
      if (stale || failure) {
        for (const mesh of meshes) {
          mesh.dispose();
        }

        if (stale) {
          return null;
        }

        if (failure) {
          throw failure.reason;
        }
      }

      for (const mesh of meshes) {
        scene.add(mesh);
      }
      this.#splatMeshesByScene.set(scene, meshes);

      tile.engineData.scene = scene;
      tile.engineData.geometry = [];
      tile.engineData.materials = [];
      tile.engineData.textures = [];

      return scene;
    })();
  }

  calculateBytesUsed(_tile: TileWithEngineData, scene?: Group) {
    const meshes = scene && this.#splatMeshesByScene.get(scene);
    if (!meshes) {
      return 0;
    }

    let bytesUsed = 0;
    for (const mesh of meshes) {
      bytesUsed +=
        (mesh.splats?.getByteLength() ?? 0) *
        SPLAT_MEMORY_ESTIMATE_MULTIPLIER;
    }
    return bytesUsed;
  }
}
