import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortable, OcrCancelledError } from './cancellation.ts';

test('OCR cancellation settles even when terminating a worker leaves its job pending', async () => {
  const controller = new AbortController();
  const result = abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(result, OcrCancelledError);
  await assert.rejects(abortable(Promise.resolve(1), controller.signal), OcrCancelledError);
  assert.equal(await abortable(Promise.resolve(2), new AbortController().signal), 2);
});
