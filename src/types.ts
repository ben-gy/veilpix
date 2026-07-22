// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Shared types for Veilpix.
 *
 * The "secret" is whatever the user wants to hide — either a typed text message
 * or an attached file. Internally both are reduced to `{ isFile, name, data }`.
 */

export interface Secret {
  /** true when the secret is an attached file, false for a typed message. */
  isFile: boolean;
  /** original filename when `isFile`, otherwise the empty string. */
  name: string;
  /** raw bytes — UTF-8 of the message, or the file contents. */
  data: Uint8Array;
}

/** Progress phases emitted while hiding/revealing. */
export type Phase = 'decode' | 'encrypt' | 'embed' | 'encode' | 'extract' | 'decrypt' | 'done';

// ---------- worker wire protocol ----------

export interface EmbedRequest {
  id: number;
  op: 'embed';
  /** RGBA pixel buffer (transferable). */
  pixels: ArrayBuffer;
  width: number;
  height: number;
  isFile: boolean;
  name: string;
  /** secret bytes (transferable). */
  secret: ArrayBuffer;
  passphrase: string;
}

export interface ExtractRequest {
  id: number;
  op: 'extract';
  pixels: ArrayBuffer;
  width: number;
  height: number;
  passphrase: string;
}

export type WorkerRequest = EmbedRequest | ExtractRequest;

export interface ProgressMessage {
  id: number;
  kind: 'progress';
  phase: Phase;
  /** 0..1 — best-effort fraction for the current job. */
  fraction: number;
}

export interface EmbedDone {
  id: number;
  kind: 'embed-done';
  /** modified RGBA buffer (transferable) to paint back to canvas. */
  pixels: ArrayBuffer;
  width: number;
  height: number;
  /** bytes embedded (container size). */
  embeddedBytes: number;
}

export interface ExtractDone {
  id: number;
  kind: 'extract-done';
  isFile: boolean;
  name: string;
  data: ArrayBuffer;
}

export interface WorkerError {
  id: number;
  kind: 'error';
  message: string;
}

export type WorkerResponse = ProgressMessage | EmbedDone | ExtractDone | WorkerError;
