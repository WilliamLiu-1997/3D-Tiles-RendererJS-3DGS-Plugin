import { fromHalf, toHalf } from '@sparkjsdev/spark';

const SPLAT_OPACITY_EXTENSION_NAME = 'EXT_splat_opacity';
const SPLAT_OPACITY_VERSION_2 = 2;
const SPLAT_OPACITY_SOURCE_ENCODING = 'float16';
const SPLAT_OPACITY_COVERAGE_BOOST_METHOD = 'opacity_anisotropic_v1';
const GL_UNSIGNED_SHORT = 5123;
const GL_FLOAT = 5126;
const UNSIGNED_SHORT_BYTE_SIZE = 2;
const FLOAT_BYTE_SIZE = 4;
const UINT16_MAX = 65535;
const FLOAT16_MAX = 65504;
const MAX_COVERAGE_BOOST_OPACITY = 1000;
export const DEFAULT_TARGET_COVERAGE_BOOST_SCALE = 0.1;
const MIN_SPARK_LOD_OPACITY = 0.000001;
const MAX_SPARK_LOD_OPACITY = 1000;

type GaussianBufferCollection = ReadonlyArray<Uint8Array | undefined>;

type ScalarAccessorSource = {
  count: number;
  byteStride: number;
  dataView: DataView;
  directFloatView?: Float32Array;
};

export type SplatOpacityExtensionSource =
  | {
      version: 1;
      opacityAccessorIndex: number;
    }
  | {
      version: 2;
      sourceOpacityAccessorIndex: number;
      coverageBoostRatioAccessorIndex: number;
      coverageBoostScale: number;
    };

export type SplatOpacityExtensionData =
  | {
      version: 1;
      opacitySource: ScalarAccessorSource;
    }
  | {
      version: 2;
      sourceOpacitySource: ScalarAccessorSource;
      coverageBoostRatioSource: ScalarAccessorSource;
      coverageBoostScale: number;
    };

type ScalarAccessorRequirements = {
  componentType: number;
  componentByteSize: number;
  normalized: boolean;
  label: string;
  legacyByteLayout?: boolean;
};

const V1_OPACITY_ACCESSOR_REQUIREMENTS: ScalarAccessorRequirements = {
  componentType: GL_FLOAT,
  componentByteSize: FLOAT_BYTE_SIZE,
  normalized: false,
  label: 'opacity',
  legacyByteLayout: true,
};

const V2_SOURCE_OPACITY_ACCESSOR_REQUIREMENTS: ScalarAccessorRequirements = {
  componentType: GL_UNSIGNED_SHORT,
  componentByteSize: UNSIGNED_SHORT_BYTE_SIZE,
  normalized: false,
  label: 'source opacity',
};

const V2_COVERAGE_RATIO_ACCESSOR_REQUIREMENTS: ScalarAccessorRequirements = {
  componentType: GL_UNSIGNED_SHORT,
  componentByteSize: UNSIGNED_SHORT_BYTE_SIZE,
  normalized: true,
  label: 'coverage boost ratio',
};

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function getBufferView(json: any, bufferViewIndex: unknown, label: string) {
  if (!isNonNegativeInteger(bufferViewIndex)) {
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor must reference a bufferView.`,
    );
  }

  const bufferView = json.bufferViews?.[bufferViewIndex];
  if (!bufferView) {
    throw new Error(`GaussianSplatPlugin: Missing ${label} bufferView.`);
  }

  return bufferView;
}

function getScalarAccessorDefinition(
  json: any,
  accessorIndex: number,
  requirements: ScalarAccessorRequirements,
) {
  const { componentType, componentByteSize, normalized, label } = requirements;
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) {
    throw new Error(
      `GaussianSplatPlugin: Missing ${label} accessor ${accessorIndex}.`,
    );
  }
  if (accessor.sparse) {
    throw new Error(
      `GaussianSplatPlugin: Sparse ${label} accessors are not supported.`,
    );
  }
  if (accessor.componentType !== componentType || accessor.type !== 'SCALAR') {
    const expectedComponent =
      componentType === GL_FLOAT ? 'FLOAT' : 'UNSIGNED_SHORT';
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor must be ${expectedComponent} SCALAR.`,
    );
  }
  if (
    normalized
      ? accessor.normalized !== true
      : accessor.normalized !== undefined && accessor.normalized !== false
  ) {
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor has an invalid normalized flag.`,
    );
  }

  const count = accessor.count ?? 0;
  if (!isNonNegativeInteger(count)) {
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor count must be a non-negative integer.`,
    );
  }

  const bufferView = getBufferView(json, accessor.bufferView, label);
  const bufferIndex = bufferView.buffer ?? 0;
  const bufferDefinition = json.buffers?.[bufferIndex];
  if (!isNonNegativeInteger(bufferIndex) || !bufferDefinition) {
    throw new Error(
      `GaussianSplatPlugin: Missing buffer ${String(bufferIndex)} for ${label} accessor.`,
    );
  }
  const declaredBufferByteLength = bufferDefinition.byteLength;
  if (!isNonNegativeInteger(declaredBufferByteLength)) {
    throw new Error(
      `GaussianSplatPlugin: Buffer ${bufferIndex} has an invalid byteLength.`,
    );
  }

  const bufferViewByteOffset = bufferView.byteOffset ?? 0;
  const bufferViewByteLength = bufferView.byteLength;
  const accessorByteOffset = accessor.byteOffset ?? 0;
  if (
    !isNonNegativeInteger(bufferViewByteOffset) ||
    !isNonNegativeInteger(bufferViewByteLength) ||
    !isNonNegativeInteger(accessorByteOffset)
  ) {
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor has invalid byte bounds.`,
    );
  }

  const declaredByteStride = bufferView.byteStride;
  let byteStride = componentByteSize;
  if (declaredByteStride !== undefined) {
    const invalidLegacyStride =
      requirements.legacyByteLayout === true &&
      (!Number.isSafeInteger(declaredByteStride) ||
        declaredByteStride < componentByteSize);
    const invalidGltfStride =
      requirements.legacyByteLayout !== true &&
      (!Number.isSafeInteger(declaredByteStride) ||
        declaredByteStride < 4 ||
        declaredByteStride > 252 ||
        declaredByteStride % 4 !== 0 ||
        declaredByteStride % componentByteSize !== 0);
    if (invalidLegacyStride || invalidGltfStride) {
      throw new Error(
        `GaussianSplatPlugin: ${label} accessor has an invalid byteStride.`,
      );
    }
    byteStride = declaredByteStride;
  }

  if (
    requirements.legacyByteLayout !== true &&
    (bufferViewByteOffset + accessorByteOffset) % componentByteSize !== 0
  ) {
    throw new Error(
      `GaussianSplatPlugin: ${label} accessor is not component-aligned.`,
    );
  }

  const byteLength =
    count === 0 ? 0 : (count - 1) * byteStride + componentByteSize;
  const accessorEndInView = accessorByteOffset + byteLength;
  const bufferViewEnd = bufferViewByteOffset + bufferViewByteLength;
  if (
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(accessorEndInView) ||
    accessorEndInView > bufferViewByteLength ||
    !Number.isSafeInteger(bufferViewEnd) ||
    bufferViewEnd > declaredBufferByteLength
  ) {
    throw new Error(`GaussianSplatPlugin: ${label} accessor is truncated.`);
  }

  return {
    accessorByteOffset,
    bufferIndex,
    bufferViewByteLength,
    bufferViewByteOffset,
    byteLength,
    byteStride,
    count,
  };
}

function loadScalarAccessorSource(
  json: any,
  buffers: GaussianBufferCollection,
  accessorIndex: number,
  requirements: ScalarAccessorRequirements,
): ScalarAccessorSource {
  const definition = getScalarAccessorDefinition(
    json,
    accessorIndex,
    requirements,
  );
  const binaryChunk = buffers[definition.bufferIndex];
  if (!binaryChunk) {
    throw new Error(
      `GaussianSplatPlugin: Missing buffer ${definition.bufferIndex} for ${requirements.label} accessor.`,
    );
  }

  const bufferViewEnd =
    definition.bufferViewByteOffset + definition.bufferViewByteLength;
  if (
    !Number.isSafeInteger(bufferViewEnd) ||
    bufferViewEnd > binaryChunk.byteLength
  ) {
    throw new Error(
      `GaussianSplatPlugin: ${requirements.label} bufferView is truncated.`,
    );
  }

  const byteOffset =
    definition.bufferViewByteOffset + definition.accessorByteOffset;
  const byteEnd = byteOffset + definition.byteLength;
  if (!Number.isSafeInteger(byteEnd) || byteEnd > binaryChunk.byteLength) {
    throw new Error(
      `GaussianSplatPlugin: ${requirements.label} buffer is truncated.`,
    );
  }

  const absoluteByteOffset = binaryChunk.byteOffset + byteOffset;
  const dataView = new DataView(
    binaryChunk.buffer,
    absoluteByteOffset,
    definition.byteLength,
  );
  let directFloatView: Float32Array | undefined;
  if (
    requirements.componentType === GL_FLOAT &&
    definition.byteStride === FLOAT_BYTE_SIZE &&
    absoluteByteOffset % FLOAT_BYTE_SIZE === 0
  ) {
    directFloatView = new Float32Array(
      binaryChunk.buffer,
      absoluteByteOffset,
      definition.count,
    );
  }

  return {
    count: definition.count,
    byteStride: definition.byteStride,
    dataView,
    directFloatView,
  };
}

function getExtensionObject(primitive: any, gaussianExtension: any) {
  const extension =
    gaussianExtension.extensions?.[SPLAT_OPACITY_EXTENSION_NAME] ??
    primitive?.extensions?.[SPLAT_OPACITY_EXTENSION_NAME];
  return extension && typeof extension === 'object' ? extension : null;
}

export function getSplatOpacityExtensionSource(
  primitive: any,
  gaussianExtension: any,
): SplatOpacityExtensionSource | null {
  const extension = getExtensionObject(primitive, gaussianExtension);
  if (!extension) {
    return null;
  }

  if (extension.version === undefined || extension.version === 1) {
    const opacityAccessorIndex = extension.opacityAccessor;
    if (opacityAccessorIndex === undefined) {
      return null;
    }
    if (!isNonNegativeInteger(opacityAccessorIndex)) {
      throw new Error(
        `GaussianSplatPlugin: ${SPLAT_OPACITY_EXTENSION_NAME}.opacityAccessor must be a non-negative integer.`,
      );
    }

    return {
      version: 1,
      opacityAccessorIndex,
    };
  }

  if (extension.version !== SPLAT_OPACITY_VERSION_2) {
    return null;
  }

  const sourceOpacityAccessorIndex = extension.sourceOpacityAccessor;
  const coverageBoostRatioAccessorIndex =
    extension.coverageBoostRatioAccessor;
  const coverageBoostScale = extension.coverageBoostScale;
  if (
    !isNonNegativeInteger(sourceOpacityAccessorIndex) ||
    extension.sourceOpacityEncoding !== SPLAT_OPACITY_SOURCE_ENCODING ||
    !isNonNegativeInteger(coverageBoostRatioAccessorIndex) ||
    extension.coverageBoostMethod !==
      SPLAT_OPACITY_COVERAGE_BOOST_METHOD ||
    typeof coverageBoostScale !== 'number' ||
    !Number.isFinite(coverageBoostScale) ||
    coverageBoostScale < 0
  ) {
    return null;
  }

  return {
    version: 2,
    sourceOpacityAccessorIndex,
    coverageBoostRatioAccessorIndex,
    coverageBoostScale,
  };
}

export function collectSplatOpacityBufferIndices(
  json: any,
  source: SplatOpacityExtensionSource | null,
) {
  if (!source) {
    return [];
  }

  if (source.version === 1) {
    const definition = getScalarAccessorDefinition(
      json,
      source.opacityAccessorIndex,
      V1_OPACITY_ACCESSOR_REQUIREMENTS,
    );
    return [definition.bufferIndex];
  }

  try {
    const sourceOpacityDefinition = getScalarAccessorDefinition(
      json,
      source.sourceOpacityAccessorIndex,
      V2_SOURCE_OPACITY_ACCESSOR_REQUIREMENTS,
    );
    const ratioDefinition = getScalarAccessorDefinition(
      json,
      source.coverageBoostRatioAccessorIndex,
      V2_COVERAGE_RATIO_ACCESSOR_REQUIREMENTS,
    );
    return [
      ...new Set([
        sourceOpacityDefinition.bufferIndex,
        ratioDefinition.bufferIndex,
      ]),
    ];
  } catch {
    return [];
  }
}

export function loadSplatOpacityExtensionData(
  json: any,
  buffers: GaussianBufferCollection,
  source: SplatOpacityExtensionSource | null,
): SplatOpacityExtensionData | null {
  if (!source) {
    return null;
  }

  if (source.version === 1) {
    return {
      version: 1,
      opacitySource: loadScalarAccessorSource(
        json,
        buffers,
        source.opacityAccessorIndex,
        V1_OPACITY_ACCESSOR_REQUIREMENTS,
      ),
    };
  }

  try {
    return {
      version: 2,
      sourceOpacitySource: loadScalarAccessorSource(
        json,
        buffers,
        source.sourceOpacityAccessorIndex,
        V2_SOURCE_OPACITY_ACCESSOR_REQUIREMENTS,
      ),
      coverageBoostRatioSource: loadScalarAccessorSource(
        json,
        buffers,
        source.coverageBoostRatioAccessorIndex,
        V2_COVERAGE_RATIO_ACCESSOR_REQUIREMENTS,
      ),
      coverageBoostScale: source.coverageBoostScale,
    };
  } catch {
    // Version 2 is optional. If its payload cannot be consumed then the SPZ
    // opacity and converter-boosted scales remain the interoperability fallback.
    return null;
  }
}

function readFloat32(source: ScalarAccessorSource, index: number) {
  return source.directFloatView
    ? source.directFloatView[index]
    : source.dataView.getFloat32(index * source.byteStride, true);
}

function readUint16(source: ScalarAccessorSource, index: number) {
  return source.dataView.getUint16(index * source.byteStride, true);
}

function writeSparkOpacity(
  extA: Uint32Array,
  wordIndex: number,
  opacity: number,
) {
  extA[wordIndex] = (extA[wordIndex] & 0xffff0000) | toHalf(opacity);
}

function applyVersion1Opacity(
  extA: Uint32Array,
  numSplats: number,
  opacitySource: ScalarAccessorSource,
) {
  const count = Math.min(
    opacitySource.count,
    numSplats,
    Math.floor(extA.length / 4),
  );
  let applied = false;
  for (let i = 0, wordIndex = 3; i < count; i++, wordIndex += 4) {
    const opacity = readFloat32(opacitySource, i);
    if (!(opacity >= 0 && opacity < Infinity)) {
      continue;
    }

    writeSparkOpacity(extA, wordIndex, opacity);
    applied = true;
  }
  return applied;
}

function encodeSparkDisplayOpacity(opacity: number) {
  if (opacity <= 1) {
    return opacity;
  }
  const clamped = Math.min(
    MAX_SPARK_LOD_OPACITY,
    Math.max(MIN_SPARK_LOD_OPACITY, opacity),
  );
  const lodOpacity = Math.sqrt(1 + Math.E * Math.log(clamped));
  return Math.min(2, Math.max(1, 1 + (lodOpacity - 1) / 4));
}

function getLargestScaleAxis(x: number, y: number, z: number) {
  if (x >= y && x >= z) {
    return 0;
  }
  return y >= z ? 1 : 2;
}

function getVersion2RetargetValues(
  sourceOpacity: number,
  ratio: number,
  fileCoverageBoostScale: number,
  targetCoverageBoostScale: number,
) {
  const opacityFactor =
    Math.sqrt(Math.min(sourceOpacity, MAX_COVERAGE_BOOST_OPACITY)) - 1;
  const fileRestFactor = 1 + fileCoverageBoostScale * opacityFactor;
  const targetRestFactor = 1 + targetCoverageBoostScale * opacityFactor;
  const ratioFactor = ratio / (1 - ratio + ratio * ratio);
  const fileTopFactor = 1 + (fileRestFactor - 1) * ratioFactor;
  const targetTopFactor = 1 + (targetRestFactor - 1) * ratioFactor;
  return {
    displayOpacity: encodeSparkDisplayOpacity(
      sourceOpacity / (targetRestFactor * targetRestFactor),
    ),
    restLogDelta: Math.log(targetRestFactor / fileRestFactor),
    topLogDelta: Math.log(targetTopFactor / fileTopFactor),
  };
}

function applyVersion2OpacityAndRetargetCoverageBoost(
  extArrays: [Uint32Array, Uint32Array],
  numSplats: number,
  data: Extract<SplatOpacityExtensionData, { version: 2 }>,
  targetCoverageBoostScale: number,
) {
  const [extA, extB] = extArrays;
  const count = Math.min(
    data.sourceOpacitySource.count,
    data.coverageBoostRatioSource.count,
    numSplats,
    Math.floor(extA.length / 4),
    Math.floor(extB.length / 4),
  );
  if (count <= 0) {
    return false;
  }

  const retainedCoverageBoostScale = Math.min(
    data.coverageBoostScale,
    targetCoverageBoostScale,
  );
  // Accessor structure and bounds were validated while loading. Calculate and
  // validate a complete splat update before writing it, so invalid values keep
  // the SPZ fallback without requiring a separate full-payload validation pass.
  let applied = false;
  for (let i = 0, base = 0; i < count; i++, base += 4) {
    const sourceOpacity = fromHalf(readUint16(data.sourceOpacitySource, i));
    if (
      !(sourceOpacity >= 0 && sourceOpacity < Infinity) ||
      sourceOpacity <= 1
    ) {
      continue;
    }

    const ratio =
      readUint16(data.coverageBoostRatioSource, i) / UINT16_MAX;
    const values = getVersion2RetargetValues(
      sourceOpacity,
      ratio,
      data.coverageBoostScale,
      retainedCoverageBoostScale,
    );
    if (
      !Number.isFinite(values.displayOpacity) ||
      !Number.isFinite(values.restLogDelta) ||
      !Number.isFinite(values.topLogDelta)
    ) {
      continue;
    }

    if (values.restLogDelta !== 0 || values.topLogDelta !== 0) {
      const scaleLogX = fromHalf(extB[base + 1] >>> 16);
      const scaleLogY = fromHalf(extB[base + 2] & UINT16_MAX);
      const scaleLogZ = fromHalf(extB[base + 2] >>> 16);
      const largestAxis = getLargestScaleAxis(
        scaleLogX,
        scaleLogY,
        scaleLogZ,
      );
      const updatedScaleLogX =
        scaleLogX +
        (largestAxis === 0 ? values.topLogDelta : values.restLogDelta);
      const updatedScaleLogY =
        scaleLogY +
        (largestAxis === 1 ? values.topLogDelta : values.restLogDelta);
      const updatedScaleLogZ =
        scaleLogZ +
        (largestAxis === 2 ? values.topLogDelta : values.restLogDelta);
      if (
        !Number.isFinite(updatedScaleLogX) ||
        !Number.isFinite(updatedScaleLogY) ||
        !Number.isFinite(updatedScaleLogZ) ||
        Math.abs(updatedScaleLogX) > FLOAT16_MAX ||
        Math.abs(updatedScaleLogY) > FLOAT16_MAX ||
        Math.abs(updatedScaleLogZ) > FLOAT16_MAX
      ) {
        continue;
      }

      const scaleX = toHalf(updatedScaleLogX);
      const scaleY = toHalf(updatedScaleLogY);
      const scaleZ = toHalf(updatedScaleLogZ);
      extB[base + 1] =
        (extB[base + 1] & 0x0000ffff) | (scaleX << 16);
      extB[base + 2] = scaleY | (scaleZ << 16);
    }

    writeSparkOpacity(extA, base + 3, values.displayOpacity);
    applied = true;
  }

  return applied;
}

export function applySplatOpacityExtensionToArrays(
  extArrays: [Uint32Array, Uint32Array],
  numSplats: number,
  data: SplatOpacityExtensionData | null,
  targetCoverageBoostScale = DEFAULT_TARGET_COVERAGE_BOOST_SCALE,
) {
  if (!data) {
    return false;
  }

  if (data.version === 1) {
    return applyVersion1Opacity(extArrays[0], numSplats, data.opacitySource);
  }

  if (
    !Number.isFinite(targetCoverageBoostScale) ||
    targetCoverageBoostScale < 0
  ) {
    return false;
  }

  return applyVersion2OpacityAndRetargetCoverageBoost(
    extArrays,
    numSplats,
    data,
    targetCoverageBoostScale,
  );
}
