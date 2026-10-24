// dsp.js - even-order integral/derivative emphasis (WO98/18203, JP-A H8-307184)
// H(z) = 1 - B * LP2(z) * Guard(z) - C * HP2(z)
// LP2/HP2: 2nd-order leaky double integrator / differentiator (bilinear, pre-warped).

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

// in-place radix-2 complex FFT (inverse when inv = true, unscaled)
function fft(re, im, inv) {
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

// Linear-phase FIR with |H| equal to the IIR design. Delay = N/2 samples.
export function designFIR(flt, N = FIR_LEN) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const r = response(flt, k * flt.fs / N);
    re[k] = Math.hypot(r[0], r[1]);
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
