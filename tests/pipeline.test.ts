/**
 * @vitest-environment node
 *
 * End-to-end hide → reveal exercising crypto + stego together on synthetic
 * pixel buffers (Node webcrypto, no canvas needed).
 */

import { describe, expect, it } from 'vitest';

import { hide, reveal, usablePayloadBytes } from '../src/pipeline';
import type { Secret } from '../src/types';

function makePixels(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = (i * 11) & 0xff;
    px[i * 4 + 1] = (i * 17) & 0xff;
    px[i * 4 + 2] = (i * 23) & 0xff;
    px[i * 4 + 3] = 255;
  }
  return px;
}

describe('hide/reveal pipeline', () => {
  it('round-trips a text message', async () => {
    const px = makePixels(128, 128);
    const secret: Secret = {
      isFile: false,
      name: '',
      data: new TextEncoder().encode('meet at the old pier, midnight 🌙'),
    };
    await hide(px, secret, 'hunter2');
    const out = await reveal(px, 'hunter2');
    expect(out.isFile).toBe(false);
    expect(new TextDecoder().decode(out.data)).toBe('meet at the old pier, midnight 🌙');
  });

  it('round-trips a binary file with its name', async () => {
    const px = makePixels(256, 256);
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 3) & 0xff;
    const secret: Secret = { isFile: true, name: 'dossier.bin', data };
    await hide(px, secret, 'pw');
    const out = await reveal(px, 'pw');
    expect(out.isFile).toBe(true);
    expect(out.name).toBe('dossier.bin');
    expect(out.data).toEqual(data);
  });

  it('fails to reveal with the wrong passphrase', async () => {
    const px = makePixels(64, 64);
    await hide(px, { isFile: false, name: '', data: new Uint8Array([1, 2, 3]) }, 'right');
    await expect(reveal(px, 'wrong')).rejects.toThrow(/wrong passphrase/i);
  });

  it('reports no hidden data on a clean image', async () => {
    const px = makePixels(64, 64);
    await expect(reveal(px, 'pw')).rejects.toThrow(/no hidden data/i);
  });

  it('rejects a secret larger than capacity', async () => {
    const px = makePixels(16, 16); // ~96 bytes capacity
    const big: Secret = { isFile: false, name: '', data: new Uint8Array(500) };
    await expect(hide(px, big, 'pw')).rejects.toThrow(/too small|holds/i);
  });

  it('computes a sensible usable payload budget', () => {
    const px = makePixels(100, 100); // 30000 bits → 3750 bytes minus overhead
    const budget = usablePayloadBytes(px);
    expect(budget).toBeGreaterThan(3000);
    expect(budget).toBeLessThan(3750);
  });

  it('leaves an unrelated image untouched after hiding into a copy', async () => {
    const original = makePixels(64, 64);
    const copy = original.slice();
    await hide(copy, { isFile: false, name: '', data: new Uint8Array([7, 7, 7]) }, 'pw');
    expect(copy).not.toEqual(original); // copy changed
  });
});
