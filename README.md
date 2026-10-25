# Emphasis Player (PWA) — v3

Local-file music player (metadata library + per-session file matching + LRU cache of played tracks) with the even-order integral/derivative emphasis EQ
(WO98/18203, JP-A H8-307184), a loudness-linked preset (ISO 226) and blind listening tests. Everything runs in the browser; music never leaves the device.

## What's new in v3
- **In-app volume** (−40…0 dB, after the limiter). Default 0 dB = same level as v2.
- **Loudness preset ("ラウドネス")**: |H| = ISO 226:2003 compensation (refPhon 83 → listening phon, applied ≤ 1 kHz, capped at +12 dB)
  × patent HF part |1 − C·HP2| × 20 Hz guard. Linear-phase FIR only.
  Listening phon = calPhon + (vol − calVol), 1 dB steps; the FIR is rebuilt (60 ms crossfade) only when the phon value changes.
  Calibrate once: set the phone volume to a fixed level, choose your usual in-app volume, press "この音量を基準にする" (= calPhon, default 60).
- **Listening test sheet ("聴き比べ")**: blind A/B preference and ABX.
  One looping buffer source feeds both conditions (sample-aligned; dry/IIR delayed by N/2), switching = 20 ms gain crossfade.
  Level matching: K-weighted (BS.1770) ungated loudness of the segment computed from its Welch spectrum × |H|², plus common headroom
  −0.45 × max boost. Results (n, k, binomial p) kept in localStorage, CSV export.
  Conditions: 原音 / 標準 B3C3 / 強 B8C5 (FIR) / 強 B8C5 (IIR) / ラウドネス連動 / いまの設定.

## Files
| File | Role |
|---|---|
| `index.html` | UI (album / song views, now-playing sheet with volume + EQ card, listening-test sheet, library sheet) |
| `app.js` | library (IndexedDB), queue, Media Session, Web Audio graph, loudness link, listening tests |
| `dsp.js` | curves (`makeCurve`: emphasis / loudness), linear-phase FIR (8192 taps), ISO 226, K-weighting, spectrum loudness, binomial p |
| `tags.js` | ID3v2 / MP4 / FLAC tag + cover reader (unchanged since v2) |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell (offline cache, install) |

## Audio graph
```
<audio> ─ MediaElementSource ─┬─ Delay(N/2 for FIR, 0 for IIR) ─ dryGain ──┐
                              └─ wet chain (Convolver | IIR×3) ─ wetGain(preamp) ─┴─ Limiter ─ master(volume) ─ out
listening test:  BufferSource(loop) ─┬─ cond A ─ match gain ─ sel A ─┐
                                     └─ cond B ─ match gain ─ sel B ─┴─ Limiter ─ master ─ out
```

## Tests
- `node test/dsp.test.mjs` — ISO 226 vs python/iso226.py, curve shapes, FIR magnitude, K-weighting vs BS.1770 table,
  spectrum loudness vs time-domain K-weighted energy (±0.15 dB), binomial p-values.
- Headless Chromium run (playwright): playback, loudness preset + volume link, blind AB, ABX, CSV, resume — no page errors.

## Deploy / update (GitHub Pages)
Upload the changed files (`index.html`, `app.js`, `dsp.js`, `sw.js`, `README.md`) to the repository root, overwriting the old ones.
`CACHE` in `sw.js` is now `emphasis-player-v3`, so the app updates on the next launch while online
(if it still shows the old screen, close the app completely and open it again).
