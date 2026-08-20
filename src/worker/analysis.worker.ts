/// <reference lib="webworker" />
import { fromTransferable, toTransferable } from '../core/imageLoader.ts';
import { runPipeline } from '../core/pipeline.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

/**
 * Every pixel operation happens here so the UI thread stays responsive while a
 * 700-marker photo is analysed. The image buffer is transferred in and back out
 * again, so at no point do two full-resolution copies exist at once.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== 'analyze') return;
  const image = fromTransferable(msg.image);
  try {
    const result = await runPipeline(image, {
      settings: msg.settings,
      exemplars: msg.exemplars,
      onProgress: (update) => post({ type: 'progress', update }),
    });
    const handBack = toTransferable(image);
    post({ type: 'result', result, image: handBack }, [handBack.buffer]);
  } catch (err) {
    const handBack = toTransferable(image);
    post(
      { type: 'error', message: (err as Error)?.message ?? String(err), image: handBack },
      [handBack.buffer],
    );
  }
};

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}
