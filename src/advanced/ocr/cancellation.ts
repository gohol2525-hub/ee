export class OcrCancelledError extends Error {
  constructor() { super('Đã dừng nhận dạng.'); this.name = 'OcrCancelledError'; }
}

/** Tesseract termination does not reject in-flight jobs, so abort must settle our own waiter. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new OcrCancelledError());
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
