import {
  postDecode,
  type SplatPostDecodeProgram,
} from 'gaussian-splat-lite';

const SPLAT_OPACITY_EXTENSION_NAME = 'EXT_splat_opacity';
const SPLAT_OPACITY_VERSION_2 = 2;
const SPLAT_OPACITY_SOURCE_ENCODING = 'float16';
const SPLAT_OPACITY_COVERAGE_BOOST_METHOD = 'opacity_anisotropic_v1';
const GL_UNSIGNED_SHORT = 5123;
const GL_FLOAT = 5126;
const UNSIGNED_SHORT_BYTE_SIZE = 2;
const FLOAT_BYTE_SIZE = 4;
const MAX_COVERAGE_BOOST_OPACITY = 1000;
const MAX_POST_DECODE_COVERAGE_BOOST_SCALE =
  3.4028234663852886e38 / (Math.sqrt(MAX_COVERAGE_BOOST_OPACITY) - 1);
export const DEFAULT_TARGET_COVERAGE_BOOST_SCALE = 0.1;

type GaussianBufferCollection = ReadonlyArray<Uint8Array | undefined>;

type ScalarAccessorSource = {
  count: number;
  byteStride: number;
  dataView: DataView;
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
  return {
    count: definition.count,
    byteStride: definition.byteStride,
    dataView,
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

export function createSplatOpacityPostDecode(
  data: SplatOpacityExtensionData | null,
  targetCoverageBoostScale = DEFAULT_TARGET_COVERAGE_BOOST_SCALE,
): SplatPostDecodeProgram | undefined {
  if (!data) {
    return undefined;
  }

  if (data.version === 1) {
    return postDecode.define(({ attribute, op }) => {
      const opacity = attribute({
        data: data.opacitySource.dataView,
        format: 'f32',
        count: data.opacitySource.count,
        byteStride: data.opacitySource.byteStride,
      });
      const legacyKernelAmount = op.clamp(op.sub(opacity, 1), 0, 1);
      const legacyKernelShape = op.add(
        1,
        op.mul(4, legacyKernelAmount),
      );
      const semanticOpacity = op.select(
        op.gt(opacity, 1),
        op.min(
          op.exp(
            op.div(
              op.sub(op.mul(legacyKernelShape, legacyKernelShape), 1),
              Math.E,
            ),
          ),
          MAX_COVERAGE_BOOST_OPACITY,
        ),
        opacity,
      );
      return {
        when: op.and(op.isFinite(opacity), op.gte(opacity, 0)),
        opacity: semanticOpacity,
      };
    });
  }

  if (
    !Number.isFinite(targetCoverageBoostScale) ||
    targetCoverageBoostScale < 0
  ) {
    return undefined;
  }

  const retainedCoverageBoostScale = Math.min(
    data.coverageBoostScale,
    targetCoverageBoostScale,
  );
  const count = Math.min(
    data.sourceOpacitySource.count,
    data.coverageBoostRatioSource.count,
  );
  if (count === 0) {
    return undefined;
  }
  if (
    data.coverageBoostScale > MAX_POST_DECODE_COVERAGE_BOOST_SCALE
  ) {
    throw new Error(
      'GaussianSplatPlugin: Coverage boost scale exceeds the postDecode expression range.',
    );
  }

  return postDecode.define(({ splat, attribute, op }) => {
    const sourceOpacity = attribute({
      data: data.sourceOpacitySource.dataView,
      format: 'f16',
      count,
      byteStride: data.sourceOpacitySource.byteStride,
    });

    const opacityFactor = op.sub(
      op.sqrt(op.min(sourceOpacity, MAX_COVERAGE_BOOST_OPACITY)),
      1,
    );
    const targetBoost = op.mul(retainedCoverageBoostScale, opacityFactor);
    const targetRest = op.add(1, targetBoost);
    const rawDisplayOpacity = op.div(
      sourceOpacity,
      op.mul(targetRest, targetRest),
    );
    const active = op.and(
      op.gt(sourceOpacity, 1),
      op.lte(sourceOpacity, MAX_COVERAGE_BOOST_OPACITY),
    );

    const patch = {
      when: active,
      opacity: rawDisplayOpacity,
    };
    if (
      Math.fround(retainedCoverageBoostScale) ===
      Math.fround(data.coverageBoostScale)
    ) {
      return patch;
    }

    const coverageBoostRatio = attribute({
      data: data.coverageBoostRatioSource.dataView,
      format: 'unorm16',
      count,
      byteStride: data.coverageBoostRatioSource.byteStride,
    });
    const fileBoost = op.mul(data.coverageBoostScale, opacityFactor);
    const fileRest = op.add(1, fileBoost);
    const restScaleMultiplier = op.div(targetRest, fileRest);
    const ratioFactor = op.div(
      coverageBoostRatio,
      op.add(
        op.sub(1, coverageBoostRatio),
        op.mul(coverageBoostRatio, coverageBoostRatio),
      ),
    );
    const fileTop = op.add(1, op.mul(fileBoost, ratioFactor));
    const targetTop = op.add(1, op.mul(targetBoost, ratioFactor));
    const topScaleMultiplier = op.div(targetTop, fileTop);

    const largestAxis = op.maxComponentIndex(splat.scale);
    const updatedScale = op.mul(
      splat.scale,
      op.vec3(
        op.select(
          op.eq(largestAxis, 0),
          topScaleMultiplier,
          restScaleMultiplier,
        ),
        op.select(
          op.eq(largestAxis, 1),
          topScaleMultiplier,
          restScaleMultiplier,
        ),
        op.select(
          op.eq(largestAxis, 2),
          topScaleMultiplier,
          restScaleMultiplier,
        ),
      ),
    );
    const scaleIsValid = op.and(
      op.isFinite(updatedScale),
      op.gt(op.component(updatedScale, 0), 0),
      op.gt(op.component(updatedScale, 1), 0),
      op.gt(op.component(updatedScale, 2), 0),
    );

    return {
      ...patch,
      when: op.and(active, scaleIsValid),
      scale: updatedScale,
    };
  });
}
