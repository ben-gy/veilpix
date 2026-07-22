# veilpix

**Hide an encrypted message or file inside an ordinary image — in your browser, never uploaded.**

Live: https://veilpix.benrichardson.dev

---

## what it is

Veilpix hides a secret inside the pixels of an everyday image — a technique
called **steganography**. Unlike a visibly-encrypted blob (a `.enc` file, a PGP
block), the output just looks like a picture, so it doesn't advertise that
anything is hidden at all.

It's for people who want to pass something sensitive without it *looking*
sensitive — and who refuse to hand their photo, their secret, and their
passphrase to some upload-it-here website. Everything in Veilpix happens locally
in your browser. There is no server and no account. The only analytics is
Cloudflare Web Analytics — anonymous, cookie-less page-view counts; no personal
data, no cross-site tracking.

The secret is first encrypted with **AES-GCM-256** (key derived from your
passphrase via PBKDF2), then woven into the least-significant bits of the image's
red, green and blue channels. The change is at most ±1 per channel — invisible to
the eye, but enough to carry the ciphertext.

## how it works

**Hide**

```
cover image ──decode──▶ RGBA pixels
secret + passphrase ──PBKDF2──▶ key ──AES-GCM-256──▶ ciphertext
ciphertext ──┐
             ├─▶ container = MAGIC ∥ VERSION ∥ SALT ∥ IV ∥ LEN ∥ CIPHER
             ▼
        LSBs of RGB channels (fully-opaque pixels only)
             ▼
        re-encode as lossless PNG ──▶ download / share
```

**Reveal**

```
stego PNG ──decode──▶ RGBA pixels ──read LSBs──▶ container
verify MAGIC/VERSION ──▶ SALT, IV, CIPHER
passphrase ──PBKDF2──▶ key ──AES-GCM decrypt──▶ message or file
```

The heavy lifting (PBKDF2, AES-GCM, and the per-channel bit twiddling) runs in a
dedicated Web Worker, with pixel buffers moved as transferables, so the UI never
freezes — even on multi-megapixel images.

### wire format

Embedded into the pixel LSBs (MSB-first per byte):

| field   | size      | notes                                   |
|---------|-----------|-----------------------------------------|
| MAGIC   | 4 bytes   | `VPX1`                                  |
| VERSION | 1 byte    | `0x01`                                  |
| SALT    | 16 bytes  | PBKDF2 salt                             |
| IV      | 12 bytes  | AES-GCM nonce                           |
| LEN     | 4 bytes   | u32 big-endian — ciphertext length      |
| CIPHER  | LEN bytes | AES-GCM ciphertext (incl. 16-byte tag)  |

The inner plaintext (encrypted, never visible) is `FLAGS ∥ NAMELEN ∥ NAME ∥ DATA`,
so the original filename of an attached file is sealed inside the ciphertext too.

Only fully-opaque pixels (alpha = 255) carry data; partially-transparent pixels
are skipped, because the canvas alpha round-trip would otherwise corrupt their
LSBs. Capacity is therefore ~3 bits per opaque pixel.

## browser APIs used

- **Web Crypto (PBKDF2 + AES-GCM-256)** — derive a key from the passphrase and authentically encrypt the secret
- **Canvas 2D / `ImageData`** — decode the cover image to raw RGBA, re-encode the result as lossless PNG
- **`createImageBitmap`** — fast image decode
- **Web Workers + transferable `ArrayBuffer`** — run crypto + LSB work off the main thread, zero-copy
- **Web Share API** — share the resulting PNG on mobile (where supported)
- **Clipboard API** — copy a revealed text message
- **Service Worker** — works fully offline after first load

## security / privacy model

**Protected**
- Secret contents — AES-GCM-256 authenticated encryption
- The secret's filename — sealed inside the ciphertext
- The cover image — decoded and re-encoded in your browser, never uploaded
- The passphrase — used only in this tab, never stored or transmitted

**Not protected**
- *That* something is hidden — LSB steganography shifts pixel statistics, so steganalysis can detect a payload's presence (not its contents)
- The rough upper bound on payload size implied by the image dimensions
- Durability through recompression — saving the PNG as JPEG, or running it through a service that re-encodes images, destroys the hidden data

**Trust model**
- Sender and receiver must share the passphrase out-of-band
- The passphrase *is* the secret — anyone who has it and the image can decrypt
- Your images never talk to a server: no uploads, no third-party fonts, no calls with your data — the only third-party request is the cookie-less Cloudflare Web Analytics page-view counter

## stack

- Vite 6 + vanilla TypeScript
- No runtime dependencies — Web Crypto + Canvas only
- Vitest for unit tests (crypto, container framing, LSB I/O, end-to-end pipeline)
- GitHub Pages for hosting, deployed via GitHub Actions

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics — no personal data, no cross-site tracking.

## local development

```bash
npm install
npm run dev      # vite dev server on :5173
npm test         # run vitest suite
npm run build    # produce dist/ for deploy
npm run preview  # serve dist/ locally
```

## deploying

A push to `main` triggers `.github/workflows/deploy.yml`, which runs tests,
builds, and deploys `dist/` to GitHub Pages. The custom domain is set via
`public/CNAME` — point a `CNAME` DNS record for `veilpix.benrichardson.dev` at
`ben-gy.github.io`.

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
