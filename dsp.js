// dsp.js - even-order integral/derivative emphasis (WO98/18203, JP-A H8-307184)
//   emphasis curve : H(z) = 1 - B * LP2(z) * Guard(z) - C * HP2(z)
//   loudness curve : |H| = ISO226 compensation(listen phon) x |1 - C * HP2| x |Guard|
// LP2/HP2: 2nd-order leaky double integrator / differentiator (bilinear, pre-warped).
// Also: K-weighting (ITU-R BS.1770) and PSD-based loudness for level matching.

export const FIR_LEN = 8192;

export function biquad(kind, fc, fs, q) {
  const w = 2 * fs * Math.tan(Math.PI * fc / fs);
  const K = 2 * fs;
  const a0 = K * K + (w * K) / q + w * w;
  const a1 = 2 * (w * w - K * K);
  const a2 = K * K - (w * K) / q + w * w;
  const b = kind === 'lp' ? [w * w, 2 * w * w, w * w] : [K * K, -2 * K * K, K * K];
  return { b: b.map(v => v / a0), a: [1, a1 / a0, a2 / a0] };
}

// complex response of a biquad at normalised angular frequency w
function evalBQ(c, w) {
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const nr = c.b[0] + c.b[1] * c1 + c.b[2] * c2, ni = c.b[1] * s1 + c.b[2] * s2;
  const dr = c.a[0] + c.a[1] * c1 + c.a[2] * c2, di = c.a[1] * s1 + c.a[2] * s2;
  const den = dr * dr + di * di;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}
const cmul = (x, y) => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
const mag2BQ = (c, f, fs) => { const r = evalBQ(c, 2 * Math.PI * f / fs); return r[0] * r[0] + r[1] * r[1]; };

export function makeFilter(fs, { B = 8, C = 5, fLo = 50, fHi = 5000, q = 0.5, guardLo = 20 } = {}) {
  return {
    fs, B, C,
    lp: biquad('lp', fLo, fs, q),
    hp: biquad('hp', fHi, fs, q),
    glo: guardLo ? biquad('hp', guardLo, fs, Math.SQRT1_2) : null,
  };
}

export function response(flt, f) {
  const w = 2 * Math.PI * f / flt.fs;
  let lo = evalBQ(flt.lp, w);
  if (flt.glo) lo = cmul(lo, evalBQ(flt.glo, w));
  const hi = evalBQ(flt.hp, w);
  return [1 - flt.B * lo[0] - flt.C * hi[0], -flt.B * lo[1] - flt.C * hi[1]];
}

export const magDb = (flt, f) => {
  const r = response(flt, f);
  return 10 * Math.log10(r[0] * r[0] + r[1] * r[1] + 1e-30);
};

export function maxBoostDb(flt) {
  let m = 0;
  for (let i = 0; i <= 200; i++) m = Math.max(m, magDb(flt, 20 * Math.pow(1000, i / 200)));
  return m;
}

// ------------------------------------------------------------------ ISO 226:2003 equal-loudness
const ISO_F = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const ISO_AF = [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330, 0.315, 0.301,
  0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242,
  0.242, 0.245, 0.254, 0.271, 0.301];
const ISO_LU = [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5, -3.1, -2.0, -1.1,
  -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1];
const ISO_TF = [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2,
  4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3];
const ISO_LOGF = ISO_F.map(Math.log10);

// SPL [dB] at each ISO_F that sounds as loud as `phon` at 1 kHz
export function isoContour(phon) {
  return ISO_F.map((_, i) => {
    const af = ISO_AF[i];
    const Af = 4.47e-3 * (Math.pow(10, 0.025 * phon) - 1.15)
      + Math.pow(0.4 * Math.pow(10, (ISO_TF[i] + ISO_LU[i]) / 10 - 9), af);
    return (10 / af) * Math.log10(Af) - ISO_LU[i] + 94;
  });
}

// Per-band gain [dB] that keeps material balanced at refPhon sounding balanced at listenPhon.
export function isoCompTable(listenPhon, refPhon = 83) {
  const a = isoContour(listenPhon), b = isoContour(refPhon);
  return a.map((v, i) => (v - listenPhon) - (b[i] - refPhon));
}

// Interpolate a table (log-frequency), held flat outside 20 Hz - 12.5 kHz.
export function isoCompDb(table, f) {
  const lf = Math.log10(Math.min(Math.max(f, ISO_F[0]), ISO_F[ISO_F.length - 1]));
  let i = 1;
  while (i < ISO_LOGF.length - 1 && ISO_LOGF[i] < lf) i++;
  const t = (lf - ISO_LOGF[i - 1]) / (ISO_LOGF[i] - ISO_LOGF[i - 1]);
  return table[i - 1] + t * (table[i] - table[i - 1]);
}

// ------------------------------------------------------------------ generic magnitude curves
// spec: { kind: 'emph', B, C, fLo, fHi }  or  { kind: 'loud', phon, refPhon, cap, C, fHi }
export function makeCurve(fs, spec) {
  if (spec.kind !== 'loud') {
    const flt = makeFilter(fs, spec);
    return finish({ fs, kind: 'emph', flt, magLin: f => Math.hypot(...response(flt, f)) });
  }
  const refPhon = spec.refPhon ?? 83, cap = spec.cap ?? 12;
  const phon = Math.min(refPhon, Math.max(30, spec.phon));
  const table = isoCompTable(phon, refPhon);
  const hp = biquad('hp', spec.fHi ?? 5000, fs, 0.5), glo = biquad('hp', 20, fs, Math.SQRT1_2);
  const C = spec.C ?? 5;
  // ISO compensation only up to 1 kHz (where it is 0 dB by definition): the HF side is the patent
  // emphasis; ISO data above ~8 kHz would otherwise stack another +2...3 dB on top of it.
  const magLin = f => {
    const lfDb = f >= 1000 ? 0 : Math.max(-cap, Math.min(cap, isoCompDb(table, Math.max(f, 1))));
    const h = evalBQ(hp, 2 * Math.PI * f / fs);
    const hf = Math.hypot(1 - C * h[0], -C * h[1]);
    return Math.pow(10, lfDb / 20) * hf * Math.sqrt(mag2BQ(glo, f, fs));
  };
  return finish({ fs, kind: 'loud', phon, flt: null, magLin });
}

function finish(c) {
  c.magDb = f => 20 * Math.log10(c.magLin(f) + 1e-15);
  let m = 0;
  for (let i = 0; i <= 200; i++) m = Math.max(m, c.magDb(20 * Math.pow(1000, i / 200)));
  c.maxBoostDb = m;
  return c;
}

// in-place radix-2 complex FFT (inverse when inv = true, unscaled)
export function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
      }
    }
  }
}

// Linear-phase FIR with a given magnitude |H(f)| (linear). Delay = N/2 samples.
export function designFIRMag(magLin, fs, N = FIR_LEN) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    re[k] = magLin(k * fs / N);
    if (k > 0 && k < N / 2) re[N - k] = re[k];
  }
  fft(re, im, true);
  const h = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const src = (n - N / 2 + N) % N;
    const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / N) + 0.08 * Math.cos(4 * Math.PI * n / N);
    h[n] = (re[src] / N) * win;
  }
  return h;
}

// Back-compatible: FIR from an emphasis filter object, or from a curve.
export function designFIR(fltOrCurve, N = FIR_LEN) {
  if (fltOrCurve.magLin) return designFIRMag(fltOrCurve.magLin, fltOrCurve.fs, N);
  const flt = fltOrCurve;
  return designFIRMag(f => Math.hypot(...response(flt, f)), flt.fs, N);
}

// ------------------------------------------------------------------ loudness (BS.1770 K-weighting)
// Analog-prototype design as in libebur128: reproduces the BS.1770 48 kHz table
// and adapts to other sample rates.
export function kWeighting(fs) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    };
  })();
  const hpf = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan(Math.PI * f0 / fs);
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return { shelf, hpf, mag2: f => mag2BQ(shelf, f, fs) * mag2BQ(hpf, f, fs) };
}

// Welch power spectrum summed over channels (Hann, 50 % overlap). Returns {fs, nfft, p: Float64Array(nfft/2+1)}.
export function powerSpectrum(channels, fs, nfft = 4096) {
  const p = new Float64Array(nfft / 2 + 1), win = new Float64Array(nfft);
  for (let n = 0; n < nfft; n++) win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / nfft);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let frames = 0;
  for (const x of channels) {
    for (let s = 0; s + nfft <= x.length; s += nfft / 2) {
      for (let n = 0; n < nfft; n++) { re[n] = x[s + n] * win[n]; im[n] = 0; }
      fft(re, im, false);
      for (let k = 0; k <= nfft / 2; k++) p[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
  }
  if (frames) for (let k = 0; k < p.length; k++) p[k] /= frames;
  return { fs, nfft, p };
}

// Relative loudness [dB] of the spectrum after a magnitude curve and K-weighting (no gating).
// Only differences between conditions are meaningful.
export function spectrumLoudness(spec, magLin = () => 1, kw = kWeighting(spec.fs)) {
  let e = 0;
  for (let k = 1; k < spec.p.length; k++) {
    const f = k * spec.fs / spec.nfft, h = magLin(f);
    e += spec.p[k] * kw.mag2(f) * h * h;
  }
  return 10 * Math.log10(e + 1e-30);
}

// ------------------------------------------------------------------ statistics
function binomTail(n, k) {            // P(X >= k), X ~ Bin(n, 0.5)
  let s = 0, c = 1;                   // c = C(n, i)
  for (let i = 0; i <= n; i++) { if (i >= k) s += c; c = c * (n - i) / (i + 1); }
  return s / Math.pow(2, n);
}
export const abxP = (n, correct) => binomTail(n, correct);                       // one-sided
export const prefP = (n, k) => Math.min(1, 2 * Math.min(binomTail(n, k), binomTail(n, n - k)));  // two-sided
