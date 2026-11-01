import { encodeRawGaussianPly, loadRawGaussianData } from './GaussianSplatRaw';
import type { GaussianPrimitiveRawSource } from './GaussianSplatRaw';
import type { GaussianBufferCollection } from '../GaussianSplatLoader';

export type RawConversionRequest = {
  json: any;
  buffers: GaussianBufferCollection;
  sources: readonly GaussianPrimitiveRawSource[];
};

export type RawConversionResponse =
  | { bytes: Uint8Array<ArrayBuffer>[] }
  | { error: string };

declare const self: {
  onmessage: (event: MessageEvent<RawConversionRequest>) => void;
  postMessage(message: RawConversionResponse, transfer?: Transferable[]): void;
};

self.onmessage = ({ data: { json, buffers, sources } }) => {
  try {
    const bytes = sources.map((source) =>
      encodeRawGaussianPly(loadRawGaussianData(json, buffers, source)),
    );
    self.postMessage({ bytes }, bytes.map((value) => value.buffer));
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
