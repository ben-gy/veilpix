// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Veilpix Web Worker.
 *
 * Runs the CPU-bound crypto + LSB work off the main thread so the UI never
 * freezes, even on multi-megapixel images. Pixel buffers move in and out as
 * Transferables (zero-copy).
 */

import { hide, reveal } from './pipeline';
import type { WorkerRequest, WorkerResponse } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.op === 'embed') {
      const pixels = new Uint8ClampedArray(req.pixels);
      const embeddedBytes = await hide(
        pixels,
        { isFile: req.isFile, name: req.name, data: new Uint8Array(req.secret) },
        req.passphrase,
        (phase, fraction) => post({ id: req.id, kind: 'progress', phase, fraction }),
      );
      const out = pixels.buffer;
      post(
        {
          id: req.id,
          kind: 'embed-done',
          pixels: out,
          width: req.width,
          height: req.height,
          embeddedBytes,
        },
        [out],
      );
    } else {
      const pixels = new Uint8ClampedArray(req.pixels);
      const secret = await reveal(pixels, req.passphrase, (phase, fraction) =>
        post({ id: req.id, kind: 'progress', phase, fraction }),
      );
      const data = secret.data.slice().buffer;
      post(
        { id: req.id, kind: 'extract-done', isFile: secret.isFile, name: secret.name, data },
        [data],
      );
    }
  } catch (err) {
    post({
      id: req.id,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
