// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Click-to-define glossary tooltips.
 *
 * Any element with `class="glossary-link" data-term="..."` becomes clickable
 * and shows a fixed-position definition bubble. Dismissed on Escape or an
 * outside click. Terms are matched case-insensitively.
 */

export const GLOSSARY: Record<string, string> = {
  steganography:
    'Hiding the existence of a message — concealing it inside something ordinary (here, an image) rather than just scrambling it.',
  'lsb':
    'Least-Significant Bit: the last bit of a colour value. Flipping it changes a channel by at most 1 — invisible to the eye, but enough to carry data.',
  'aes-gcm':
    'AES-GCM is an authenticated cipher: it both encrypts your data and detects any tampering. Veilpix uses a 256-bit key.',
  'pbkdf2':
    'A function that stretches your passphrase into a strong key by hashing it 210,000 times, making brute-force guessing far slower.',
  ciphertext: 'The encrypted, unreadable form of your secret — what actually gets hidden in the pixels.',
  payload: 'The hidden data itself: the encrypted secret plus a small header Veilpix needs to find and unpack it.',
  capacity: 'How many bytes an image can carry — roughly three bits per fully-opaque pixel.',
  steganalysis: 'Statistical analysis that tries to detect whether an image is carrying hidden data (without necessarily reading it).',
  passphrase: 'The secret word or phrase that protects your payload. The recipient needs the exact same one to reveal it.',
};

let tooltip: HTMLElement | null = null;

function ensureTooltip(): HTMLElement {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'glossary-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function hide(): void {
  if (tooltip) tooltip.classList.remove('visible');
}

function show(target: HTMLElement, term: string): void {
  const def = GLOSSARY[term.toLowerCase()];
  if (!def) return;
  const tip = ensureTooltip();
  tip.textContent = def;
  tip.classList.add('visible');

  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 8;
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/** Attach global handlers. Idempotent. */
export function initGlossary(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.glossary-link');
    if (el) {
      e.preventDefault();
      const term = el.dataset.term;
      if (term) {
        if (tooltip?.classList.contains('visible')) hide();
        show(el, term);
      }
      return;
    }
    if (!(e.target as HTMLElement | null)?.closest('.glossary-tooltip')) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, true);
}
