import type { GaussianBufferCollection } from '../GaussianSplatLoader';
import {
  getAccessorDefinition,
  getBufferView,
  getComponentByteSize,
  loadAccessor,
  type Accessor,
} from './GaussianSplatAccessor';

const ATTRIBUTE_PREFIX = 'KHR_gaussian_splatting:';
const SH_C0 = 0.2820947917738781;
// Keep zero/one opacity and zero scales finite in PLY.
const MAX_OPACITY_LOGIT = 20;
const MIN_LOG_SCALE = -30;

function linearToSrgb(value: number) {
  // Match Three.js Color.convertLinearToSRGB.
  return value < 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 0.41666) - 0.055;
}

export type GaussianPrimitiveRawSource = {
  kind: 'raw';
  attributes: Record<string, number>;
  sh: number[];
  indices?: number;
};

export type GaussianPrimitiveRawData = {
  count: number;
  position: Accessor;
  rotation: Accessor;
  scale: Accessor;
  color?: Accessor;
  opacity?: Accessor;
  sh0?: Accessor;
  sh: Accessor[];
  indices?: Accessor;
};

export function getRawGaussianSource(
  primitive: any,
  extension: any,
): GaussianPrimitiveRawSource {
  if (primitive.mode !== 0) {
    throw new Error(
      'GaussianSplatPlugin: Gaussian primitives must use POINTS.',
    );
  }
  if (
    Object.keys(extension.extensions ?? {}).some((name) =>
      name.includes('compression'),
    ) ||
    primitive.extensions?.KHR_draco_mesh_compression
  ) {
    throw new Error(
      'GaussianSplatPlugin: Unsupported Gaussian compression extension.',
    );
  }
  for (const [property, supported] of [
    ['kernel', 'ellipse'],
    ['projection', 'perspective'],
    ['sortingMethod', 'cameraDistance'],
    ['colorSpace', 'srgb_rec709_display'],
  ]) {
    if (
      extension[property] !== undefined &&
      extension[property] !== supported
    ) {
      throw new Error(
        `GaussianSplatPlugin: Unsupported Gaussian ${property}: ${extension[property]}.`,
      );
    }
  }

  const input = primitive.attributes ?? {};
  const gaussianAttribute = (name: string) =>
    input[ATTRIBUTE_PREFIX + name] ?? input[`_${name}`];
  const attributes: Record<string, number> = {};
  const requireAttribute = (name: string, index: number | undefined) => {
    if (index === undefined) {
      throw new Error(
        `GaussianSplatPlugin: Missing Gaussian ${name} attribute.`,
      );
    }
    attributes[name] = index;
  };
  requireAttribute('POSITION', input.POSITION);
  requireAttribute('ROTATION', gaussianAttribute('ROTATION'));
  requireAttribute('SCALE', gaussianAttribute('SCALE'));

  const opacity = gaussianAttribute('OPACITY');
  const sh0 = gaussianAttribute('SH_DEGREE_0_COEF_0');
  if (opacity !== undefined || sh0 !== undefined) {
    requireAttribute('OPACITY', opacity);
    requireAttribute('SH_DEGREE_0_COEF_0', sh0);
  } else {
    // Legacy COLOR_0 combines diffuse RGB and opacity.
    requireAttribute('COLOR_0', input.COLOR_0);
  }

  const sh: number[] = [];
  for (let degree = 1; degree <= 3; degree++) {
    const coefficients = Array.from({ length: 2 * degree + 1 }, (_, index) =>
      gaussianAttribute(`SH_DEGREE_${degree}_COEF_${index}`),
    );
    if (coefficients.every((index) => index === undefined)) continue;
    if (
      coefficients.some((index) => index === undefined) ||
      sh.length !== degree * degree - 1
    ) {
      throw new Error(
        'GaussianSplatPlugin: SH degrees must include every coefficient and all lower degrees.',
      );
    }
    sh.push(...coefficients);
  }

  return { kind: 'raw', attributes, sh, indices: primitive.indices };
}

export function collectRawGaussianBufferViewIndices(
  json: any,
  source: GaussianPrimitiveRawSource,
) {
  const views = new Set<number>();
  const indices = [...Object.values(source.attributes), ...source.sh];
  if (source.indices !== undefined) indices.push(source.indices);
  for (const index of indices) {
    const accessor = getAccessorDefinition(json, index);
    const accessorViews = [
      [accessor.bufferView, accessor.byteOffset ?? 0, accessor.componentType],
    ];
    if (accessor.sparse) {
      const { indices, values } = accessor.sparse;
      accessorViews.push(
        [indices.bufferView, indices.byteOffset ?? 0, indices.componentType],
        [values.bufferView, values.byteOffset ?? 0, accessor.componentType],
      );
    }
    for (const [viewIndex, byteOffset, componentType] of accessorViews) {
      if (viewIndex === undefined) continue;

      const view = getBufferView(json, viewIndex);
      const componentBytes = getComponentByteSize(componentType);
      // Validate before Worker copies reset each bufferView's byteOffset.
      if (
        (view.byteOffset ?? 0) % componentBytes !== 0 ||
        byteOffset % componentBytes !== 0
      ) {
        throw new Error(
          'GaussianSplatPlugin: Gaussian accessor offsets must be component-aligned.',
        );
      }
      views.add(viewIndex);
    }
  }
  return views;
}

export function collectRawGaussianBufferIndices(
  json: any,
  source: GaussianPrimitiveRawSource,
) {
  const buffers = new Set<number>();
  for (const view of collectRawGaussianBufferViewIndices(json, source)) {
    buffers.add(json.bufferViews[view].buffer);
  }
  return buffers;
}

export function loadRawGaussianData(
  json: any,
  buffers: GaussianBufferCollection,
  source: GaussianPrimitiveRawSource,
): GaussianPrimitiveRawData {
  const position = loadAccessor(
    json,
    buffers,
    source.attributes.POSITION,
    [3],
  );
  const loadAttribute = (index: number, sizes: readonly number[]) => {
    const accessor = loadAccessor(json, buffers, index, sizes);
    if (accessor.count !== position.count) {
      throw new Error(
        'GaussianSplatPlugin: Gaussian attribute counts must match POSITION.',
      );
    }
    return accessor;
  };
  const optionalAttribute = (name: string, sizes: readonly number[]) =>
    source.attributes[name] === undefined
      ? undefined
      : loadAttribute(source.attributes[name], sizes);
  let indices: Accessor | undefined;
  if (source.indices !== undefined) {
    const definition = getAccessorDefinition(json, source.indices);
    if (
      ![5121, 5123, 5125].includes(definition.componentType) ||
      definition.normalized
    ) {
      throw new Error(
        'GaussianSplatPlugin: Gaussian indices must be unsigned integers.',
      );
    }
    indices = loadAccessor(json, buffers, source.indices, [1]);
  }
  return {
    count: indices?.count ?? position.count,
    position,
    rotation: loadAttribute(source.attributes.ROTATION, [4]),
    scale: loadAttribute(source.attributes.SCALE, [3]),
    color: optionalAttribute('COLOR_0', [3, 4]),
    opacity: optionalAttribute('OPACITY', [1]),
    sh0: optionalAttribute('SH_DEGREE_0_COEF_0', [3]),
    sh: source.sh.map((index) => loadAttribute(index, [3])),
    indices,
  };
}

export function encodeRawGaussianPly(data: GaussianPrimitiveRawData) {
  const { position, rotation, scale, color, opacity, sh0, sh, indices } =
    data;
  const properties = [
    'x',
    'y',
    'z',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
    'opacity',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    ...Array.from({ length: sh.length * 3 }, (_, i) => `f_rest_${i}`),
  ];
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\n' +
      `element vertex ${data.count}\n` +
      properties.map((name) => `property float ${name}\n`).join('') +
      'end_header\n',
  );
  const bytes = new Uint8Array(
    header.byteLength + data.count * properties.length * 4,
  );
  bytes.set(header);
  const output = new DataView(bytes.buffer);
  let byteOffset = header.byteLength;
  const writeFloat = (value: number) => {
    output.setFloat32(byteOffset, value, true);
    byteOffset += 4;
  };
  for (let index = 0; index < data.count; index++) {
    const i = indices ? indices.get(index, 0) : index;
    if (i >= position.count) {
      throw new Error(
        'GaussianSplatPlugin: Gaussian index exceeds the attribute count.',
      );
    }
    for (let c = 0; c < 3; c++) writeFloat(position.get(i, c));
    // Gaussian PLY stores logarithmic scales and a w,x,y,z quaternion.
    for (let c = 0; c < 3; c++) {
      const value = scale.get(i, c);
      if (!(value >= 0 && value < Infinity)) {
        throw new Error(
          'GaussianSplatPlugin: Gaussian scale must be finite and non-negative.',
        );
      }
      writeFloat(Math.max(Math.log(value), MIN_LOG_SCALE));
    }
    writeFloat(rotation.get(i, 3));
    for (let c = 0; c < 3; c++) writeFloat(rotation.get(i, c));

    const alpha = opacity
      ? opacity.get(i, 0)
      : color!.itemSize === 4
        ? color!.get(i, 3)
        : 1;
    if (!(alpha >= 0 && alpha <= 1)) {
      throw new Error(
        'GaussianSplatPlugin: Gaussian opacity must be between 0 and 1.',
      );
    }
    const logit = Math.log(alpha / (1 - alpha));
    writeFloat(Math.min(Math.max(logit, -MAX_OPACITY_LOGIT), MAX_OPACITY_LOGIT));

    if (sh0) {
      for (let c = 0; c < 3; c++) writeFloat(sh0.get(i, c));
    } else {
      // COLOR_0 is linear RGB; PLY SH0 encodes the trained sRGB color.
      for (let c = 0; c < 3; c++) {
        writeFloat((linearToSrgb(color!.get(i, c)) - 0.5) / SH_C0);
      }
    }
    // PLY stores SH coefficients in channel order: R, G, B.
    for (let c = 0; c < 3; c++) {
      for (const coefficient of sh) writeFloat(coefficient.get(i, c));
    }
  }
  return bytes;
}
