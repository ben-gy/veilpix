import { describe, expect, it } from 'vitest';

import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
  buildContainer,
  capacityBytes,
  embedBytes,
  packPlaintext,
  parseContainer,
  parseHeader,
  readBytes,
  readU32,
  unpackPlaintext,
  writeU32,
} from '../src/stego';
import type { Secret } from '../src/types';

/** Build an N×N fully-opaque RGBA buffer with a varied pixel pattern. */
function makePixels(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = (i * 7) & 0xff;
    px[i * 4 + 1] = (i * 13) & 0xff;
    px[i * 4 + 2] = (i * 29) & 0xff;
    px[i * 4 + 3] = 255;
  }
  return px;
}

describe('u32 helpers', () => {
  it('round-trips small and large values', () => {
    const buf = new Uint8Array(4);
    for (const v of [0, 1, 255, 256, 65535, 16_777_216, 4_000_000_000]) {
      writeU32(buf, 0, v);
      expect(readU32(buf, 0)).toBe(v);
    }
  });
});

describe('inner plaintext framing', () => {
  it('round-trips a text message (no filename)', () => {
    const secret: Secret = { isFile: false, name: '', data: new TextEncoder().encode('hello') };
    const back = unpackPlaintext(packPlaintext(secret));
    expect(back.isFile).toBe(false);
    expect(back.name).toBe('');
    expect(new TextDecoder().decode(back.data)).toBe('hello');
  });

  it('round-trips a file with a unicode name', () => {
    const data = new Uint8Array([1, 2, 3, 250, 0, 255]);
    const secret: Secret = { isFile: true, name: 'pläns–2026.pdf', data };
    const back = unpackPlaintext(packPlaintext(secret));
    expect(back.isFile).toBe(true);
    expect(back.name).toBe('pläns–2026.pdf');
    expect(back.data).toEqual(data);
  });

  it('rejects a corrupt (too short) plaintext', () => {
    expect(() => unpackPlaintext(new Uint8Array([0]))).toThrow();
  });
});

describe('container framing', () => {
  const enc = {
    salt: new Uint8Array(16).fill(9),
    iv: new Uint8Array(12).fill(3),
    ciphertext: new Uint8Array([10, 20, 30, 40, 50]),
  };

  it('round-trips a container', () => {
    const c = buildContainer(enc);
    expect(c.length).toBe(HEADER_BYTES + enc.ciphertext.length);
    expect(Array.from(c.subarray(0, MAGIC.length))).toEqual(Array.from(MAGIC));
    expect(c[MAGIC.length]).toBe(VERSION);
    const parsed = parseContainer(c);
    expect(parsed.salt).toEqual(enc.salt);
    expect(parsed.iv).toEqual(enc.iv);
    expect(parsed.ciphertext).toEqual(enc.ciphertext);
  });

  it('rejects a bad magic', () => {
    const c = buildContainer(enc);
    c[0] = 0x00;
    expect(() => parseHeader(c)).toThrow(/no hidden data/i);
  });

  it('rejects an unknown version', () => {
    const c = buildContainer(enc);
    c[MAGIC.length] = 0x7f;
    expect(() => parseHeader(c)).toThrow(/version/i);
  });

  it('rejects a truncated payload', () => {
    const c = buildContainer(enc).subarray(0, HEADER_BYTES + 2);
    expect(() => parseContainer(c)).toThrow(/truncated/i);
  });
});

describe('LSB pixel I/O', () => {
  it('reports capacity as 3 bits per opaque pixel', () => {
    const px = makePixels(16, 16); // 256 opaque px → 768 bits → 96 bytes
    expect(capacityBytes(px)).toBe(Math.floor((256 * 3) / 8));
  });

  it('ignores non-opaque pixels in capacity', () => {
    const px = makePixels(8, 8);
    px[3] = 128; // first pixel partially transparent
    expect(capacityBytes(px)).toBe(Math.floor(((64 - 1) * 3) / 8));
  });

  it('embeds and reads back exact bytes', () => {
    const px = makePixels(64, 64);
    const data = new Uint8Array(200);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    embedBytes(px, data);
    expect(readBytes(px, data.length)).toEqual(data);
  });

  it('embedding only flips least-significant bits', () => {
    const px = makePixels(32, 32);
    const orig = px.slice();
    embedBytes(px, new Uint8Array([0xff, 0x00, 0xaa]));
    for (let i = 0; i < px.length; i++) {
      if ((i & 3) === 3) continue; // alpha untouched
      expect(Math.abs(px[i] - orig[i])).toBeLessThanOrEqual(1);
      expect(px[i] & 0xfe).toBe(orig[i] & 0xfe);
    }
  });

  it('skips transparent pixels when embedding', () => {
    const px = makePixels(8, 8);
    px[3] = 0; // make first pixel transparent
    const before = [px[0], px[1], px[2]];
    embedBytes(px, new Uint8Array([0x00])); // 8 bits → consumes opaque channels only
    expect([px[0], px[1], px[2]]).toEqual(before); // transparent pixel untouched
  });

  it('throws when the image is too small', () => {
    const px = makePixels(4, 4); // 16 px → 48 bits → 6 bytes capacity
    expect(() => embedBytes(px, new Uint8Array(7))).toThrow(/too small/i);
  });

  it('throws when reading more than the image holds', () => {
    const px = makePixels(4, 4);
    expect(() => readBytes(px, 100)).toThrow(/no hidden data/i);
  });
});
