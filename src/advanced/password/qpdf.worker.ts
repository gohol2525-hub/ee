/// <reference lib="webworker" />
import { createQpdfModule, runQpdf, type QpdfInit, type QpdfModule } from './qpdf-core.ts';

export interface QpdfWorkerRequest {
  id: number;
  scriptUrl: string;
  wasmUrl: string;
  args: string[];
  inputs: Record<string, Uint8Array>;
  outputs: string[];
}

export type QpdfWorkerResponse =
  | { id: number; ok: true; code: number; files: Record<string, Uint8Array>; messages: string[] }
  | { id: number; ok: false };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let qpdf: Promise<QpdfModule> | undefined;

const load = (scriptUrl: string, wasmUrl: string) => qpdf ??= import(/* @vite-ignore */ scriptUrl).then(({ default: init }: { default: QpdfInit }) =>
  createQpdfModule(init, { locateFile: (file: string) => file.endsWith('.wasm') ? wasmUrl : scriptUrl }));

scope.onmessage = async (event: MessageEvent<QpdfWorkerRequest>) => {
  const { id, scriptUrl, wasmUrl, args, inputs, outputs } = event.data;
  try {
    const result = runQpdf(await load(scriptUrl, wasmUrl), args, inputs, outputs);
    const response: QpdfWorkerResponse = { id, ok: true, ...result };
    scope.postMessage(response, Object.values(result.files).map(file => file.buffer as ArrayBuffer));
  } catch {
    scope.postMessage({ id, ok: false } satisfies QpdfWorkerResponse);
  }
};
