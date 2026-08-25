import opacityRetargetWasmDataUrl from './opacity_retarget.wasm?url&inline';

type ScalarAccessorInput = {
  byteStride: number;
  dataView: DataView;
};

type OpacityRetargetWasmExports = {
  memory: WebAssembly.Memory;
  opacity_workspace_reserve(byteLength: number): number;
  opacity_retarget(
    splatAPointer: number,
    splatBPointer: number,
    sourceOpacityPointer: number,
    sourceOpacityStride: number,
    ratioPointer: number,
    ratioStride: number,
    count: number,
    fileScale: number,
    targetScale: number,
  ): void;
};

type MetadataCopy = {
  bytes: Uint8Array;
  ratioOffset: number;
  sourceOpacityOffset: number;
};

const alignToUint32 = (value: number) => Math.ceil(value / 4) * 4;

let wasmExportsPromise: Promise<OpacityRetargetWasmExports> | null = null;

function decodeEmbeddedWasm() {
  const separator = opacityRetargetWasmDataUrl.indexOf(',');
  const binary = atob(opacityRetargetWasmDataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getAccessorBytes(source: ScalarAccessorInput) {
  return new Uint8Array(
    source.dataView.buffer,
    source.dataView.byteOffset,
    source.dataView.byteLength,
  );
}

function getMetadataCopy(
  sourceOpacity: ScalarAccessorInput,
  ratio: ScalarAccessorInput,
): MetadataCopy | null {
  const sourceView = sourceOpacity.dataView;
  const ratioView = ratio.dataView;
  if (
    sourceView.buffer !== ratioView.buffer ||
    sourceOpacity.byteStride !== ratio.byteStride
  ) {
    return null;
  }

  const start = Math.min(sourceView.byteOffset, ratioView.byteOffset);
  const end = Math.max(
    sourceView.byteOffset + sourceView.byteLength,
    ratioView.byteOffset + ratioView.byteLength,
  );
  const byteLength = end - start;
  if (
    Math.abs(sourceView.byteOffset - ratioView.byteOffset) >=
      sourceOpacity.byteStride ||
    byteLength > sourceView.byteLength + ratioView.byteLength
  ) {
    return null;
  }

  return {
    bytes: new Uint8Array(sourceView.buffer, start, byteLength),
    sourceOpacityOffset: sourceView.byteOffset - start,
    ratioOffset: ratioView.byteOffset - start,
  };
}

async function loadOpacityRetargetWasm() {
  const result = await WebAssembly.instantiate(decodeEmbeddedWasm(), {});
  return result.instance.exports as OpacityRetargetWasmExports;
}

function getOpacityRetargetWasm() {
  wasmExportsPromise ??= loadOpacityRetargetWasm();
  return wasmExportsPromise;
}

export function preloadOpacityRetargetWasm() {
  void getOpacityRetargetWasm().catch(() => {
    // Avoid an unhandled preload rejection. The awaited processing path uses
    // the same cached promise and reports the initialization error.
  });
}

export async function applyVersion2OpacityRetargetWasm(
  splatArrays: [Uint32Array, Uint32Array],
  count: number,
  sourceOpacity: ScalarAccessorInput,
  ratio: ScalarAccessorInput,
  fileScale: number,
  targetScale: number,
) {
  const wasm = await getOpacityRetargetWasm();
  const [splatA, splatB] = splatArrays;
  const splatWordLength = count * 4;
  const splatByteLength = splatWordLength * Uint32Array.BYTES_PER_ELEMENT;
  const splatBOffset = splatByteLength;
  const metadataOffset = splatByteLength * 2;
  const metadataCopy = getMetadataCopy(sourceOpacity, ratio);

  let sourceOpacityOffset: number;
  let ratioOffset: number;
  let workspaceByteLength: number;
  let sourceOpacityBytes: Uint8Array | null = null;
  let ratioBytes: Uint8Array | null = null;
  if (metadataCopy) {
    sourceOpacityOffset = metadataOffset + metadataCopy.sourceOpacityOffset;
    ratioOffset = metadataOffset + metadataCopy.ratioOffset;
    workspaceByteLength = metadataOffset + metadataCopy.bytes.byteLength;
  } else {
    sourceOpacityBytes = getAccessorBytes(sourceOpacity);
    ratioBytes = getAccessorBytes(ratio);
    sourceOpacityOffset = metadataOffset;
    ratioOffset = alignToUint32(
      sourceOpacityOffset + sourceOpacityBytes.byteLength,
    );
    workspaceByteLength = ratioOffset + ratioBytes.byteLength;
  }
  if (
    !Number.isSafeInteger(workspaceByteLength) ||
    workspaceByteLength > 0xffff_ffff
  ) {
    throw new Error('GaussianSplatPlugin: Opacity WASM workspace is too large.');
  }

  const workspace = wasm.opacity_workspace_reserve(workspaceByteLength) >>> 0;
  if (workspace + workspaceByteLength > 0x1_0000_0000) {
    throw new Error('GaussianSplatPlugin: Opacity WASM pointer overflow.');
  }
  const splatAPointer = workspace;
  const splatBPointer = workspace + splatBOffset;
  const sourceOpacityPointer = workspace + sourceOpacityOffset;
  const ratioPointer = workspace + ratioOffset;
  new Uint32Array(
    wasm.memory.buffer,
    splatAPointer,
    splatWordLength,
  ).set(splatA.subarray(0, splatWordLength));
  new Uint32Array(
    wasm.memory.buffer,
    splatBPointer,
    splatWordLength,
  ).set(splatB.subarray(0, splatWordLength));
  if (metadataCopy) {
    new Uint8Array(
      wasm.memory.buffer,
      workspace + metadataOffset,
      metadataCopy.bytes.byteLength,
    ).set(metadataCopy.bytes);
  } else {
    new Uint8Array(
      wasm.memory.buffer,
      sourceOpacityPointer,
      sourceOpacityBytes!.byteLength,
    ).set(sourceOpacityBytes!);
    new Uint8Array(
      wasm.memory.buffer,
      ratioPointer,
      ratioBytes!.byteLength,
    ).set(ratioBytes!);
  }

  wasm.opacity_retarget(
    splatAPointer,
    splatBPointer,
    sourceOpacityPointer,
    sourceOpacity.byteStride,
    ratioPointer,
    ratio.byteStride,
    count,
    fileScale,
    targetScale,
  );

  splatA.set(
    new Uint32Array(wasm.memory.buffer, splatAPointer, splatWordLength),
  );
  splatB.set(
    new Uint32Array(wasm.memory.buffer, splatBPointer, splatWordLength),
  );
}
