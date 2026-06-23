/**
 * @vitest-environment node
 *
 * Node 20+ ships native webcrypto.subtle, exercising the same code paths as
 * the browser without a jsdom polyfill.
 */

import { describe, expect, it } from 'vitest';

import { decryptBytes, encryptBytes } from '../src/crypto';

describe('crypto', () => {
  it('round-trips a buffer', async () => {
    const data = new TextEncoder().encode('a covert little note');
    const enc = await encryptBytes(data, 'correct horse battery staple');
    const out = await decryptBytes(enc, 'correct horse battery staple');
    expect(out).toEqual(data);
  });

  it('uses a fresh salt and IV each time', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const a = await encryptBytes(data, 'pw');
    const b = await encryptBytes(data, 'pw');
    expect(a.salt).not.toEqual(b.salt);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('fails on the wrong passphrase', async () => {
    const enc = await encryptBytes(new Uint8Array([9, 9, 9]), 'right');
    await expect(decryptBytes(enc, 'wrong')).rejects.toThrow(/wrong passphrase/i);
  });

  it('rejects an empty passphrase', async () => {
    await expect(encryptBytes(new Uint8Array([1]), '')).rejects.toThrow(/passphrase/i);
  });

  it('handles empty input', async () => {
    const enc = await encryptBytes(new Uint8Array(0), 'pw');
    const out = await decryptBytes(enc, 'pw');
    expect(out.length).toBe(0);
  });

  it('handles a 1MB payload', async () => {
    const data = new Uint8Array(1024 * 1024);
    for (let i = 0; i < data.length; i += 997) data[i] = i & 0xff;
    const enc = await encryptBytes(data, 'pw');
    const out = await decryptBytes(enc, 'pw');
    expect(out).toEqual(data);
  });

  it('detects tampered ciphertext (GCM auth)', async () => {
    const enc = await encryptBytes(new Uint8Array([5, 6, 7, 8]), 'pw');
    enc.ciphertext[0] ^= 0xff;
    await expect(decryptBytes(enc, 'pw')).rejects.toThrow();
  });
});
