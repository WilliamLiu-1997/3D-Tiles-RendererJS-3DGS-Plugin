import { toHalf, type ExtSplats } from '@sparkjsdev/spark';

const SPLAT_OPACITY_EXTENSION_NAME = 'EXT_splat_opacity';
const GL_FLOAT = 5126;
const FLOAT_BYTE_SIZE = 4;

type GaussianBufferCollection = ReadonlyArray<Uint8Array | undefined>;

export type SplatOpacityAccessorSource = {
  buffer: Uint8Array;
  byteOffset: number;
  count: number;
  byteStride: number;
  directView?: Float32Array;
};

function getBufferView(json: any, bufferViewIndex: number, label: string) {
  const bufferView = json.bufferViews?.[bufferViewIndex];
  if (!bufferView) {
    throw new Error(`GaussianSplatPlugin: Missing ${label} bufferView.`);
  }

  return bufferView;
}

function getOpacityAccessor(json: any, accessorIndex: number) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) {
    throw new Error(
      `GaussianSplatPlugin: Missing opacity accessor ${accessorIndex}.`,
    );
  }

  return accessor;
}

export function getSplatOpacityAccessorIndex(
  primitive: any,
  gaussianExtension: any,
) {
  const opacityExtension =
    gaussianExtension.extensions?.[SPLAT_OPACITY_EXTENSION_NAME] ??
    primitive?.extensions?.[SPLAT_OPACITY_EXTENSION_NAME];

  if (!opacityExtension) {
    return null;
  }

  const opacityAccessor = opacityExtension.opacityAccessor;
  if (opacityAccessor === undefined) {
    return null;
  }

  if (!Number.isInteger(opacityAccessor) || opacityAccessor < 0) {
    throw new Error(
      `GaussianSplatPlugin: ${SPLAT_OPACITY_EXTENSION_NAME}.opacityAccessor must be a non-negative integer.`,
    );
  }

  return opacityAccessor;
}

export function getSplatOpacityBufferIndex(json: any, accessorIndex: number) {
  const accessor = getOpacityAccessor(json, accessorIndex);
  const bufferView = getBufferView(json, accessor.bufferView, 'opacity');
  return bufferView.buffer ?? 0;
}

export function loadSplatOpacityAccessorSource(
  json: any,
  buffers: GaussianBufferCollection,
  accessorIndex: number,
): SplatOpacityAccessorSource {
  const accessor = getOpacityAccessor(json, accessorIndex);
  if (accessor.sparse) {
    throw new Error(
      'GaussianSplatPlugin: Sparse opacity accessors are not supported.',
    );
  }
  if (accessor.componentType !== GL_FLOAT || accessor.type !== 'SCALAR') {
    throw new Error(
      'GaussianSplatPlugin: splat opacityAccessor must be FLOAT SCALAR.',
    );
  }

  const bufferViewIndex = accessor.bufferView;
  const bufferView = getBufferView(json, bufferViewIndex, 'opacity');
  const bufferIndex = bufferView.buffer ?? 0;
  const binaryChunk = buffers[bufferIndex];
  if (!binaryChunk) {
    throw new Error(
      `GaussianSplatPlugin: Missing buffer ${bufferIndex} for opacity accessor.`,
    );
  }

  const count = accessor.count ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      'GaussianSplatPlugin: opacity accessor count must be a non-negative integer.',
    );
  }
  if (count === 0) {
    return {
      buffer: binaryChunk,
      byteOffset: 0,
      count,
      byteStride: FLOAT_BYTE_SIZE,
    };
  }

  const bufferViewByteOffset = bufferView.byteOffset ?? 0;
  const bufferViewByteLength = bufferView.byteLength ?? 0;
  const accessorByteOffset = accessor.byteOffset ?? 0;
  const byteStride = bufferView.byteStride ?? FLOAT_BYTE_SIZE;
  if (byteStride < FLOAT_BYTE_SIZE) {
    throw new Error(
      `GaussianSplatPlugin: opacity accessor byteStride must be at least ${FLOAT_BYTE_SIZE}.`,
    );
  }

  const byteLength = (count - 1) * byteStride + FLOAT_BYTE_SIZE;
  const accessorEndInView = accessorByteOffset + byteLength;
  if (accessorEndInView > bufferViewByteLength) {
    throw new Error('GaussianSplatPlugin: opacity accessor is truncated.');
  }

  const byteOffset = bufferViewByteOffset + accessorByteOffset;
  const byteEnd = byteOffset + byteLength;
  if (byteEnd > binaryChunk.byteLength) {
    throw new Error('GaussianSplatPlugin: opacity buffer is truncated.');
  }

  let directView: Float32Array | undefined;
  if (
    byteStride === FLOAT_BYTE_SIZE &&
    (binaryChunk.byteOffset + byteOffset) % FLOAT_BYTE_SIZE === 0
  ) {
    directView = new Float32Array(
      binaryChunk.buffer,
      binaryChunk.byteOffset + byteOffset,
      count,
    );
  }

  return {
    buffer: binaryChunk,
    byteOffset,
    count,
    byteStride,
    directView,
  };
}

export function applySplatOpacityOverride(
  extSplats: ExtSplats,
  opacitySource: SplatOpacityAccessorSource | null,
) {
  if (!opacitySource) {
    return;
  }

  const extA = extSplats.extArrays?.[0];
  if (!extA) {
    return;
  }

  const count = Math.min(
    opacitySource.count,
    extSplats.numSplats,
    Math.floor(extA.length / 4),
  );
  if (count <= 0) {
    return;
  }

  let didUpdate = false;
  const directView = opacitySource.directView;
  if (directView) {
    for (let i = 0, offset = 3; i < count; i++, offset += 4) {
      const opacity = directView[i];
      if (!(opacity >= 0 && opacity < Infinity)) {
        continue;
      }

      // Spark packs opacity into the low 16 bits of word i*4+3.
      extA[offset] = toHalf(opacity);
      didUpdate = true;
    }
  } else {
    const byteLength = (count - 1) * opacitySource.byteStride + FLOAT_BYTE_SIZE;
    const dataView = new DataView(
      opacitySource.buffer.buffer,
      opacitySource.buffer.byteOffset + opacitySource.byteOffset,
      byteLength,
    );
    for (let i = 0, offset = 3; i < count; i++, offset += 4) {
      const opacity = dataView.getFloat32(i * opacitySource.byteStride, true);
      if (!(opacity >= 0 && opacity < Infinity)) {
        continue;
      }

      extA[offset] = toHalf(opacity);
      didUpdate = true;
    }
  }

  if (didUpdate && extSplats.textures?.[0]) {
    extSplats.textures[0].needsUpdate = true;
  }
}
