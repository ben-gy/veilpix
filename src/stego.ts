// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * LSB steganography container + bit-level pixel I/O for Veilpix.
 *
 * Everything here is DOM-free and operates on plain byte arrays, so it is
 * exhaustively unit-tested without a browser.
 *
 * ── Pixel carrier ──────────────────────────────────────────────────────────
 * We rewrite the least-significant bit of the R, G and B channels of every
 * fully-opaque pixel (alpha === 255). The alpha channel itself is never
 * touched, and partially-transparent pixels are skipped entirely — the canvas
 * round-trip pre-multiplies alpha, which would otherwise corrupt LSBs there.
 * Bits are packed MSB-first within each byte.
 *
 * ── Container wire format (what gets embedded) ─────────────────────────────
 *   MAGIC    4 bytes   "VPX1"
 *   VERSION  1 byte    0x01
 *   SALT     16 bytes  PBKDF2 salt
 *   IV       12 bytes  AES-GCM nonce
 *   LEN      4 bytes   u32 big-endian — ciphertext length
 *   CIPHER   LEN bytes AES-GCM ciphertext (includes the 16-byte auth tag)
 *
 * ── Inner plaintext layout (encrypted, never visible) ──────────────────────
 *   FLAGS    1 byte    bit0 = isFile
 *   NAMELEN  2 bytes   u16 big-endian
 *   NAME     NAMELEN   UTF-8 filename (empty for a text message)
 *   DATA     rest      message bytes or file bytes
 */

import type { Encrypted } from './crypto';
import { IV_BYTES, SALT_BYTES } from './crypto';
import type { Secret } from './types';

export const MAGIC = Uint8Array.from([0x56, 0x50, 0x58, 0x31]); // "VPX1"
export const VERSION = 0x01;
export const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES + 4; // 37
const LEN_OFFSET = MAGIC.length + 1 + SALT_BYTES + IV_BYTES; // 33

// ---------- inner plaintext framing ----------

/** Frame a secret into the inner plaintext that gets encrypted. */
export function packPlaintext(secret: Secret): Uint8Array {
  const nameBytes = new TextEncoder().encode(secret.name);
  if (nameBytes.length > 0xffff) throw new Error('Filename is too long');
  const out = new Uint8Array(1 + 2 + nameBytes.length + secret.data.length);
  out[0] = secret.isFile ? 1 : 0;
  out[1] = (nameBytes.length >> 8) & 0xff;
  out[2] = nameBytes.length & 0xff;
  out.set(nameBytes, 3);
  out.set(secret.data, 3 + nameBytes.length);
  return out;
}

/** Reverse of {@link packPlaintext}. */
export function unpackPlaintext(buf: Uint8Array): Secret {
  if (buf.length < 3) throw new Error('Corrupt payload');
  const isFile = (buf[0] & 1) === 1;
  const nameLen = (buf[1] << 8) | buf[2];
  const nameStart = 3;
  const dataStart = nameStart + nameLen;
  if (buf.length < dataStart) throw new Error('Corrupt payload');
  const name = new TextDecoder().decode(buf.subarray(nameStart, dataStart));
  const data = buf.slice(dataStart);
  return { isFile, name, data };
}

// ---------- container framing ----------

/** Build the embeddable container from an encryption result. */
export function buildContainer(enc: Encrypted): Uint8Array {
  if (enc.salt.length !== SALT_BYTES) throw new Error('Bad salt length');
  if (enc.iv.length !== IV_BYTES) throw new Error('Bad IV length');
  const out = new Uint8Array(HEADER_BYTES + enc.ciphertext.length);
  let o = 0;
  out.set(MAGIC, o);
  o += MAGIC.length;
  out[o++] = VERSION;
  out.set(enc.salt, o);
  o += SALT_BYTES;
  out.set(enc.iv, o);
  o += IV_BYTES;
  writeU32(out, o, enc.ciphertext.length);
  o += 4;
  out.set(enc.ciphertext, o);
  return out;
}

/** Validate a container header and return the declared ciphertext length. */
export function parseHeader(header: Uint8Array): { length: number } {
  if (header.length < HEADER_BYTES) throw new Error('No hidden data found in this image.');
  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) throw new Error('No hidden data found in this image.');
  }
  if (header[MAGIC.length] !== VERSION) {
    throw new Error('Unsupported Veilpix version in this image.');
  }
  return { length: readU32(header, LEN_OFFSET) };
}

/** Parse a full container back into its encryption parts. */
export function parseContainer(buf: Uint8Array): Encrypted {
  const { length } = parseHeader(buf);
  if (buf.length < HEADER_BYTES + length) throw new Error('Truncated Veilpix payload.');
  let o = MAGIC.length + 1;
  const salt = buf.slice(o, o + SALT_BYTES);
  o += SALT_BYTES;
  const iv = buf.slice(o, o + IV_BYTES);
  o += IV_BYTES + 4;
  const ciphertext = buf.slice(o, o + length);
  return { salt, iv, ciphertext };
}

// ---------- LSB pixel I/O ----------

/** Bytes of payload an RGBA buffer can carry (3 LSBs per fully-opaque pixel). */
export function capacityBytes(pixels: Uint8Array | Uint8ClampedArray): number {
  let usableChannels = 0;
  for (let p = 3; p < pixels.length; p += 4) {
    if (pixels[p] === 255) usableChannels += 3;
  }
  return Math.floor(usableChannels / 8);
}

/**
 * Embed `data` into the RGB LSBs of `pixels` (mutates in place).
 * Throws if the image lacks capacity.
 */
export function embedBytes(pixels: Uint8Array | Uint8ClampedArray, data: Uint8Array): void {
  const totalBits = data.length * 8;
  let written = 0;
  for (let p = 0; p + 3 < pixels.length && written < totalBits; p += 4) {
    if (pixels[p + 3] !== 255) continue;
    for (let c = 0; c < 3 && written < totalBits; c++) {
      const idx = p + c;
      const bit = (data[written >> 3] >> (7 - (written & 7))) & 1;
      pixels[idx] = (pixels[idx] & 0xfe) | bit;
      written++;
    }
  }
  if (written < totalBits) {
    throw new Error('Image is too small to hold this secret.');
  }
}

/** Read `count` bytes from the RGB LSBs of `pixels`. Throws if not enough. */
export function readBytes(pixels: Uint8Array | Uint8ClampedArray, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const totalBits = count * 8;
  let read = 0;
  for (let p = 0; p + 3 < pixels.length && read < totalBits; p += 4) {
    if (pixels[p + 3] !== 255) continue;
    for (let c = 0; c < 3 && read < totalBits; c++) {
      const bit = pixels[p + c] & 1;
      out[read >> 3] |= bit << (7 - (read & 7));
      read++;
    }
  }
  if (read < totalBits) throw new Error('No hidden data found in this image.');
  return out;
}

// ---------- u32 helpers ----------

export function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

export function readU32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) >>> 0) +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}
