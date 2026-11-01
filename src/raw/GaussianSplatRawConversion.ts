import type { GaussianBufferCollection } from '../GaussianSplatLoader';
import RawWorker from './GaussianSplatRawWorker?worker&inline';
import {
  collectRawGaussianBufferViewIndices,
  type GaussianPrimitiveRawSource,
} from './GaussianSplatRaw';
import type {
  RawConversionRequest,
  RawConversionResponse,
} from './GaussianSplatRawWorker';

// Tile parsing already limits concurrent conversions.
const WORKER_IDLE_TIMEOUT_MS = 30_000;
const idleWorkers = new Map<Worker, ReturnType<typeof setTimeout>>();

function acquireWorker() {
  for (const [worker, timeout] of idleWorkers) {
    clearTimeout(timeout);
    idleWorkers.delete(worker);
    return worker;
  }
  return new RawWorker({ name: 'GaussianSplatRawWorker' });
}

function releaseWorker(worker: Worker) {
  worker.onmessage = worker.onerror = worker.onmessageerror = null;
  idleWorkers.set(
    worker,
    setTimeout(() => {
      idleWorkers.delete(worker);
      worker.terminate();
    }, WORKER_IDLE_TIMEOUT_MS),
  );
}

export async function convertRawGaussians(
  json: any,
  buffers: GaussianBufferCollection,
  sources: readonly GaussianPrimitiveRawSource[],
  abortSignal: AbortSignal,
) {
  abortSignal.throwIfAborted();
  const viewIndices = new Set<number>();
  for (const source of sources) {
    for (const index of collectRawGaussianBufferViewIndices(json, source)) {
      viewIndices.add(index);
    }
  }
  // Copy views to preserve buffers retained by fetch hooks or SPZ primitives.
  // Keep declared lengths relative to each view for Worker validation.
  const bufferViews = [...(json.bufferViews ?? [])];
  const bufferDefinitions: { byteLength: number }[] = [];
  const rawBuffers: (Uint8Array<ArrayBuffer> | undefined)[] = [];
  const transfer: ArrayBuffer[] = [];
  for (const index of viewIndices) {
    const view = json.bufferViews[index];
    const byteOffset = view.byteOffset ?? 0;
    const buffer = buffers[view.buffer];
    bufferViews[index] = { ...view, buffer: index, byteOffset: 0 };
    bufferDefinitions[index] = {
      byteLength: json.buffers?.[view.buffer]?.byteLength - byteOffset,
    };
    // The Worker rejects missing buffers for invalid ranges.
    if (
      buffer &&
      Number.isSafeInteger(byteOffset) &&
      Number.isSafeInteger(view.byteLength) &&
      byteOffset >= 0 &&
      view.byteLength >= 0
    ) {
      const bytes = buffer.slice(byteOffset, byteOffset + view.byteLength);
      rawBuffers[index] = bytes;
      transfer.push(bytes.buffer);
    }
  }
  const request: RawConversionRequest = {
    json: {
      accessors: json.accessors,
      bufferViews,
      buffers: bufferDefinitions,
    },
    buffers: rawBuffers,
    sources,
  };

  const worker = acquireWorker();
  // Reuse only workers that replied; terminate aborted or crashed workers.
  let replied = false;
  let onAbort: () => void;
  try {
    return await new Promise<Uint8Array[]>((resolve, reject) => {
      onAbort = () => reject(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = ({ data }: MessageEvent<RawConversionResponse>) => {
        replied = true;
        if ('error' in data) reject(new Error(data.error));
        else resolve(data.bytes);
      };
      worker.onerror = (event) =>
        reject(
          new Error(
            event.message || 'GaussianSplatPlugin: Conversion worker failed.',
          ),
        );
      worker.onmessageerror = () =>
        reject(new Error('GaussianSplatPlugin: Invalid conversion worker response.'));
      worker.postMessage(request, transfer);
    });
  } finally {
    abortSignal.removeEventListener('abort', onAbort!);
    if (replied) releaseWorker(worker);
    else worker.terminate();
  }
}
