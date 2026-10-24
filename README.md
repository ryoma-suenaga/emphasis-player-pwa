# Emphasis Player (PWA)

Local-file music player (metadata library + per-session file matching + LRU cache of played tracks) with the even-order integral/derivative emphasis EQ
(WO98/18203, JP-A H8-307184). Everything runs in the browser; music never leaves the device.

## Files
| File | Role |
|---|---|
| `index.html` | UI (album / song views, now-playing sheet, EQ card, library sheet) |
| `app.js` | library (IndexedDB), search, queue, Media Session, Web Audio graph |
| `dsp.js` | filter design: `H = 1 - B·LP2·Guard - C·HP2`, linear-phase FIR (8192 taps) |
| `tags.js` | ID3v2 / MP4 / FLAC tag + cover reader (Shift_JIS fallback for ID3 Latin-1) |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell (offline cache, install) |

## Audio graph
```
<audio> ─ MediaElementSource ─┬─ Delay(N/2 in FIR mode) ─ dryGain ──┐
                              └─ wet chain (Convolver | IIR×3) ─ wetGain(preamp) ─┴─ Limiter ─ out
```
A/B toggle crossfades dryGain / wetGain; the dry path is delayed so both are time-aligned.

## Deploy (GitHub Pages, HTTPS is required for install/offline)
1. Create a public repository, upload all files in this folder to the root.
2. Settings → Pages → Source: "Deploy from a branch", Branch: `main` / `(root)` → Save.
3. Open `https://<user>.github.io/<repo>/` in Chrome on Android → menu → "Install app" / "Add to Home screen".

Updating: upload changed files and bump `CACHE` in `sw.js` (e.g. `-v2`).
Local test on PC: `python -m http.server 8000` then open `http://localhost:8000` (service worker is skipped on http).
