# Tool Plan: Veilpix

## Overview
- **Name:** Veilpix
- **Repo name:** veilpix
- **Tagline:** Hide an encrypted message or file inside an ordinary image — in your browser, never uploaded.

## Problem It Solves
Someone needs to pass a sensitive note or small file to another person, but a
visibly-encrypted blob (a `.enc` file, a PGP block) is itself a red flag — it
screams "secret here." They want the secret to travel inside something innocuous:
a holiday photo, a meme, a screenshot. They Google "hide text in image" or
"steganography online" and land on sites that upload their photo *and their
secret* to a server. That's the worst possible outcome for a privacy task.
Veilpix does the whole thing locally: the secret is AES-256 encrypted with a
passphrase, then woven into the least-significant bits of the image's pixels.
The output looks identical to the original to the human eye.

## Why This Must Be Client-Side
- **Privacy:** the cover image, the secret, and the passphrase never leave the
  device. Uploading any of them to a steganography web service defeats the entire
  point.
- **Sensitive-data handling:** the input is by definition something the user
  wants to keep private. A server round-trip is an unacceptable trust surface.
- **No-account friction:** drag, type passphrase, download. Nothing to sign up for.

## Browser APIs / Libraries Used
| API / Library | What it does for us | Fallback if unsupported |
|---------------|----------------------|-------------------------|
| Web Crypto (PBKDF2 + AES-GCM-256) | Derive a key from the passphrase and authentically encrypt the secret before hiding it | N/A — hard requirement (all evergreen browsers) |
| Canvas 2D / `ImageData` | Decode the cover image to raw RGBA pixels, and re-encode the stego image as lossless PNG | N/A — hard requirement |
| `createImageBitmap` | Fast off-thread-friendly image decode | Fall back to `<img>` + canvas draw |
| Web Workers | Run the LSB embed/extract + crypto off the main thread so the UI never freezes on large images | Inline main-thread path (still works, may jank) |
| Transferable `ArrayBuffer` | Move multi-megabyte pixel buffers to/from the worker with zero copy | Structured clone (slower) |
| Web Share API | Share the resulting PNG natively on mobile | Hidden when unsupported; download always available |
| Clipboard API | Copy a revealed text message | Manual select fallback |
| Service Worker (PWA) | Works fully offline after first load | Online still works |

## Workflow (input → process → output)
**Hide:** drop a cover image → type a message *or* attach a small secret file →
enter a passphrase → worker encrypts (AES-GCM-256) and embeds the ciphertext into
the pixel LSBs → download/share the stego PNG.
**Reveal:** drop a stego PNG → enter the passphrase → worker reads the LSBs,
verifies the container magic, decrypts → shows the message (copyable) or offers
the recovered file for download.

## Non-Goals
- No multi-image batching v1.
- No JPEG/lossy output ever (lossy recompression destroys LSB data — output is always PNG).
- No cloud sync, no accounts, ever.
- No claim of undetectability — LSB stego is statistically detectable; we say so plainly.

## Target Audience
Privacy-conscious and technical users — journalists, activists, security hobbyists,
and the curious — who understand "encrypted but hidden" and want it done without a
server in the loop. Dark, terminal-flavoured UI matching the factory family.

## Style Direction
**Tone:** technical, precise, trustworthy.
**Colour palette:** dark, desaturated indigo/blue base with a violet-cyan accent
(violet reads as "covert/crypto"; matches Dropwell/Sealbox family feel).
**UI density:** compact, data-dense.
**Dark/light theme:** dark (security/technical audience).
**Reference tools for feel:** Dropwell (our own), Sealbox (our own).

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No runtime dependencies.
- **Key libraries:** none — Web Crypto + Canvas only.
- **Worker strategy:** single dedicated Web Worker for crypto + LSB embed/extract,
  with phase-level progress messages and Transferable pixel buffers.
- **Storage:** none for user data; `localStorage` only for the last-used mode/theme.

## Privacy & Trust Model
**Protected**
- Secret contents and filename — AES-GCM-256 authenticated encryption, key derived
  from the passphrase via PBKDF2 (210k iterations, SHA-256).
- The cover image — decoded and re-encoded entirely in the browser; never uploaded.
- The passphrase — used only in-tab; never stored, never transmitted.

**Not protected**
- *That data is hidden at all.* LSB steganography changes pixel statistics; a
  determined analyst running steganalysis can detect the presence (not the content)
  of an embedded payload.
- The size of the hidden payload is loosely bounded by the image dimensions.
- If the stego PNG is later re-saved as JPEG or run through a service that
  recompresses it, the hidden data is destroyed.

**Trust surface**
- The static site bundle (hash-pinned via the GitHub Pages deploy).
- The TLS chain between the user and GitHub Pages (page load only).
- The recipient must independently know the passphrase (shared out-of-band).

## UX Required Surfaces
- Drop zone (drag-drop, tap-to-pick) for cover/stego image.
- Determinate phase progress (decode → encrypt → embed → encode).
- Event log drawer (Dropwell pattern).
- How-It-Works modal (5 steps).
- Threat Model modal (protected / not protected / trust).
- About modal with benrichardson.dev attribution + source link.
- Output delivery: download PNG + Web Share + copy (for revealed text).
- Keyboard: Escape closes modals, Enter triggers primary action.
- Sticky footer "Built by benrichardson.dev".
