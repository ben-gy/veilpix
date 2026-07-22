// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Passphrase-based authenticated encryption for Veilpix.
 *
 * The key is derived from the user's passphrase with PBKDF2 (SHA-256,
 * 210,000 iterations) and used for AES-GCM-256. A fresh random salt and IV are
 * generated per encryption, so encrypting the same secret twice yields different
 * ciphertext.
 *
 * These helpers are DOM-free and run unchanged in a Web Worker, in the main
 * thread, and under Node (Vitest) — `crypto.subtle` is available in all three.
 */

export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 210_000;

const ALGO = 'AES-GCM';

/** Cryptographically-strong random bytes. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Derive an AES-GCM-256 key from a passphrase + salt. */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface Encrypted {
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** Encrypt plaintext bytes with a passphrase. Generates a fresh salt + IV. */
export async function encryptBytes(plaintext: Uint8Array, passphrase: string): Promise<Encrypted> {
  if (!passphrase) throw new Error('A passphrase is required');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const buf = await crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { salt, iv, ciphertext: new Uint8Array(buf) };
}

/** Decrypt with a passphrase. Throws a friendly error on the wrong passphrase. */
export async function decryptBytes(enc: Encrypted, passphrase: string): Promise<Uint8Array> {
  if (!passphrase) throw new Error('A passphrase is required');
  const key = await deriveKey(passphrase, enc.salt);
  let buf: ArrayBuffer;
  try {
    buf = await crypto.subtle.decrypt(
      { name: ALGO, iv: enc.iv as BufferSource },
      key,
      enc.ciphertext as BufferSource,
    );
  } catch {
    throw new Error('Wrong passphrase, or the image carries no Veilpix payload here.');
  }
  return new Uint8Array(buf);
}
