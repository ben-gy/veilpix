// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * End-to-end hide/reveal pipeline.
 *
 * Composes the crypto and stego layers. DOM-free — it takes and returns raw
 * pixel buffers — so the Web Worker, the main thread, and the test suite all
 * share exactly this code path.
 */

import { decryptBytes, encryptBytes } from './crypto';
import {
  HEADER_BYTES,
  buildContainer,
  capacityBytes,
  embedBytes,
  packPlaintext,
  parseContainer,
  parseHeader,
  readBytes,
  unpackPlaintext,
} from './stego';
import type { Phase, Secret } from './types';

export type ProgressFn = (phase: Phase, fraction: number) => void;

const noop: ProgressFn = () => {};

/**
 * Encrypt `secret` and embed it into `pixels` (mutated in place).
 * Returns the number of bytes embedded (the container size).
 */
export async function hide(
  pixels: Uint8ClampedArray | Uint8Array,
  secret: Secret,
  passphrase: string,
  onProgress: ProgressFn = noop,
): Promise<number> {
  onProgress('encrypt', 0.1);
  const plaintext = packPlaintext(secret);
  const enc = await encryptBytes(plaintext, passphrase);
  const container = buildContainer(enc);

  const capacity = capacityBytes(pixels);
  if (container.length > capacity) {
    const over = container.length - capacity;
    throw new Error(
      `Secret needs ${container.length} bytes but this image holds ${capacity}. ` +
        `Use a larger image or trim ${over} bytes.`,
    );
  }

  onProgress('embed', 0.5);
  embedBytes(pixels, container);
  onProgress('done', 1);
  return container.length;
}

/** Read the LSBs of `pixels`, verify, and decrypt back into a {@link Secret}. */
export async function reveal(
  pixels: Uint8ClampedArray | Uint8Array,
  passphrase: string,
  onProgress: ProgressFn = noop,
): Promise<Secret> {
  onProgress('extract', 0.2);
  const header = readBytes(pixels, HEADER_BYTES);
  const { length } = parseHeader(header);
  const total = HEADER_BYTES + length;
  const container = readBytes(pixels, total);
  const enc = parseContainer(container);

  onProgress('decrypt', 0.6);
  const plaintext = await decryptBytes(enc, passphrase);
  const secret = unpackPlaintext(plaintext);
  onProgress('done', 1);
  return secret;
}

/** How many payload bytes a buffer can carry (minus container overhead). */
export function usablePayloadBytes(pixels: Uint8ClampedArray | Uint8Array): number {
  // container overhead = HEADER_BYTES + 16-byte GCM tag + 3-byte inner frame
  const overhead = HEADER_BYTES + 16 + 3;
  return Math.max(0, capacityBytes(pixels) - overhead);
}
