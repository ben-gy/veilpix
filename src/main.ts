// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Veilpix bootstrap + UI wiring.
 *
 * Owns no crypto/stego logic — it decodes images to pixels, hands jobs to the
 * worker, and renders the Hide / Reveal workflows. All heavy lifting lives in
 * crypto.ts / stego.ts / pipeline.ts (run inside worker.ts).
 */

import './styles/main.css';
import { emit, mountEventDrawer } from './eventlog';
import { initGlossary } from './glossary';
import { usablePayloadBytes } from './pipeline';
import type {
  EmbedDone,
  EmbedRequest,
  ExtractDone,
  ExtractRequest,
  ProgressMessage,
  WorkerRequest,
} from './types';
import { clear, formatBytes, h, icon, initModalTriggers, mount, toast } from './ui';

type Mode = 'hide' | 'reveal';
type SecretKind = 'message' | 'file';

interface CoverState {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  url: string;
  name: string;
  bytes: number;
}

const state: {
  mode: Mode;
  secretKind: SecretKind;
  cover: CoverState | null;
  stego: CoverState | null;
  secretFile: File | null;
  busy: boolean;
} = {
  mode: 'hide',
  secretKind: 'message',
  cover: null,
  stego: null,
  secretFile: null,
  busy: false,
};

let appEl: HTMLElement;

// ============================================================================
// worker RPC
// ============================================================================

let worker: Worker | null = null;
let reqId = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    emit('system', 'ok', 'Worker spun up');
  }
  return worker;
}

function runJob(
  req: Omit<EmbedRequest, 'id'> | Omit<ExtractRequest, 'id'>,
  transfer: Transferable[],
  onProgress?: (m: ProgressMessage) => void,
): Promise<EmbedDone | ExtractDone> {
  const id = ++reqId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.kind === 'progress') {
        onProgress?.(m);
        return;
      }
      w.removeEventListener('message', handler);
      if (m.kind === 'error') reject(new Error(m.message));
      else resolve(m);
    };
    w.addEventListener('message', handler);
    w.postMessage({ ...req, id } as WorkerRequest, transfer);
  });
}

// ============================================================================
// image helpers
// ============================================================================

async function decodeImage(file: File): Promise<CoverState> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file is not an image this browser can open.');
  }
  const { width, height } = bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D drawing context.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);
  const url = URL.createObjectURL(file);
  return { pixels: imageData.data, width, height, url, name: file.name, bytes: file.size };
}

function pixelsToPngBlob(pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D drawing context.');
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode PNG.'));
    }, 'image/png');
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function shareFile(blob: Blob, filename: string, title: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// ============================================================================
// status bar
// ============================================================================

function setStatus(label: string, kind: 'idle' | 'busy' | 'ok' | 'warn' | 'bad'): void {
  const dot = document.getElementById('sb-status-dot');
  const lbl = document.getElementById('sb-status-label');
  if (dot) dot.className = `dot-mini ${kind === 'busy' ? '' : kind}`;
  if (lbl) lbl.textContent = label;
}

function updateStatusMeta(): void {
  const modeEl = document.getElementById('sb-mode');
  if (modeEl) modeEl.textContent = `mode ${state.mode}`;
  const capEl = document.getElementById('sb-capacity');
  const payEl = document.getElementById('sb-payload');
  const active = state.mode === 'hide' ? state.cover : state.stego;
  if (capEl) {
    capEl.innerHTML = active
      ? `<span style="color:var(--fg-3)">capacity</span> ${formatBytes(usablePayloadBytes(active.pixels))}`
      : `<span style="color:var(--fg-3)">capacity</span> —`;
  }
  if (payEl && state.mode === 'hide') {
    const used = currentSecretByteEstimate();
    payEl.innerHTML = `<span style="color:var(--fg-3)">payload</span> ${used > 0 ? formatBytes(used) : '—'}`;
  } else if (payEl) {
    payEl.innerHTML = `<span style="color:var(--fg-3)">payload</span> —`;
  }
}

function currentSecretByteEstimate(): number {
  if (state.secretKind === 'file') return state.secretFile?.size ?? 0;
  const ta = document.getElementById('secret-message') as HTMLTextAreaElement | null;
  return ta ? new TextEncoder().encode(ta.value).length : 0;
}

// ============================================================================
// shared building blocks
// ============================================================================

function dropzone(opts: {
  accept: string;
  title: string;
  hint: string;
  onFile: (file: File) => void;
}): HTMLElement {
  const input = h('input', { type: 'file', accept: opts.accept }) as HTMLInputElement;
  const zone = h(
    'label',
    { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': opts.title },
    icon('upload', 'dropzone-icon'),
    h('h2', {}, opts.title),
    h('p', {}, opts.hint),
    h('span', { class: 'browse' }, 'choose file'),
    input,
  );

  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) opts.onFile(f);
    input.value = '';
  });

  zone.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      stop(e);
      zone.classList.add('is-dragging');
    }),
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      stop(e);
      zone.classList.remove('is-dragging');
    }),
  );
  zone.addEventListener('drop', (e) => {
    stop(e);
    zone.classList.remove('is-dragging');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) opts.onFile(f);
  });

  return zone;
}

function imagePreviewCard(cs: CoverState): HTMLElement {
  return h(
    'div',
    { class: 'preview-card' },
    h('img', { class: 'preview-thumb', src: cs.url, alt: cs.name }),
    h(
      'div',
      { class: 'preview-meta' },
      h('div', { class: 'preview-name' }, cs.name),
      h(
        'div',
        { class: 'preview-stats' },
        `${cs.width}×${cs.height} · ${formatBytes(cs.bytes)} · capacity ${formatBytes(usablePayloadBytes(cs.pixels))}`,
      ),
      h('button', { type: 'button', class: 'ghost change-btn' }, 'change image'),
    ),
  );
}

function passphraseField(id: string, placeholder: string): HTMLElement {
  const input = h('input', {
    type: 'password',
    id,
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const toggle = h('button', { type: 'button', class: 'ghost pass-toggle', 'aria-label': 'show passphrase' }, icon('eye'));
  toggle.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  return h('div', { class: 'pass-row' }, input, toggle);
}

function progressBar(): { el: HTMLElement; set: (frac: number, label: string) => void } {
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress' }, fill);
  const labelEl = h('div', { class: 'progress-label' }, '');
  const el = h('div', { class: 'progress-wrap', 'aria-live': 'polite' }, labelEl, bar);
  el.style.display = 'none';
  return {
    el,
    set(frac, label) {
      el.style.display = 'block';
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      labelEl.textContent = label;
    },
  };
}

function errorBox(message: string, onRetry?: () => void): HTMLElement {
  const box = h(
    'div',
    { class: 'alert alert-error', role: 'alert' },
    icon('warn', 'icon'),
    h('div', {}, h('strong', {}, 'failed'), h('p', {}, message)),
  );
  if (onRetry) {
    const retry = h('button', { type: 'button', class: 'ghost' }, 'retry');
    retry.addEventListener('click', onRetry);
    (box.lastElementChild as HTMLElement).appendChild(retry);
  }
  return box;
}

// ============================================================================
// render
// ============================================================================

function render(): void {
  clear(appEl);
  appEl.classList.add('scrollable');

  const hero = h(
    'div',
    { class: 'hero-strip' },
    h('h1', {}, 'veilpix'),
    h('p', { class: 'tagline' }, 'hide encrypted secrets inside images'),
  );

  const banner = h(
    'button',
    { type: 'button', class: 'trust-banner', 'data-modal': 'tmpl-security' },
    icon('lock'),
    h('span', {}, 'Runs entirely in your browser. Your image, secret, and passphrase never leave this device.'),
  );

  const tabs = h(
    'div',
    { class: 'mode-tabs', role: 'tablist' },
    modeTab('hide', 'Hide', 'lock'),
    modeTab('reveal', 'Reveal', 'eye'),
  );

  appEl.append(hero, banner, tabs);
  appEl.appendChild(state.mode === 'hide' ? renderHide() : renderReveal());
  updateStatusMeta();
  initModalTriggers();
}

function modeTab(mode: Mode, label: string, ic: 'lock' | 'eye'): HTMLElement {
  const btn = h(
    'button',
    {
      type: 'button',
      class: `mode-tab ${state.mode === mode ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': state.mode === mode ? 'true' : 'false',
    },
    icon(ic),
    label,
  );
  btn.addEventListener('click', () => {
    if (state.busy || state.mode === mode) return;
    state.mode = mode;
    setStatus('idle', 'idle');
    render();
  });
  return btn;
}

// ---------- HIDE ----------

function renderHide(): HTMLElement {
  const panel = h('div', { class: 'panel fill' });
  const head = h(
    'div',
    { class: 'panel-head' },
    h('span', { class: 'title' }, 'hide'),
    h('span', { class: 'meta', html: '<span class="k">cipher</span> <span class="v">aes-gcm-256</span>' }),
  );
  const body = h('div', { class: 'panel-body' });
  panel.append(head, body);

  // 1. cover image
  body.appendChild(stepLabel('01', 'cover image'));
  if (!state.cover) {
    body.appendChild(
      dropzone({
        accept: 'image/*',
        title: 'drop a cover image',
        hint: 'png · jpg · webp · gif — the bigger, the more it can carry',
        onFile: (f) => loadCover(f),
      }),
    );
  } else {
    const card = imagePreviewCard(state.cover);
    card.querySelector('.change-btn')?.addEventListener('click', () => {
      releaseCover();
      render();
    });
    body.appendChild(card);
  }

  // 2. secret
  body.appendChild(stepLabel('02', 'secret to hide'));
  body.appendChild(renderSecretInput());

  // 3. passphrase
  body.appendChild(stepLabel('03', 'passphrase'));
  body.appendChild(passphraseField('hide-pass', 'a strong passphrase'));
  const strength = h('div', { class: 'strength', id: 'pass-strength' });
  body.appendChild(strength);
  body.appendChild(passphraseField('hide-pass2', 'confirm passphrase'));

  // progress + action
  const prog = progressBar();
  const action = h('button', { type: 'button', class: 'primary action-btn' }, icon('lock'), 'Hide secret') as HTMLButtonElement;
  const resultSlot = h('div', { class: 'result-slot' });
  body.append(prog.el, h('div', { class: 'action-row' }, action), resultSlot);

  action.addEventListener('click', () => doHide(prog, resultSlot, action));

  // live payload meter
  body.addEventListener('input', () => updateStatusMeta());
  body.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id === 'hide-pass') updateStrength();
  });

  return panel;
}

function renderSecretInput(): HTMLElement {
  const wrap = h('div', { class: 'secret-wrap' });
  const toggle = h(
    'div',
    { class: 'subtabs' },
    subTab('message', 'message'),
    subTab('file', 'file'),
  );
  wrap.appendChild(toggle);

  if (state.secretKind === 'message') {
    const ta = h('textarea', {
      id: 'secret-message',
      class: 'secret-textarea',
      placeholder: 'Type the secret message to hide…',
      rows: '4',
    });
    wrap.appendChild(ta);
  } else {
    if (!state.secretFile) {
      wrap.appendChild(
        dropzone({
          accept: '*/*',
          title: 'attach a secret file',
          hint: 'any file — kept small relative to the cover image',
          onFile: (f) => {
            state.secretFile = f;
            render();
          },
        }),
      );
    } else {
      const row = h(
        'div',
        { class: 'file-meta' },
        icon('file', 'file-icon'),
        h('span', { class: 'file-name' }, state.secretFile.name),
        h('span', { class: 'file-size' }, formatBytes(state.secretFile.size)),
      );
      const rm = h('button', { type: 'button', class: 'ghost' }, 'remove');
      rm.addEventListener('click', () => {
        state.secretFile = null;
        render();
      });
      row.appendChild(rm);
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function subTab(kind: SecretKind, label: string): HTMLElement {
  const btn = h(
    'button',
    { type: 'button', class: `subtab ${state.secretKind === kind ? 'active' : ''}` },
    label,
  );
  btn.addEventListener('click', () => {
    if (state.secretKind === kind) return;
    state.secretKind = kind;
    render();
  });
  return btn;
}

function stepLabel(num: string, text: string): HTMLElement {
  return h('div', { class: 'step-label' }, h('span', { class: 'n' }, num), text);
}

function updateStrength(): void {
  const el = document.getElementById('pass-strength');
  const input = document.getElementById('hide-pass') as HTMLInputElement | null;
  if (!el || !input) return;
  const v = input.value;
  if (!v) {
    el.textContent = '';
    el.className = 'strength';
    return;
  }
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 14) score++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
  if (/\d/.test(v)) score++;
  if (/[^A-Za-z0-9]/.test(v)) score++;
  const level = score <= 2 ? 'weak' : score === 3 ? 'fair' : 'strong';
  el.textContent = `strength: ${level}`;
  el.className = `strength ${level}`;
}

async function loadCover(file: File): Promise<void> {
  try {
    setStatus('decoding…', 'busy');
    emit('image', 'info', `Decoding ${file.name}`, { size: formatBytes(file.size) });
    releaseCover();
    state.cover = await decodeImage(file);
    emit('image', 'ok', 'Cover decoded', {
      dims: `${state.cover.width}x${state.cover.height}`,
      capacity: formatBytes(usablePayloadBytes(state.cover.pixels)),
    });
    setStatus('ready', 'ok');
    render();
  } catch (err) {
    setStatus('error', 'bad');
    emit('image', 'err', err instanceof Error ? err.message : String(err));
    toast(err instanceof Error ? err.message : 'Failed to load image');
  }
}

function releaseCover(): void {
  if (state.cover) URL.revokeObjectURL(state.cover.url);
  state.cover = null;
}

async function doHide(
  prog: ReturnType<typeof progressBar>,
  resultSlot: HTMLElement,
  action: HTMLButtonElement,
): Promise<void> {
  clear(resultSlot);
  if (!state.cover) {
    resultSlot.appendChild(errorBox('Add a cover image first.'));
    return;
  }
  const pass = (document.getElementById('hide-pass') as HTMLInputElement).value;
  const pass2 = (document.getElementById('hide-pass2') as HTMLInputElement).value;
  if (!pass) {
    resultSlot.appendChild(errorBox('Enter a passphrase.'));
    return;
  }
  if (pass !== pass2) {
    resultSlot.appendChild(errorBox('The two passphrases do not match.'));
    return;
  }

  let secretBytes: Uint8Array;
  let isFile: boolean;
  let name: string;
  if (state.secretKind === 'file') {
    if (!state.secretFile) {
      resultSlot.appendChild(errorBox('Attach a file, or switch to a text message.'));
      return;
    }
    secretBytes = new Uint8Array(await state.secretFile.arrayBuffer());
    isFile = true;
    name = state.secretFile.name;
  } else {
    const msg = (document.getElementById('secret-message') as HTMLTextAreaElement).value;
    if (!msg) {
      resultSlot.appendChild(errorBox('Type a message, or switch to a file.'));
      return;
    }
    secretBytes = new TextEncoder().encode(msg);
    isFile = false;
    name = '';
  }

  state.busy = true;
  action.disabled = true;
  setStatus('hiding…', 'busy');
  emit('crypto', 'info', 'Deriving key (PBKDF2 · 210k)');

  try {
    // Send a COPY of the cover pixels so the original stays reusable.
    const pixelsCopy = state.cover.pixels.slice();
    const secretBuf = secretBytes.slice().buffer;
    const res = (await runJob(
      {
        op: 'embed',
        pixels: pixelsCopy.buffer,
        width: state.cover.width,
        height: state.cover.height,
        isFile,
        name,
        secret: secretBuf,
        passphrase: pass,
      },
      [pixelsCopy.buffer, secretBuf],
      (m) => {
        const label =
          m.phase === 'encrypt' ? 'encrypting…' : m.phase === 'embed' ? 'weaving into pixels…' : 'finishing…';
        prog.set(m.fraction, label);
        emit('stego', 'info', label);
      },
    )) as EmbedDone;

    emit('stego', 'ok', 'Secret embedded', { bytes: res.embeddedBytes });
    const outPixels = new Uint8ClampedArray(res.pixels);
    const blob = await pixelsToPngBlob(outPixels, res.width, res.height);
    emit('io', 'ok', 'Stego PNG encoded', { size: formatBytes(blob.size) });
    prog.set(1, 'done');
    setStatus('done', 'ok');
    showHideResult(resultSlot, blob, res.embeddedBytes);
  } catch (err) {
    prog.el.style.display = 'none';
    setStatus('error', 'bad');
    const msg = err instanceof Error ? err.message : String(err);
    emit('stego', 'err', msg);
    resultSlot.appendChild(errorBox(msg, () => doHide(prog, resultSlot, action)));
  } finally {
    state.busy = false;
    action.disabled = false;
  }
}

function showHideResult(slot: HTMLElement, blob: Blob, embeddedBytes: number): void {
  clear(slot);
  const url = URL.createObjectURL(blob);
  const base = state.cover?.name.replace(/\.[^.]+$/, '') ?? 'veilpix';
  const filename = `${base}.veilpix.png`;

  const card = h('div', { class: 'result-card' });
  card.append(
    h(
      'div',
      { class: 'complete-hero' },
      icon('check', 'check'),
      h('h3', {}, 'secret hidden'),
      h('p', {}, `${formatBytes(embeddedBytes)} woven in · share the PNG as-is`),
    ),
    h('img', { class: 'preview-thumb wide', src: url, alt: 'stego image' }),
  );

  const dl = h('button', { type: 'button', class: 'primary' }, icon('download'), 'download png');
  dl.addEventListener('click', () => downloadBlob(blob, filename));
  const row = h('div', { class: 'btn-row' }, dl);

  if ((navigator as Navigator & { share?: unknown }).share) {
    const sh = h('button', { type: 'button', class: 'ghost' }, icon('share'), 'share');
    sh.addEventListener('click', async () => {
      const ok = await shareFile(blob, filename, 'Veilpix image');
      if (!ok) toast('Share cancelled or unsupported');
    });
    row.appendChild(sh);
  }
  card.appendChild(row);
  card.appendChild(
    h(
      'div',
      { class: 'note-line' },
      icon('info'),
      h('span', {}, 'Keep it as PNG. Converting to JPEG or re-compressing will erase the hidden data.'),
    ),
  );
  slot.appendChild(card);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- REVEAL ----------

function renderReveal(): HTMLElement {
  const panel = h('div', { class: 'panel fill' });
  const head = h(
    'div',
    { class: 'panel-head' },
    h('span', { class: 'title' }, 'reveal'),
    h('span', { class: 'meta', html: '<span class="k">input</span> <span class="v">veilpix png</span>' }),
  );
  const body = h('div', { class: 'panel-body' });
  panel.append(head, body);

  body.appendChild(stepLabel('01', 'stego image'));
  if (!state.stego) {
    body.appendChild(
      dropzone({
        accept: 'image/png',
        title: 'drop a veilpix image',
        hint: 'the PNG that has a secret hidden inside it',
        onFile: (f) => loadStego(f),
      }),
    );
  } else {
    const card = imagePreviewCard(state.stego);
    card.querySelector('.change-btn')?.addEventListener('click', () => {
      releaseStego();
      render();
    });
    body.appendChild(card);
  }

  body.appendChild(stepLabel('02', 'passphrase'));
  body.appendChild(passphraseField('reveal-pass', 'the passphrase it was hidden with'));

  const prog = progressBar();
  const action = h('button', { type: 'button', class: 'primary action-btn' }, icon('eye'), 'Reveal secret') as HTMLButtonElement;
  const resultSlot = h('div', { class: 'result-slot' });
  body.append(prog.el, h('div', { class: 'action-row' }, action), resultSlot);

  action.addEventListener('click', () => doReveal(prog, resultSlot, action));
  return panel;
}

async function loadStego(file: File): Promise<void> {
  try {
    setStatus('decoding…', 'busy');
    emit('image', 'info', `Decoding ${file.name}`, { size: formatBytes(file.size) });
    releaseStego();
    state.stego = await decodeImage(file);
    emit('image', 'ok', 'Image decoded', { dims: `${state.stego.width}x${state.stego.height}` });
    setStatus('ready', 'ok');
    render();
  } catch (err) {
    setStatus('error', 'bad');
    const msg = err instanceof Error ? err.message : String(err);
    emit('image', 'err', msg);
    toast(msg);
  }
}

function releaseStego(): void {
  if (state.stego) URL.revokeObjectURL(state.stego.url);
  state.stego = null;
}

async function doReveal(
  prog: ReturnType<typeof progressBar>,
  resultSlot: HTMLElement,
  action: HTMLButtonElement,
): Promise<void> {
  clear(resultSlot);
  if (!state.stego) {
    resultSlot.appendChild(errorBox('Add a Veilpix image first.'));
    return;
  }
  const pass = (document.getElementById('reveal-pass') as HTMLInputElement).value;
  if (!pass) {
    resultSlot.appendChild(errorBox('Enter the passphrase.'));
    return;
  }

  state.busy = true;
  action.disabled = true;
  setStatus('revealing…', 'busy');
  emit('stego', 'info', 'Reading pixel LSBs');

  try {
    const pixelsCopy = state.stego.pixels.slice();
    const res = (await runJob(
      {
        op: 'extract',
        pixels: pixelsCopy.buffer,
        width: state.stego.width,
        height: state.stego.height,
        passphrase: pass,
      },
      [pixelsCopy.buffer],
      (m) => {
        const label = m.phase === 'extract' ? 'reading pixels…' : 'decrypting…';
        prog.set(m.fraction, label);
        emit(m.phase === 'extract' ? 'stego' : 'crypto', 'info', label);
      },
    )) as ExtractDone;

    prog.set(1, 'done');
    setStatus('done', 'ok');
    emit('crypto', 'ok', 'Decrypted', { type: res.isFile ? 'file' : 'message' });
    showRevealResult(resultSlot, res);
  } catch (err) {
    prog.el.style.display = 'none';
    setStatus('error', 'bad');
    const msg = err instanceof Error ? err.message : String(err);
    emit('crypto', 'err', msg);
    resultSlot.appendChild(errorBox(msg, () => doReveal(prog, resultSlot, action)));
  } finally {
    state.busy = false;
    action.disabled = false;
  }
}

function showRevealResult(slot: HTMLElement, res: ExtractDone): void {
  clear(slot);
  const card = h('div', { class: 'result-card' });
  card.appendChild(
    h('div', { class: 'complete-hero compact' }, icon('check', 'check'), h('h3', {}, 'secret revealed')),
  );

  if (res.isFile) {
    const blob = new Blob([res.data]);
    const name = res.name || 'veilpix-secret.bin';
    const row = h(
      'div',
      { class: 'file-meta' },
      icon('file', 'file-icon'),
      h('span', { class: 'file-name' }, name),
      h('span', { class: 'file-size' }, formatBytes(blob.size)),
    );
    card.appendChild(row);
    const dl = h('button', { type: 'button', class: 'primary' }, icon('download'), 'download file');
    dl.addEventListener('click', () => downloadBlob(blob, name));
    const btns = h('div', { class: 'btn-row' }, dl);
    if ((navigator as Navigator & { share?: unknown }).share) {
      const sh = h('button', { type: 'button', class: 'ghost' }, icon('share'), 'share');
      sh.addEventListener('click', async () => {
        const ok = await shareFile(blob, name, 'Veilpix secret');
        if (!ok) toast('Share cancelled or unsupported');
      });
      btns.appendChild(sh);
    }
    card.appendChild(btns);
  } else {
    const text = new TextDecoder().decode(res.data);
    const ta = h('textarea', { class: 'secret-textarea', readonly: 'true', rows: '5' }) as HTMLTextAreaElement;
    ta.value = text;
    card.appendChild(ta);
    const copy = h('button', { type: 'button', class: 'primary' }, icon('copy'), 'copy message');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
      } catch {
        ta.select();
        toast('Press Cmd/Ctrl+C to copy');
      }
    });
    card.appendChild(h('div', { class: 'btn-row' }, copy));
  }
  slot.appendChild(card);
}

// ============================================================================
// boot
// ============================================================================

function boot(): void {
  appEl = mount();
  const drawer = document.getElementById('event-drawer');
  if (drawer) mountEventDrawer(drawer);
  initGlossary();
  emit('system', 'ok', 'Veilpix ready — zero backend, all local');

  render();

  // Enter triggers the active primary action (unless typing in the textarea).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA') return;
    const btn = appEl.querySelector<HTMLButtonElement>('.action-btn');
    if (btn && !btn.disabled && (target.tagName === 'INPUT' || target === document.body)) {
      btn.click();
    }
  });

  // Paste an image straight in.
  document.addEventListener('paste', (e) => {
    if (state.busy) return;
    const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (state.mode === 'hide') loadCover(file);
    else loadStego(file);
  });

  registerServiceWorker();
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is best-effort */
    });
  });
}

boot();
