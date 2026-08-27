import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  collectSplatOpacityBufferIndices,
  getSplatOpacityExtensionSource,
  loadSplatOpacityExtensionData,
  type SplatOpacityExtensionData,
  type SplatOpacityExtensionSource,
} from './GaussianSplatOpacityExtension';

const _translation = new Vector3();
const _rotation = new Quaternion();
const _scale = new Vector3();
const _identityMatrix = new Matrix4();
const _tempNodeMatrix = new Matrix4();
const _textDecoder = new TextDecoder();

export type GaussianBufferCollection = ReadonlyArray<Uint8Array | undefined>;

export type GlbData = {
  json: any;
  embeddedBuffer: Uint8Array | null;
};

type GaussianPrimitiveSpzSource = {
  bufferViewIndex: number;
  opacityExtensionSource: SplatOpacityExtensionSource | null;
};

type GaussianPrimitiveSpzData = {
  bytes: Uint8Array;
  opacityExtensionData: SplatOpacityExtensionData | null;
};

export type GaussianSplatPrimitiveSource = {
  data: GaussianPrimitiveSpzSource;
  matrix: Matrix4;
};

export type GaussianSplatPrimitiveDescriptor = {
  data: GaussianPrimitiveSpzData;
  matrix: Matrix4;
};

type BufferLoader = (
  url: string,
  abortSignal?: AbortSignal,
) => Promise<Uint8Array>;

export function parseGlb(buffer: ArrayBuffer): GlbData | null {
  if (buffer.byteLength < 20) {
    return null;
  }

  const headerView = new DataView(buffer);
  const magic = headerView.getUint32(0, true);
  if (magic !== 0x46546c67) {
    return null;
  }

  const version = headerView.getUint32(4, true);
  const length = headerView.getUint32(8, true);
  if (version !== 2 || length > buffer.byteLength) {
    throw new Error('GaussianSplatPlugin: Invalid GLB header.');
  }

  let offset = 12;
  let json: any = null;
  let embeddedBuffer: Uint8Array | null = null;

  while (offset + 8 <= length) {
    const chunkLength = headerView.getUint32(offset, true);
    const chunkType = headerView.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > length) {
      throw new Error('GaussianSplatPlugin: GLB chunk is truncated.');
    }

    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(
        _textDecoder.decode(new Uint8Array(buffer, chunkStart, chunkLength)),
      );
    } else if (chunkType === 0x004e4942 && embeddedBuffer === null) {
      embeddedBuffer = new Uint8Array(buffer, chunkStart, chunkLength);
    }

    offset = (chunkEnd + 3) & ~3; // 4-byte alignment per GLB spec
  }

  if (!json) {
    throw new Error('GaussianSplatPlugin: GLB JSON chunk not found.');
  }

  return {
    json,
    embeddedBuffer,
  };
}

export function parseGltfJson(buffer: ArrayBuffer) {
  return JSON.parse(_textDecoder.decode(buffer));
}

export async function resolveGltfBuffers(
  json: any,
  documentUri: string,
  requiredBufferIndices: readonly number[],
  loadBuffer: BufferLoader,
  abortSignal?: AbortSignal,
  embeddedBuffer: Uint8Array | null = null,
  optionalBufferIndices: readonly number[] = [],
) {
  const bufferDefinitions = json?.buffers ?? [];
  const buffers: (Uint8Array | undefined)[] = new Array(
    bufferDefinitions.length,
  );
  const embeddedBufferIndex =
    embeddedBuffer !== null
      ? bufferDefinitions.findIndex(
          (bufferDefinition: any) => !bufferDefinition?.uri,
        )
      : -1;
  const requiredIndexSet = new Set(requiredBufferIndices);
  const uniqueIndices = [
    ...new Set([...requiredBufferIndices, ...optionalBufferIndices]),
  ];

  await Promise.all(
    uniqueIndices.map(async (index) => {
      try {
        abortSignal?.throwIfAborted();

        const bufferDefinition = bufferDefinitions[index];
        if (!bufferDefinition) {
          throw new Error(`GaussianSplatPlugin: Missing buffer ${index}.`);
        }

        if (!bufferDefinition.uri) {
          if (index === embeddedBufferIndex && embeddedBuffer) {
            buffers[index] = embeddedBuffer;
            return;
          }

          throw new Error(
            `GaussianSplatPlugin: glTF buffer ${index} is missing a uri.`,
          );
        }

        const resolvedUri = /^data:/i.test(bufferDefinition.uri)
          ? bufferDefinition.uri
          : new URL(bufferDefinition.uri, documentUri).toString();

        buffers[index] = await loadBuffer(resolvedUri, abortSignal);
      } catch (error) {
        if (requiredIndexSet.has(index) || abortSignal?.aborted) {
          throw error;
        }
      }
    }),
  );

  return buffers;
}

function getBufferView(json: any, bufferViewIndex: number, label: string) {
  const bufferView = json.bufferViews?.[bufferViewIndex];
  if (!bufferView) {
    throw new Error(`GaussianSplatPlugin: Missing ${label} bufferView.`);
  }

  return bufferView;
}

function getGaussianPrimitiveSource(
  primitive: any,
): GaussianPrimitiveSpzSource | null {
  const gaussianExtension = primitive?.extensions?.KHR_gaussian_splatting;
  if (!gaussianExtension) {
    return null;
  }

  const compressionExtension =
    gaussianExtension.extensions?.KHR_gaussian_splatting_compression_spz_2;
  if (!compressionExtension) {
    throw new Error(
      'GaussianSplatPlugin: Raw gaussian splat primitives are no longer supported. Use KHR_gaussian_splatting_compression_spz_2.',
    );
  }

  return {
    bufferViewIndex: compressionExtension.bufferView,
    opacityExtensionSource: getSplatOpacityExtensionSource(
      primitive,
      gaussianExtension,
    ),
  };
}

function loadGaussianPrimitiveData(
  json: any,
  buffers: GaussianBufferCollection,
  source: GaussianPrimitiveSpzSource,
) {
  const { bufferViewIndex, opacityExtensionSource } = source;
  const bufferView = getBufferView(json, bufferViewIndex, 'SPZ');
  const bufferIndex = bufferView.buffer ?? 0;
  const binaryChunk = buffers[bufferIndex];
  if (!binaryChunk) {
    throw new Error(
      `GaussianSplatPlugin: Missing buffer ${bufferIndex} for SPZ data.`,
    );
  }

  const byteOffset = bufferView.byteOffset ?? 0;
  const byteLength = bufferView.byteLength ?? 0;
  const byteEnd = byteOffset + byteLength;
  if (byteEnd > binaryChunk.byteLength) {
    throw new Error('GaussianSplatPlugin: SPZ bufferView is truncated.');
  }

  return {
    bytes: binaryChunk.subarray(byteOffset, byteEnd),
    opacityExtensionData: loadSplatOpacityExtensionData(
      json,
      buffers,
      opacityExtensionSource,
    ),
  };
}

export function collectGaussianBufferIndices(
  json: any,
  sources: readonly GaussianSplatPrimitiveSource[],
) {
  const requiredBufferIndices = new Set<number>();
  const optionalBufferIndices = new Set<number>();

  for (const source of sources) {
    const spzBufferView = getBufferView(
      json,
      source.data.bufferViewIndex,
      'SPZ',
    );
    requiredBufferIndices.add(spzBufferView.buffer ?? 0);

    for (const bufferIndex of collectSplatOpacityBufferIndices(
      json,
      source.data.opacityExtensionSource,
    )) {
      if (source.data.opacityExtensionSource?.version === 2) {
        optionalBufferIndices.add(bufferIndex);
      } else {
        requiredBufferIndices.add(bufferIndex);
      }
    }
  }

  for (const bufferIndex of requiredBufferIndices) {
    optionalBufferIndices.delete(bufferIndex);
  }
  return {
    required: [...requiredBufferIndices],
    optional: [...optionalBufferIndices],
  };
}

function getNodeMatrix(node: any, target: Matrix4) {
  if (node.matrix) {
    target.fromArray(node.matrix);
    return target;
  }

  const t = (node.translation ?? [0, 0, 0]) as [number, number, number];
  const r = (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number];
  const s = (node.scale ?? [1, 1, 1]) as [number, number, number];
  _translation.set(...t);
  _rotation.set(...r);
  _scale.set(...s);
  return target.compose(_translation, _rotation, _scale);
}

function appendNodeDescriptors(
  json: any,
  nodeIndex: number,
  parentMatrix: Matrix4,
  descriptors: GaussianSplatPrimitiveSource[],
) {
  const node = json.nodes?.[nodeIndex];
  if (!node) {
    return;
  }

  const nodeMatrix = getNodeMatrix(node, _tempNodeMatrix);
  const cumulativeMatrix = new Matrix4().multiplyMatrices(
    parentMatrix,
    nodeMatrix,
  );

  if (node.mesh !== undefined) {
    const mesh = json.meshes?.[node.mesh];
    if (!mesh) {
      throw new Error(`GaussianSplatPlugin: Missing mesh ${node.mesh}.`);
    }

    for (let i = 0; i < mesh.primitives.length; i++) {
      const primitive = mesh.primitives[i];
      const data = getGaussianPrimitiveSource(primitive);
      if (data === null) {
        continue;
      }

      descriptors.push({
        data,
        matrix: cumulativeMatrix,
      });
    }
  }

  for (const childIndex of node.children ?? []) {
    appendNodeDescriptors(json, childIndex, cumulativeMatrix, descriptors);
  }
}

export function buildGaussianPrimitiveSources(json: any) {
  const sceneIndex = json.scene ?? 0;
  const sceneDefinition = json.scenes?.[sceneIndex];
  if (!sceneDefinition) {
    return null;
  }

  const descriptors: GaussianSplatPrimitiveSource[] = [];
  for (const nodeIndex of sceneDefinition.nodes ?? []) {
    appendNodeDescriptors(json, nodeIndex, _identityMatrix, descriptors);
  }

  return descriptors.length > 0 ? descriptors : null;
}

export function buildGaussianDescriptors(
  json: any,
  buffers: GaussianBufferCollection,
  sources: readonly GaussianSplatPrimitiveSource[],
) {
  return sources.map((source) => ({
    data: loadGaussianPrimitiveData(json, buffers, source.data),
    matrix: source.matrix,
  }));
}
