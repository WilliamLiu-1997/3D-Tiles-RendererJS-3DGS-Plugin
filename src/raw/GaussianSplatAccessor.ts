import type { GaussianBufferCollection } from '../GaussianSplatLoader';

export type Accessor = {
  count: number;
  itemSize: number;
  get(index: number, component: number): number;
};

export function getAccessorDefinition(json: any, index: number) {
  const accessor = json.accessors?.[index];
  if (!Number.isSafeInteger(index) || index < 0 || !accessor) {
    throw new Error(
      `GaussianSplatPlugin: Missing Gaussian accessor ${index}.`,
    );
  }
  return accessor;
}

export function getBufferView(json: any, index: number) {
  const view = json.bufferViews?.[index];
  if (!Number.isSafeInteger(index) || index < 0 || !view) {
    throw new Error(
      `GaussianSplatPlugin: Missing Gaussian bufferView ${index}.`,
    );
  }
  if (
    view.extensions?.EXT_meshopt_compression ||
    view.extensions?.KHR_meshopt_compression
  ) {
    throw new Error(
      'GaussianSplatPlugin: Meshopt-compressed Gaussian buffers are not supported.',
    );
  }
  return view;
}

export function getComponentByteSize(componentType: number) {
  return componentType === 5120 || componentType === 5121
    ? 1
    : componentType === 5122 || componentType === 5123
      ? 2
      : 4;
}

function readElements(
  json: any,
  buffers: GaussianBufferCollection,
  bufferViewIndex: number,
  byteOffset: number,
  count: number,
  itemSize: number,
  componentType: number,
  normalized: boolean,
): Accessor {
  const view = getBufferView(json, bufferViewIndex);
  const buffer = buffers[view.buffer];
  const declaredLength = json.buffers?.[view.buffer]?.byteLength;
  const componentBytes = getComponentByteSize(componentType);
  const elementBytes = itemSize * componentBytes;
  const stride = view.byteStride ?? elementBytes;
  const viewOffset = view.byteOffset ?? 0;
  const end = byteOffset + (count - 1) * stride + elementBytes;
  if (
    !buffer ||
    ![
      viewOffset,
      view.byteLength,
      declaredLength,
      byteOffset,
      stride,
      end,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    stride < elementBytes ||
    stride % componentBytes !== 0 ||
    viewOffset % componentBytes !== 0 ||
    byteOffset % componentBytes !== 0 ||
    end > view.byteLength ||
    viewOffset + view.byteLength > declaredLength ||
    viewOffset + view.byteLength > buffer.byteLength
  ) {
    throw new Error(
      'GaussianSplatPlugin: Invalid or truncated Gaussian accessor buffer.',
    );
  }
  const data = new DataView(
    buffer.buffer,
    buffer.byteOffset + viewOffset,
    view.byteLength,
  );
  let read: (offset: number) => number;
  switch (componentType) {
    case 5120:
      read = normalized
        ? (offset) => Math.max(data.getInt8(offset) / 127, -1)
        : (offset) => data.getInt8(offset);
      break;
    case 5121:
      read = normalized
        ? (offset) => data.getUint8(offset) / 255
        : (offset) => data.getUint8(offset);
      break;
    case 5122:
      read = normalized
        ? (offset) => Math.max(data.getInt16(offset, true) / 32767, -1)
        : (offset) => data.getInt16(offset, true);
      break;
    case 5123:
      read = normalized
        ? (offset) => data.getUint16(offset, true) / 65535
        : (offset) => data.getUint16(offset, true);
      break;
    case 5125:
      read = (offset) => data.getUint32(offset, true);
      break;
    case 5126:
      read = (offset) => data.getFloat32(offset, true);
      break;
    default:
      throw new Error(
        `GaussianSplatPlugin: Unsupported accessor componentType ${componentType}.`,
      );
  }
  return {
    count,
    itemSize,
    get: (index, component) =>
      read(byteOffset + index * stride + component * componentBytes),
  };
}

export function loadAccessor(
  json: any,
  buffers: GaussianBufferCollection,
  index: number,
  sizes: readonly number[],
): Accessor {
  const definition = getAccessorDefinition(json, index);
  const itemSize = (
    { SCALAR: 1, VEC3: 3, VEC4: 4 } as Record<string, number>
  )[definition.type];
  const { count, componentType, sparse } = definition;
  if (
    !sizes.includes(itemSize) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    ![5120, 5121, 5122, 5123, 5125, 5126].includes(componentType) ||
    (definition.normalized &&
      (componentType === 5125 || componentType === 5126))
  ) {
    throw new Error(
      `GaussianSplatPlugin: Invalid Gaussian accessor ${index}.`,
    );
  }
  let accessor: Accessor =
    definition.bufferView === undefined
      ? { count, itemSize, get: () => 0 }
      : readElements(
          json,
          buffers,
          definition.bufferView,
          definition.byteOffset ?? 0,
          count,
          itemSize,
          componentType,
          definition.normalized === true,
        );
  if (sparse) {
    if (
      !Number.isSafeInteger(sparse.count) ||
      sparse.count < 1 ||
      sparse.count > count ||
      ![5121, 5123, 5125].includes(sparse.indices.componentType)
    ) {
      throw new Error(
        `GaussianSplatPlugin: Invalid sparse accessor ${index}.`,
      );
    }
    const indices = readElements(
      json,
      buffers,
      sparse.indices.bufferView,
      sparse.indices.byteOffset ?? 0,
      sparse.count,
      1,
      sparse.indices.componentType,
      false,
    );
    const values = readElements(
      json,
      buffers,
      sparse.values.bufferView,
      sparse.values.byteOffset ?? 0,
      sparse.count,
      itemSize,
      componentType,
      definition.normalized === true,
    );
    const expanded =
      componentType === 5126
        ? new Float32Array(count * itemSize)
        : new Float64Array(count * itemSize);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < itemSize; c++)
        expanded[i * itemSize + c] = accessor.get(i, c);
    }
    let previous = -1;
    for (let i = 0; i < sparse.count; i++) {
      const target = indices.get(i, 0);
      if (target <= previous || target >= count) {
        throw new Error(
          `GaussianSplatPlugin: Invalid sparse index in accessor ${index}.`,
        );
      }
      for (let c = 0; c < itemSize; c++)
        expanded[target * itemSize + c] = values.get(i, c);
      previous = target;
    }
    accessor = { count, itemSize, get: (i, c) => expanded[i * itemSize + c] };
  }
  return accessor;
}
