
"use strict";
/* =====================================================================
   Twin-Electra engine: everything runs inside this page. Files never leave the browser.
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PRETTY = { healthy: "Healthy", tilt: "Rotor tilt eccentricity", xdisp: "X-displacement eccentricity" };
const pretty = c => PRETTY[c] || c.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());
const LEVEL = { ok: "#22d3a6", warn: "#fbbf24", alert: "#fb923c", crit: "#ef4444", idle: "#38bdf8" };
const PHASE = ["#38bdf8", "#fbbf24", "#f472b6"];
const CLS_COL = ["#22d3a6", "#38bdf8", "#a78bfa", "#fbbf24", "#f472b6", "#fb923c"];
const yieldUI = () => new Promise(r => setTimeout(r, 0));
const rgba = (h, a) => { h = h.replace("#", ""); return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`; };
function faultKind(c) { c = c.toLowerCase(); if (c === "healthy") return "none"; if (c.includes("tilt")) return "tilt"; if (c.includes("dynamic")) return "orbit"; return "disp"; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function randn(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const median = a => { const s = Array.from(a).sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const pctile = (a, p) => { const s = Array.from(a).sort((x, y) => x - y); const k = (s.length - 1) * p / 100, f = Math.floor(k), c = Math.min(f + 1, s.length - 1); return s[f] + (s[c] - s[f]) * (k - f); };
const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
const std = (a, m = mean(a)) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / a.length); };

/* ---------- labels from file names ---------- */
function parseLabel(fname) {
  const base = fname.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").toLowerCase();
  const nums = [...base.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  const sev = nums.length ? parseFloat(nums[nums.length - 1][1]) : 0;
  if (/healthy|normal/.test(base)) return ["healthy", 0];
  const t = base.replace(/stator\s*currents?/g, " ").replace(/\d+(?:\.\d+)?\s*%/g, " ").replace(/[^a-z]+/g, " ").trim();
  if (t.includes("tilt")) return ["tilt", sev];
  if (t.includes("disp") || /^x\b/.test(t)) return ["xdisp", sev];
  return [t.replace(/ /g, "_") || "unknown", sev];
}

/* ---------- reading files (xls, xlsx, csv) ---------- */
async function readRows(file) {
  const buf = await file.arrayBuffer();
  if (/\.(csv|txt)$/i.test(file.name)) {
    const lines = new TextDecoder().decode(buf).split(/\r?\n/).filter(l => l.trim());
    const delim = [",", ";", "\t"].map(d => [d, (lines[0] || "").split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    return lines.map(l => l.split(delim).map(x => x.trim()));
  }
  const wb = XLSX.read(buf, { type: "array" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
}
function unitScale(h) { h = String(h || "").toLowerCase(); if (/[\[(]ms[\])]/.test(h)) return 1e-3; if (/[\[(]us[\])]/.test(h) || /[\[(]µs[\])]/.test(h)) return 1e-6; if (/[\[(]ns[\])]/.test(h)) return 1e-9; return 1; }
function loadSignal(rows, name, opts = {}) {
  const isNum = v => v !== null && v !== undefined && v !== "" && isFinite(Number(v));
  let start = 0;
  while (start < rows.length && !(rows[start] || []).slice(0, 2).every(isNum)) start++;
  if (start >= rows.length) throw new Error(`'${name}': no numeric data found`);
  const header = start > 0 ? rows[start - 1] : null, data = rows.slice(start);
  const ncol = Math.max(...data.slice(0, 50).map(r => r.length));
  let cols = [];
  for (let c = 0; c < ncol; c++) {
    const arr = new Float64Array(data.length); let ok = 0;
    for (let r = 0; r < data.length; r++) { const v = data[r][c]; const x = (v === null || v === undefined || v === "") ? NaN : Number(v); arr[r] = x; if (isFinite(x)) ok++; }
    if (ok > data.length * 0.5) cols.push({ arr, name: header && header[c] != null ? String(header[c]) : "col " + (c + 1) });
  }
  const keep = []; for (let r = 0; r < data.length; r++) if (cols.every(c => isFinite(c.arr[r]))) keep.push(r);
  cols = cols.map(c => ({ name: c.name, arr: Float64Array.from(keep, r => c.arr[r]) }));
  const n = keep.length; if (n < 64) throw new Error(`'${name}': too few valid rows (${n})`);
  const first = cols[0].arr; let hasTime = n > 2;
  for (let i = 1; i < n && hasTime; i++) if (!(first[i] - first[i - 1] > 0)) hasTime = false;
  let fs = null;
  if (hasTime) { const d = new Float64Array(n - 1); for (let i = 1; i < n; i++) d[i - 1] = first[i] - first[i - 1]; fs = 1 / (median(d) * unitScale(cols[0].name)); }
  let use = hasTime ? cols.slice(1) : cols;
  if (opts.channels && opts.channels.length) use = opts.channels.map(i => cols[i - 1]).filter(Boolean);
  use = use.slice(0, 3);
  if (use.length < 3) throw new Error(`'${name}': need 3 phase-current columns, found ${use.length}`);
  if (opts.fs) fs = opts.fs;
  return { name, sig: use.map(c => c.arr), fs, cols: use.map(c => c.name), n };
}

/* ---------- FFT ---------- */
const _tw = {};
function twiddle(n) { if (_tw[n]) return _tw[n]; const c = new Float64Array(n / 2), s = new Float64Array(n / 2); for (let i = 0; i < n / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / n); s[i] = -Math.sin(2 * Math.PI * i / n); } return (_tw[n] = { c, s }); }
function fft(re, im) {
  const n = re.length, { c, s } = twiddle(n);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) { const wr = c[k * step], wi = s[k * step], a = i + k, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; } }
}
const _hann = {};
function hann(n, sym) { const key = n + (sym ? "s" : "p"); if (_hann[key]) return _hann[key]; const w = new Float64Array(n), d = sym ? n - 1 : n; for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / d); return (_hann[key] = w); }
function rfftMag(x, w) { const n = x.length, re = new Float64Array(n), im = new Float64Array(n); for (let i = 0; i < n; i++) re[i] = x[i] * (w ? w[i] : 1); fft(re, im); const m = new Float64Array(n / 2 + 1); for (let k = 0; k <= n / 2; k++) m[k] = Math.hypot(re[k], im[k]); return m; }
const pow2le = n => 2 ** Math.floor(Math.log2(n));

/* ---------- windows + features (time statistics + log-spectrum bands, per phase and for A+B+C) ---------- */
const NB = 48, FMAX = 0.25;
function makeWindows(sig, W, step, maxw) {
  const n = sig[0].length; if (n < W) throw new Error(`Record has ${n} samples, shorter than one window (${W}).`);
  let starts = []; for (let s = 0; s + W <= n; s += step) starts.push(s);
  if (starts.length > maxw) starts = Array.from({ length: maxw }, (_, i) => Math.floor(i * (n - W) / (maxw - 1)));
  return { starts, X: starts.map(s => sig.map(ch => ch.subarray(s, s + W))) };
}
function arraySplitSizes(n, parts) { const base = Math.floor(n / parts), extra = n % parts; return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0)); }
function featuresOf(Xw, scale) {
  const N = Xw.length, W = Xw[0][0].length, win = hann(W, true), D = 4 * (8 + NB), out = new Float64Array(N * D);
  const nb = Math.max(NB, Math.floor((W / 2 + 1) * FMAX)), sizes = arraySplitSizes(nb, NB);
  const buf = new Float64Array(W);
  for (let w = 0; w < N; w++) {
    const chs = Xw[w]; let o = w * D;
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < W; i++) buf[i] = ((s < 3) ? chs[s][i] : chs[0][i] + chs[1][i] + chs[2][i]) / scale;
      let m = 0; for (let i = 0; i < W; i++) m += buf[i]; m /= W;
      let m2 = 0, m3 = 0, m4 = 0, pk = 0, mn = Infinity, mx = -Infinity, sq = 0;
      for (let i = 0; i < W; i++) { const d = buf[i] - m, d2 = d * d; m2 += d2; m3 += d2 * d; m4 += d2 * d2; sq += buf[i] * buf[i]; const a = Math.abs(buf[i]); if (a > pk) pk = a; if (buf[i] < mn) mn = buf[i]; if (buf[i] > mx) mx = buf[i]; }
      m2 /= W; m3 /= W; m4 /= W; const sd = Math.sqrt(m2), rms = Math.sqrt(sq / W);
      out[o++] = m; out[o++] = sd; out[o++] = rms; out[o++] = m2 > 1e-24 ? m3 / (m2 * sd) : 0; out[o++] = m2 > 1e-24 ? m4 / (m2 * m2) - 3 : 0;
      out[o++] = pk; out[o++] = pk / (rms + 1e-12); out[o++] = mx - mn;
      const mag = rfftMag(buf, win); let p = 0;
      for (let b = 0; b < NB; b++) { let best = 0; for (let k = 0; k < sizes[b]; k++) { const v = mag[p++] / W; if (v > best) best = v; } out[o++] = Math.log10(best + 1e-9); }
    }
  }
  return { F: out, N, D };
}

/* ---------- linear algebra helpers ---------- */
function cholSolve(A, n, B, m) {
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j]; for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k]; if (s <= 1e-12) s = 1e-12;
    const d = Math.sqrt(s); A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) { let t = A[i * n + j]; const ri = i * n, rj = j * n; for (let k = 0; k < j; k++) t -= A[ri + k] * A[rj + k]; A[ri + j] = t / d; }
  }
  const X = Float64Array.from(B);
  for (let i = 0; i < n; i++) for (let c = 0; c < m; c++) { let s = X[i * m + c]; for (let k = 0; k < i; k++) s -= A[i * n + k] * X[k * m + c]; X[i * m + c] = s / A[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) for (let c = 0; c < m; c++) { let s = X[i * m + c]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * X[k * m + c]; X[i * m + c] = s / A[i * n + i]; }
  return X;
}
const sqDist = (A, ia, B, ib, d) => { let s = 0; const oa = ia * d, ob = ib * d; for (let k = 0; k < d; k++) { const t = A[oa + k] - B[ob + k]; s += t * t; } return s; };
function softmax(v, T = 1) { let mx = -Infinity; for (const x of v) mx = Math.max(mx, x * T); const e = Array.from(v, x => Math.exp(x * T - mx)), s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); }
function subsampleStrat(y, K, maxN, rng) { const per = Math.max(1, Math.floor(maxN / K)), out = []; for (let c = 0; c < K; c++) { const ii = []; for (let i = 0; i < y.length; i++) if (y[i] === c) ii.push(i); for (let i = ii.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ii[i], ii[j]] = [ii[j], ii[i]]; } out.push(...ii.slice(0, per)); } return out; }

/* ---------- model 1: KNN ---------- */
const trainKNN = (F, d, y, K) => ({ type: "knn", F, d, y: Int32Array.from(y), K, k: 7 });
function predKNN(m, X, d, i) {
  const n = m.y.length, dist = new Float64Array(n); for (let j = 0; j < n; j++) dist[j] = sqDist(X, i, m.F, j, d);
  const idx = Array.from({ length: n }, (_, j) => j).sort((a, b) => dist[a] - dist[b]).slice(0, m.k), p = new Float64Array(m.K); let tot = 0;
  for (const j of idx) { const w = 1 / (Math.sqrt(dist[j]) + 1e-9); p[m.y[j]] += w; tot += w; } return Array.from(p, v => v / tot);
}
/* ---------- model 2: ELM ---------- */
function trainELM(F, N, d, y, K, h = 400, C = 1e3, seed = 3) {
  const rng = mulberry32(seed), Wi = new Float64Array(d * h), b = new Float64Array(h);
  for (let i = 0; i < Wi.length; i++) Wi[i] = randn(rng) / Math.sqrt(d); for (let i = 0; i < h; i++) b[i] = randn(rng);
  const H = new Float64Array(N * h);
  for (let i = 0; i < N; i++) for (let a = 0; a < h; a++) { let s = b[a]; for (let k = 0; k < d; k++) s += F[i * d + k] * Wi[k * h + a]; H[i * h + a] = 1 / (1 + Math.exp(-s)); }
  const A = new Float64Array(h * h), B = new Float64Array(h * K);
  for (let i = 0; i < N; i++) { const r = i * h; for (let a = 0; a < h; a++) { const ha = H[r + a]; for (let c = 0; c <= a; c++) A[a * h + c] += ha * H[r + c]; B[a * K + y[i]] += ha; } }
  for (let a = 0; a < h; a++) { for (let c = a + 1; c < h; c++) A[a * h + c] = A[c * h + a]; A[a * h + a] += 1 / C; }
  return { type: "elm", d, h, K, Wi, b, beta: cholSolve(A, h, B, K) };
}
function predELM(m, X, d, i) {
  const o = new Float64Array(m.K);
  for (let a = 0; a < m.h; a++) { let s = m.b[a]; for (let k = 0; k < d; k++) s += X[i * d + k] * m.Wi[k * m.h + a]; const hv = 1 / (1 + Math.exp(-s)); for (let c = 0; c < m.K; c++) o[c] += hv * m.beta[a * m.K + c]; }
  const q = Array.from(o, v => Math.max(v, 0) + 1e-6), t = q.reduce((a, b) => a + b, 0); return q.map(v => v / t);
}
/* ---------- model 3: LS-SVM (RBF, one-vs-rest) ---------- */
function trainLSSVM(F, d, y, K, rng, maxN = 600, gamma = 60) {
  const sel = subsampleStrat(y, K, maxN, rng), n = sel.length, X = new Float64Array(n * d), yy = sel.map(i => y[i]);
  sel.forEach((i, r) => X.set(F.subarray(i * d, i * d + d), r * d));
  const D = new Float64Array(n * n), samp = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const v = sqDist(X, a, X, b, d); D[a * n + b] = D[b * n + a] = v; if ((a * 7 + b) % 11 === 0) samp.push(v); }
  const sig2 = Math.max(median(samp), 1e-6), M = new Float64Array(n * n);
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) M[a * n + b] = Math.exp(-D[a * n + b] / (2 * sig2)) + (a === b ? 1 / gamma : 0);
  const rhs = new Float64Array(n * (K + 1)); for (let i = 0; i < n; i++) { rhs[i * (K + 1)] = 1; for (let c = 0; c < K; c++) rhs[i * (K + 1) + 1 + c] = yy[i] === c ? 1 : -1; }
  const S = cholSolve(M, n, rhs, K + 1), s1 = (() => { let t = 0; for (let i = 0; i < n; i++) t += S[i * (K + 1)]; return t; })(), bias = new Float64Array(K), alpha = new Float64Array(n * K);
  for (let c = 0; c < K; c++) { let t = 0; for (let i = 0; i < n; i++) t += S[i * (K + 1) + 1 + c]; bias[c] = t / s1; for (let i = 0; i < n; i++) alpha[i * K + c] = S[i * (K + 1) + 1 + c] - S[i * (K + 1)] * bias[c]; }
  return { type: "lssvm", X, n, d, K, sig2, alpha, bias };
}
function predLSSVM(m, X, d, i) { const o = Float64Array.from(m.bias); for (let j = 0; j < m.n; j++) { const kv = Math.exp(-sqDist(X, i, m.X, j, d) / (2 * m.sig2)); for (let c = 0; c < m.K; c++) o[c] += kv * m.alpha[j * m.K + c]; } return softmax(o, 3); }
/* ---------- model 4: BPNN (one hidden layer, Adam) ---------- */
async function trainMLP(F, N, d, y, K, rng, hid = 48, epochs = 70, lr = 2e-3, bs = 32, onEp) {
  const W1 = new Float64Array(d * hid), b1 = new Float64Array(hid), W2 = new Float64Array(hid * K), b2 = new Float64Array(K);
  for (let i = 0; i < W1.length; i++) W1[i] = randn(rng) * Math.sqrt(2 / d); for (let i = 0; i < W2.length; i++) W2[i] = randn(rng) * Math.sqrt(2 / hid);
  const P = [W1, b1, W2, b2], Mm = P.map(a => new Float64Array(a.length)), Vv = P.map(a => new Float64Array(a.length)), G = P.map(a => new Float64Array(a.length));
  const cnt = new Float64Array(K); for (const c of y) cnt[c]++; const cw = Array.from(cnt, v => N / (K * Math.max(v, 1)));
  const order = Array.from({ length: N }, (_, i) => i); let t = 0;
  const hv = new Float64Array(hid), out = new Float64Array(K), dh = new Float64Array(hid);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let s = 0; s < N; s += bs) {
      G.forEach(g => g.fill(0)); const batch = order.slice(s, s + bs);
      for (const i of batch) {
        for (let a = 0; a < hid; a++) { let z = b1[a]; for (let k = 0; k < d; k++) z += F[i * d + k] * W1[k * hid + a]; hv[a] = z > 0 ? z : 0; }
        for (let c = 0; c < K; c++) { let z = b2[c]; for (let a = 0; a < hid; a++) z += hv[a] * W2[a * K + c]; out[c] = z; }
        const p = softmax(out); dh.fill(0);
        for (let c = 0; c < K; c++) { const g = (p[c] - (y[i] === c ? 1 : 0)) * cw[y[i]] / batch.length; G[3][c] += g; for (let a = 0; a < hid; a++) { G[2][a * K + c] += hv[a] * g; dh[a] += W2[a * K + c] * g; } }
        for (let a = 0; a < hid; a++) if (hv[a] > 0) { G[1][a] += dh[a]; for (let k = 0; k < d; k++) G[0][k * hid + a] += F[i * d + k] * dh[a]; }
      }
      t++; const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      for (let q = 0; q < 4; q++) { const p = P[q], g = G[q], mm = Mm[q], vv = Vv[q], wd = q % 2 === 0 ? 1e-4 : 0; for (let k = 0; k < p.length; k++) { const gk = g[k] + wd * p[k]; mm[k] = 0.9 * mm[k] + 0.1 * gk; vv[k] = 0.999 * vv[k] + 0.001 * gk * gk; p[k] -= lr * (mm[k] / c1) / (Math.sqrt(vv[k] / c2) + 1e-8); } }
    }
    if (ep % 5 === 0) { if (onEp) onEp(ep / epochs); await yieldUI(); }
  }
  return { type: "mlp", d, hid, K, W1, b1, W2, b2 };
}
function predMLP(m, X, d, i) { const hv = new Float64Array(m.hid), o = new Float64Array(m.K); for (let a = 0; a < m.hid; a++) { let z = m.b1[a]; for (let k = 0; k < d; k++) z += X[i * d + k] * m.W1[k * m.hid + a]; hv[a] = z > 0 ? z : 0; } for (let c = 0; c < m.K; c++) { let z = m.b2[c]; for (let a = 0; a < m.hid; a++) z += hv[a] * m.W2[a * m.K + c]; o[c] = z; } return softmax(o); }
/* ---------- model 5: Random forest (classification) + regression trees for severity ---------- */
function buildTree(F, d, idx, tgt, K, w, rng, o) {
  const nodes = [], reg = K === 0;
  const leaf = ids => { if (reg) { let s = 0; for (const i of ids) s += tgt[i]; return { v: s / ids.length }; } const v = new Float64Array(K); let t = 0; for (const i of ids) { v[tgt[i]] += w[tgt[i]]; t += w[tgt[i]]; } return { v: Array.from(v, x => x / t) }; };
  const feats = Array.from({ length: d }, (_, i) => i);
  function rec(ids, depth) {
    const id = nodes.length; nodes.push(null);
    let pure = true; for (let k = 1; k < ids.length; k++) if (tgt[ids[k]] !== tgt[ids[0]]) { pure = false; break; }
    if (pure || depth >= o.maxDepth || ids.length < 2 * o.minLeaf) { nodes[id] = leaf(ids); return id; }
    for (let i = 0; i < o.mtry; i++) { const j = i + Math.floor(rng() * (d - i)); [feats[i], feats[j]] = [feats[j], feats[i]]; }
    let best = { g: Infinity }, tot = null, T = 0, sumAll = 0;
    if (reg) { for (const i of ids) sumAll += tgt[i]; } else { tot = new Float64Array(K); for (const i of ids) { tot[tgt[i]] += w[tgt[i]]; T += w[tgt[i]]; } }
    for (let q = 0; q < o.mtry; q++) {
      const f = feats[q], order = Array.from(ids).sort((a, b) => F[a * d + f] - F[b * d + f]);
      const left = reg ? null : new Float64Array(K); let L = 0, sumL = 0;
      for (let p = 0; p < order.length - 1; p++) {
        const i = order[p]; if (reg) { sumL += tgt[i]; L++; } else { left[tgt[i]] += w[tgt[i]]; L += w[tgt[i]]; }
        const v = F[i * d + f], v2 = F[order[p + 1] * d + f]; if (v2 - v < 1e-12 || p + 1 < o.minLeaf || order.length - p - 1 < o.minLeaf) continue;
        let g;
        if (reg) { const Rn = order.length - L, sumR = sumAll - sumL; g = -(sumL * sumL / L + sumR * sumR / Rn); }
        else { const R = T - L; let gl = 0, gr = 0; for (let k = 0; k < K; k++) { const a = left[k] / L, b = (tot[k] - left[k]) / R; gl += a * a; gr += b * b; } g = (L * (1 - gl) + R * (1 - gr)) / T; }
        if (g < best.g) best = { g, f, t: (v + v2) / 2 };
      }
    }
    if (best.g === Infinity) { nodes[id] = leaf(ids); return id; }
    const l = [], r = []; for (const i of ids) (F[i * d + best.f] <= best.t ? l : r).push(i);
    if (!l.length || !r.length) { nodes[id] = leaf(ids); return id; }
    const li = rec(l, depth + 1), ri = rec(r, depth + 1); nodes[id] = { f: best.f, t: best.t, l: li, r: ri }; return id;
  }
  rec(idx, 0); return nodes;
}
async function trainForest(F, N, d, tgt, K, rng, nTrees, o, onP) {
  const w = K ? (() => { const c = new Float64Array(K); for (const t of tgt) c[t]++; return Array.from(c, v => N / (K * Math.max(v, 1))); })() : null, trees = [];
  for (let t = 0; t < nTrees; t++) {
    const idx = Int32Array.from({ length: N }, () => Math.floor(rng() * N));
    trees.push(buildTree(F, d, idx, tgt, K, w, rng, o)); if (t % 10 === 9) { if (onP) onP(t / nTrees); await yieldUI(); }
  }
  return { type: K ? "rf" : "rfreg", trees, K, d };
}
function predTree(nodes, X, d, i) { let n = nodes[0]; while (n.f !== undefined) n = nodes[X[i * d + n.f] <= n.t ? n.l : n.r]; return n.v; }
function predRF(m, X, d, i) { const p = new Float64Array(m.K); for (const t of m.trees) { const v = predTree(t, X, d, i); for (let c = 0; c < m.K; c++) p[c] += v[c]; } return Array.from(p, v => v / m.trees.length); }
function predRFreg(m, X, d, i) { let s = 0; for (const t of m.trees) s += predTree(t, X, d, i); return s / m.trees.length; }
/* kernel ridge (severity) */
function trainKRR(F, d, tgt, rng, maxN = 500, lam = 0.05) {
  const sel = Array.from({ length: tgt.length }, (_, i) => i); for (let i = sel.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sel[i], sel[j]] = [sel[j], sel[i]]; }
  const ss = sel.slice(0, maxN), n = ss.length, X = new Float64Array(n * d); ss.forEach((i, r) => X.set(F.subarray(i * d, i * d + d), r * d));
  const D = new Float64Array(n * n), samp = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const v = sqDist(X, a, X, b, d); D[a * n + b] = D[b * n + a] = v; if ((a * 7 + b) % 11 === 0) samp.push(v); }
  const sig2 = Math.max(median(samp), 1e-6), M = new Float64Array(n * n); for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) M[a * n + b] = Math.exp(-D[a * n + b] / (2 * sig2)) + (a === b ? lam : 0);
  const yv = ss.map(i => tgt[i]), ym = mean(yv), alpha = cholSolve(M, n, Float64Array.from(yv, v => v - ym), 1);
  return { type: "krr", X, n, d, sig2, alpha, ym };
}
function predKRR(m, X, d, i) { let s = m.ym; for (let j = 0; j < m.n; j++) s += Math.exp(-sqDist(X, i, m.X, j, d) / (2 * m.sig2)) * m.alpha[j]; return s; }

function trainELMreg(F, N, d, tgt, h = 300, C = 1e3, seed = 5) {
  const rng = mulberry32(seed), Wi = new Float64Array(d * h), b = new Float64Array(h); for (let i = 0; i < Wi.length; i++) Wi[i] = randn(rng) / Math.sqrt(d); for (let i = 0; i < h; i++) b[i] = randn(rng);
  const ym = mean(tgt), A = new Float64Array(h * h), B = new Float64Array(h), H = new Float64Array(h);
  for (let i = 0; i < N; i++) { for (let a = 0; a < h; a++) { let z = b[a]; for (let k = 0; k < d; k++) z += F[i * d + k] * Wi[k * h + a]; H[a] = 1 / (1 + Math.exp(-z)); } for (let a = 0; a < h; a++) { for (let c = 0; c <= a; c++) A[a * h + c] += H[a] * H[c]; B[a] += H[a] * (tgt[i] - ym); } }
  for (let a = 0; a < h; a++) { for (let c = a + 1; c < h; c++) A[a * h + c] = A[c * h + a]; A[a * h + a] += 1 / C; }
  return { type: "elmreg", d, h, Wi, b, beta: cholSolve(A, h, B, 1), ym };
}
function predELMreg(m, X, d, i) { let o = m.ym; for (let a = 0; a < m.h; a++) { let z = m.b[a]; for (let k = 0; k < d; k++) z += X[i * d + k] * m.Wi[k * m.h + a]; o += m.beta[a] / (1 + Math.exp(-z)); } return o; }
function predKNNreg(m, X, d, i) { const n = m.tgt.length, dist = new Float64Array(n); for (let j = 0; j < n; j++) dist[j] = sqDist(X, i, m.F, j, d); const idx = Array.from({ length: n }, (_, j) => j).sort((a, b) => dist[a] - dist[b]).slice(0, 5); let sw = 0, sv = 0; for (const j of idx) { const w = 1 / (Math.sqrt(dist[j]) + 1e-9); sw += w; sv += w * m.tgt[j]; } return sv / sw; }

/* ---------- deep learning: 1D-CNN on the raw 3-phase current window ---------- */
const CNN_NAME = "1D-CNN (DL)", C1 = 8, K1 = 9, C2 = 16, K2 = 7, HID = 32;
function cnnPrep(w, scale) { const W = w[0].length, L = W >> 2, x = new Float32Array(3 * L); for (let c = 0; c < 3; c++) for (let i = 0; i < L; i++) { const a = c ? w[c] : w[0]; let t = 0; for (let j = 0; j < 4; j++) t += w[c][i * 4 + j]; x[c * L + i] = t / 4 / scale; } return x; }
function cnnInit(L, K, rng) {
  const P1 = L >> 2, P2 = P1 >> 2, flat = C2 * P2, he = (n, fan) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = randn(rng) * Math.sqrt(2 / fan); return a; };
  return { L, K, P1, P2, flat, W1: he(C1 * 3 * K1, 3 * K1), b1: new Float32Array(C1), W2: he(C2 * C1 * K2, C1 * K2), b2: new Float32Array(C2), F1: he(HID * flat, flat), fb1: new Float32Array(HID), F2: he((K + 1) * HID, HID), fb2: new Float32Array(K + 1) };
}
function cnnForward(m, x, c) {
  const { L, K, P1, P2, flat } = m, a1 = c.a1, a2 = c.a2, p1 = c.p1, p2 = c.p2, am1 = c.am1, am2 = c.am2, h = c.h, out = c.out;
  for (let o = 0; o < C1; o++) for (let t = 0; t < L; t++) { let s = m.b1[o]; for (let ch = 0; ch < 3; ch++) { const wb = (o * 3 + ch) * K1, xb = ch * L; for (let k = 0; k < K1; k++) { const i = t + k - 4; if (i >= 0 && i < L) s += m.W1[wb + k] * x[xb + i]; } } a1[o * L + t] = s > 0 ? s : 0; }
  for (let o = 0; o < C1; o++) for (let t = 0; t < P1; t++) { let b = -1, bv = -1; for (let j = 0; j < 4; j++) { const v = a1[o * L + t * 4 + j]; if (v > bv) { bv = v; b = t * 4 + j; } } p1[o * P1 + t] = bv; am1[o * P1 + t] = b; }
  for (let o = 0; o < C2; o++) for (let t = 0; t < P1; t++) { let s = m.b2[o]; for (let ch = 0; ch < C1; ch++) { const wb = (o * C1 + ch) * K2, xb = ch * P1; for (let k = 0; k < K2; k++) { const i = t + k - 3; if (i >= 0 && i < P1) s += m.W2[wb + k] * p1[xb + i]; } } a2[o * P1 + t] = s > 0 ? s : 0; }
  for (let o = 0; o < C2; o++) for (let t = 0; t < P2; t++) { let b = -1, bv = -1; for (let j = 0; j < 4; j++) { const v = a2[o * P1 + t * 4 + j]; if (v > bv) { bv = v; b = t * 4 + j; } } p2[o * P2 + t] = bv; am2[o * P2 + t] = b; }
  for (let j = 0; j < HID; j++) { let s = m.fb1[j]; const fb = j * flat; for (let i = 0; i < flat; i++) s += m.F1[fb + i] * p2[i]; h[j] = s > 0 ? s : 0; }
  for (let q = 0; q <= K; q++) { let s = m.fb2[q]; for (let j = 0; j < HID; j++) s += m.F2[q * HID + j] * h[j]; out[q] = s; }
}
const cnnCache = m => ({ a1: new Float32Array(C1 * m.L), a2: new Float32Array(C2 * m.P1), p1: new Float32Array(C1 * m.P1), p2: new Float32Array(m.flat), am1: new Int32Array(C1 * m.P1), am2: new Int32Array(C2 * m.P2), h: new Float32Array(HID), out: new Float32Array(m.K + 1) });
function cnnBackward(m, x, c, dout, G) {
  const { L, K, P1, P2, flat } = m, dh = new Float32Array(HID), dp2 = new Float32Array(flat), da2 = new Float32Array(C2 * P1), dp1 = new Float32Array(C1 * P1), da1 = new Float32Array(C1 * L);
  for (let q = 0; q <= K; q++) { const g = dout[q]; G.fb2[q] += g; for (let j = 0; j < HID; j++) { G.F2[q * HID + j] += g * c.h[j]; dh[j] += g * m.F2[q * HID + j]; } }
  for (let j = 0; j < HID; j++) if (c.h[j] > 0) { const g = dh[j]; G.fb1[j] += g; const fb = j * flat; for (let i = 0; i < flat; i++) { G.F1[fb + i] += g * c.p2[i]; dp2[i] += g * m.F1[fb + i]; } }
  for (let o = 0; o < C2; o++) for (let t = 0; t < P2; t++) { const idx = c.am2[o * P2 + t]; if (c.a2[o * P1 + idx] > 0) da2[o * P1 + idx] += dp2[o * P2 + t]; }
  for (let o = 0; o < C2; o++) for (let t = 0; t < P1; t++) { const g = da2[o * P1 + t]; if (!g) continue; G.b2[o] += g; for (let ch = 0; ch < C1; ch++) { const wb = (o * C1 + ch) * K2, xb = ch * P1; for (let k = 0; k < K2; k++) { const i = t + k - 3; if (i >= 0 && i < P1) { G.W2[wb + k] += g * c.p1[xb + i]; dp1[xb + i] += g * m.W2[wb + k]; } } } }
  for (let o = 0; o < C1; o++) for (let t = 0; t < P1; t++) { const idx = c.am1[o * P1 + t]; if (c.a1[o * L + idx] > 0) da1[o * L + idx] += dp1[o * P1 + t]; }
  for (let o = 0; o < C1; o++) for (let t = 0; t < L; t++) { const g = da1[o * L + t]; if (!g) continue; G.b1[o] += g; for (let ch = 0; ch < 3; ch++) { const wb = (o * 3 + ch) * K1, xb = ch * L; for (let k = 0; k < K1; k++) { const i = t + k - 4; if (i >= 0 && i < L) G.W1[wb + k] += g * x[xb + i]; } } }
}
const CNN_KEYS = ["W1", "b1", "W2", "b2", "F1", "fb1", "F2", "fb2"];
async function trainCNN(X, y, sev, K, scale, sevRef, rng, onP, epochs = 45, lr = 3e-3, bs = 16) {
  const L = X[0][0].length >> 2; if (L < 16 || (L & 15)) throw new Error("window length must be a multiple of 64 for the 1D-CNN");
  const m = cnnInit(L, K, rng), idxAll = subsampleStrat(y, K, 900, rng), N = idxAll.length, data = idxAll.map(i => cnnPrep(X[i], scale)), yy = idxAll.map(i => y[i]), tt = idxAll.map(i => sev[i] / sevRef);
  const cnt = new Float64Array(K); yy.forEach(c => cnt[c]++); const cw = Array.from(cnt, v => N / (K * Math.max(v, 1)));
  const G = {}, Mo = {}, Ve = {}; CNN_KEYS.forEach(k => { G[k] = new Float32Array(m[k].length); Mo[k] = new Float32Array(m[k].length); Ve[k] = new Float32Array(m[k].length); });
  const cache = cnnCache(m), order = Array.from({ length: N }, (_, i) => i), dout = new Float32Array(K + 1); let t = 0, lastLoss = 0, acc = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0, ok = 0;
    for (let s = 0; s < N; s += bs) {
      CNN_KEYS.forEach(k => G[k].fill(0)); const batch = order.slice(s, s + bs);
      for (const i of batch) {
        cnnForward(m, data[i], cache); const pr = softmax(Array.from(cache.out.subarray(0, K)));
        for (let q = 0; q < K; q++) dout[q] = (pr[q] - (yy[i] === q ? 1 : 0)) * cw[yy[i]] / batch.length;
        const e = cache.out[K] - tt[i]; dout[K] = 2 * e / batch.length; loss += -Math.log(pr[yy[i]] + 1e-9) + e * e; if (pr.indexOf(Math.max(...pr)) === yy[i]) ok++;
        cnnBackward(m, data[i], cache, dout, G);
      }
      t++; const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      for (const k of CNN_KEYS) { const p = m[k], g = G[k], mm = Mo[k], vv = Ve[k]; for (let q = 0; q < p.length; q++) { const gq = g[q]; mm[q] = 0.9 * mm[q] + 0.1 * gq; vv[q] = 0.999 * vv[q] + 0.001 * gq * gq; p[q] -= lr * (mm[q] / c1) / (Math.sqrt(vv[q] / c2) + 1e-8); } }
    }
    lastLoss = loss / N; acc = ok / N; if (onP) onP((ep + 1) / epochs, ep + 1, lastLoss, acc); await yieldUI();
  }
  m.sevRef = sevRef; m.info = { epochs, windows: N, acc, loss: lastLoss, params: CNN_KEYS.reduce((a, k) => a + m[k].length, 0), used: acc >= 0.7 }; return m;
}
function cnnPredict(m, w, scale) { const c = cnnCache(m); cnnForward(m, cnnPrep(w, scale), c); return { p: softmax(Array.from(c.out.subarray(0, m.K))), sev: Math.max(c.out[m.K], 0) * m.sevRef }; }
/* ---------- recurrent deep-learning models: LSTM, BiLSTM, GRU, CNN-LSTM (manual BPTT) ---------- */
const SEQ_DEF = { lstm: { name: "LSTM (DL)", H: 16, cell: "lstm", dirs: 1 }, bilstm: { name: "BiLSTM (DL)", H: 12, cell: "lstm", dirs: 2 }, gru: { name: "GRU (DL)", H: 16, cell: "gru", dirs: 1 }, cnnlstm: { name: "CNN-LSTM (DL)", H: 16, cell: "lstm", dirs: 1, front: true } };
const sig_ = z => 1 / (1 + Math.exp(-z));
function seqInit(kind, K, L, rng) {
  const d = SEQ_DEF[kind], G = d.cell === "gru" ? 3 : 4, D = d.front ? C1 : 24, T = d.front ? (L >> 2) : (L >> 3), H = d.H, hf = d.dirs * H;
  const rn = (n, sc) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = randn(rng) * sc; return a; };
  const m = { kind, K, L, T, D, H, G, dirs: d.dirs, cell: d.cell, front: !!d.front, hf, keys: [] };
  for (let q = 0; q < d.dirs; q++) { m["Wx" + q] = rn(G * H * D, Math.sqrt(1 / D)); m["Wh" + q] = rn(G * H * H, Math.sqrt(1 / H)); const b = new Float32Array(G * H); if (d.cell === "lstm") for (let j = 0; j < H; j++) b[H + j] = 1; m["b" + q] = b; m.keys.push("Wx" + q, "Wh" + q, "b" + q); }
  m.Wo = rn((K + 1) * hf, Math.sqrt(1 / hf)); m.bo = new Float32Array(K + 1); m.keys.push("Wo", "bo");
  if (d.front) { m.W1 = rn(C1 * 3 * K1, Math.sqrt(2 / (3 * K1))); m.b1 = new Float32Array(C1); m.keys.push("W1", "b1"); }
  return m;
}
function seqCache(m) {
  const { T, H, G, D, dirs, L } = m, c = { xs: new Float32Array(T * D), hs: [], cs: [], gt: [], un: [], hfin: new Float32Array(m.hf), out: new Float32Array(m.K + 1) };
  for (let q = 0; q < dirs; q++) { c.hs.push(new Float32Array((T + 1) * H)); c.cs.push(new Float32Array((T + 1) * H)); c.gt.push(new Float32Array(T * G * H)); c.un.push(new Float32Array(T * H)); }
  if (m.front) { c.a1 = new Float32Array(C1 * L); c.p1 = new Float32Array(C1 * T); c.am1 = new Int32Array(C1 * T); }
  return c;
}
function seqFrontForward(m, x, c) {
  const { L, T } = m;
  if (!m.front) { for (let t = 0; t < T; t++) for (let ch = 0; ch < 3; ch++) for (let j = 0; j < 8; j++) c.xs[t * 24 + ch * 8 + j] = x[ch * L + t * 8 + j]; return; }
  for (let o = 0; o < C1; o++) for (let t = 0; t < L; t++) { let s = m.b1[o]; for (let ch = 0; ch < 3; ch++) { const wb = (o * 3 + ch) * K1, xb = ch * L; for (let k = 0; k < K1; k++) { const i = t + k - 4; if (i >= 0 && i < L) s += m.W1[wb + k] * x[xb + i]; } } c.a1[o * L + t] = s > 0 ? s : 0; }
  for (let o = 0; o < C1; o++) for (let t = 0; t < T; t++) { let b = -1, bv = -1; for (let j = 0; j < 4; j++) { const v = c.a1[o * L + t * 4 + j]; if (v > bv) { bv = v; b = t * 4 + j; } } c.p1[o * T + t] = bv; c.am1[o * T + t] = b; c.xs[t * C1 + o] = bv; }
}
function seqForward(m, x, c) {
  const { T, D, H, G, dirs } = m; seqFrontForward(m, x, c); const pre = new Float32Array(G * H), gru = m.cell === "gru";
  for (let q = 0; q < dirs; q++) {
    const Wx = m["Wx" + q], Wh = m["Wh" + q], b = m["b" + q], rev = q === 1, hs = c.hs[q], cs = c.cs[q], gt = c.gt[q], un = c.un[q]; hs.fill(0); cs.fill(0);
    for (let p = 0; p < T; p++) {
      const t = rev ? T - 1 - p : p, xo = t * D, ho = p * H, so = (p + 1) * H, go = p * G * H;
      const rows = gru ? 2 * H : 4 * H;
      for (let r = 0; r < G * H; r++) { let s = b[r]; for (let k = 0; k < D; k++) s += Wx[r * D + k] * c.xs[xo + k]; if (r < rows) for (let k = 0; k < H; k++) s += Wh[r * H + k] * hs[ho + k]; pre[r] = s; }
      if (!gru) { for (let j = 0; j < H; j++) { const i = sig_(pre[j]), f = sig_(pre[H + j]), g = Math.tanh(pre[2 * H + j]), o = sig_(pre[3 * H + j]); gt[go + j] = i; gt[go + H + j] = f; gt[go + 2 * H + j] = g; gt[go + 3 * H + j] = o; const cc = f * cs[ho + j] + i * g; cs[so + j] = cc; hs[so + j] = o * Math.tanh(cc); } }
      else { for (let j = 0; j < H; j++) { const z = sig_(pre[j]), r = sig_(pre[H + j]); let u = 0; for (let k = 0; k < H; k++) u += Wh[(2 * H + j) * H + k] * hs[ho + k]; const n = Math.tanh(pre[2 * H + j] + r * u); gt[go + j] = z; gt[go + H + j] = r; gt[go + 2 * H + j] = n; un[p * H + j] = u; hs[so + j] = (1 - z) * n + z * hs[ho + j]; } }
    }
    for (let j = 0; j < H; j++) c.hfin[q * H + j] = c.hs[q][T * H + j];
  }
  for (let o = 0; o <= m.K; o++) { let s = m.bo[o]; for (let k = 0; k < m.hf; k++) s += m.Wo[o * m.hf + k] * c.hfin[k]; c.out[o] = s; }
}
function seqBackward(m, x, c, dout, Gr) {
  const { T, D, H, G, dirs, K, hf, L } = m, gru = m.cell === "gru", dhf = new Float32Array(hf), dxs = new Float32Array(T * D);
  for (let o = 0; o <= K; o++) { const g = dout[o]; Gr.bo[o] += g; for (let k = 0; k < hf; k++) { Gr.Wo[o * hf + k] += g * c.hfin[k]; dhf[k] += g * m.Wo[o * hf + k]; } }
  for (let q = 0; q < dirs; q++) {
    const Wx = m["Wx" + q], Wh = m["Wh" + q], dWx = Gr["Wx" + q], dWh = Gr["Wh" + q], db = Gr["b" + q], rev = q === 1, hs = c.hs[q], cs = c.cs[q], gt = c.gt[q], un = c.un[q];
    let dh = new Float32Array(H), dc = new Float32Array(H), dhp = new Float32Array(H), dcp = new Float32Array(H); for (let j = 0; j < H; j++) dh[j] = dhf[q * H + j]; const da = new Float32Array(G * H), dun = new Float32Array(H);
    for (let p = T - 1; p >= 0; p--) {
      const t = rev ? T - 1 - p : p, xo = t * D, ho = p * H, so = (p + 1) * H, go = p * G * H; dhp.fill(0); dcp.fill(0);
      if (!gru) { for (let j = 0; j < H; j++) { const tc = Math.tanh(cs[so + j]), i = gt[go + j], f = gt[go + H + j], g = gt[go + 2 * H + j], o = gt[go + 3 * H + j], dcj = dc[j] + dh[j] * o * (1 - tc * tc); da[j] = dcj * g * i * (1 - i); da[H + j] = dcj * cs[ho + j] * f * (1 - f); da[2 * H + j] = dcj * i * (1 - g * g); da[3 * H + j] = dh[j] * tc * o * (1 - o); dcp[j] = dcj * f; } }
      else { for (let j = 0; j < H; j++) { const z = gt[go + j], r = gt[go + H + j], n = gt[go + 2 * H + j], hp = hs[ho + j], dz = dh[j] * (hp - n), dn = dh[j] * (1 - z), dan = dn * (1 - n * n); da[j] = dz * z * (1 - z); da[H + j] = dan * un[p * H + j] * r * (1 - r); da[2 * H + j] = dan; dun[j] = dan * r; dhp[j] += dh[j] * z; } }
      const rows = gru ? 2 * H : 4 * H;
      for (let r = 0; r < G * H; r++) { const g = da[r]; if (!g) continue; db[r] += g; for (let k = 0; k < D; k++) { dWx[r * D + k] += g * c.xs[xo + k]; dxs[xo + k] += Wx[r * D + k] * g; } if (r < rows) for (let k = 0; k < H; k++) { dWh[r * H + k] += g * hs[ho + k]; dhp[k] += Wh[r * H + k] * g; } }
      if (gru) for (let j = 0; j < H; j++) { const g = dun[j]; if (!g) continue; for (let k = 0; k < H; k++) { dWh[(2 * H + j) * H + k] += g * hs[ho + k]; dhp[k] += Wh[(2 * H + j) * H + k] * g; } }
      [dh, dhp] = [dhp, dh]; [dc, dcp] = [dcp, dc];
    }
  }
  if (m.front) {
    const da1 = new Float32Array(C1 * L);
    for (let o = 0; o < C1; o++) for (let t = 0; t < T; t++) { const idx = c.am1[o * T + t]; if (c.a1[o * L + idx] > 0) da1[o * L + idx] += dxs[t * C1 + o]; }
    for (let o = 0; o < C1; o++) for (let t = 0; t < L; t++) { const g = da1[o * L + t]; if (!g) continue; Gr.b1[o] += g; for (let ch = 0; ch < 3; ch++) { const wb = (o * 3 + ch) * K1, xb = ch * L; for (let k = 0; k < K1; k++) { const i = t + k - 4; if (i >= 0 && i < L) Gr.W1[wb + k] += g * x[xb + i]; } } }
  }
}
async function trainSeq(kind, X, y, sev, K, scale, sevRef, rng, onP, epochs = 70, lr = 8e-3, bs = 16) {
  const L = X[0][0].length >> 2; if (L < 32 || (L & 15)) throw new Error("window length must be a multiple of 64");
  const m = seqInit(kind, K, L, rng), idxAll = subsampleStrat(y, K, 500, rng), N = idxAll.length, data = idxAll.map(i => cnnPrep(X[i], scale)), yy = idxAll.map(i => y[i]), tt = idxAll.map(i => sev[i] / sevRef);
  const cnt = new Float64Array(K); yy.forEach(c => cnt[c]++); const cw = Array.from(cnt, v => N / (K * Math.max(v, 1)));
  const Gr = {}, Mo = {}, Ve = {}; m.keys.forEach(k => { Gr[k] = new Float32Array(m[k].length); Mo[k] = new Float32Array(m[k].length); Ve[k] = new Float32Array(m[k].length); });
  const cache = seqCache(m), order = Array.from({ length: N }, (_, i) => i), dout = new Float32Array(K + 1); let t = 0, loss = 0, ok = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } loss = 0; ok = 0;
    for (let s = 0; s < N; s += bs) {
      m.keys.forEach(k => Gr[k].fill(0)); const batch = order.slice(s, s + bs);
      for (const i of batch) {
        seqForward(m, data[i], cache); const pr = softmax(Array.from(cache.out.subarray(0, K)));
        for (let q = 0; q < K; q++) dout[q] = (pr[q] - (yy[i] === q ? 1 : 0)) * cw[yy[i]] / batch.length;
        const e = cache.out[K] - tt[i]; dout[K] = 2 * e / batch.length; loss += -Math.log(pr[yy[i]] + 1e-9) + e * e; if (pr.indexOf(Math.max(...pr)) === yy[i]) ok++;
        seqBackward(m, data[i], cache, dout, Gr);
      }
      let gn = 0; for (const k of m.keys) { const g = Gr[k]; for (let q = 0; q < g.length; q++) gn += g[q] * g[q]; } gn = Math.sqrt(gn); const clip = gn > 5 ? 5 / gn : 1;
      t++; const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      for (const k of m.keys) { const p = m[k], g = Gr[k], mm = Mo[k], vv = Ve[k]; for (let q = 0; q < p.length; q++) { const gq = g[q] * clip; mm[q] = 0.9 * mm[q] + 0.1 * gq; vv[q] = 0.999 * vv[q] + 0.001 * gq * gq; p[q] -= lr * (mm[q] / c1) / (Math.sqrt(vv[q] / c2) + 1e-8); } }
    }
    if (onP) onP((ep + 1) / epochs, ep + 1, loss / N, ok / N); await yieldUI();
  }
  m.sevRef = sevRef; m.info = { epochs, windows: N, acc: ok / N, loss: loss / N, params: m.keys.reduce((a, k) => a + m[k].length, 0), used: ok / N >= 0.7 }; return m;
}
function seqPredict(m, w, scale) { const c = seqCache(m); seqForward(m, cnnPrep(w, scale), c); return { p: softmax(Array.from(c.out.subarray(0, m.K))), sev: Math.max(c.out[m.K], 0) * m.sevRef }; }

function dlModels(M) { const out = []; if (M.cnn) out.push({ key: "cnn", name: CNN_NAME, m: M.cnn, pred: w => cnnPredict(M.cnn, w, M.scale) }); for (const k of Object.keys(M.seq || {})) out.push({ key: k, name: SEQ_DEF[k].name, m: M.seq[k], pred: w => seqPredict(M.seq[k], w, M.scale) }); return out; }
const DL_DESC = { cnn: "2 conv + max-pool blocks → dense (reads the raw waveform)", lstm: "LSTM, 16 units, 32 time steps", bilstm: "bidirectional LSTM, 2 × 12 units", gru: "GRU, 16 units, 32 time steps", cnnlstm: "1 conv + max-pool block → LSTM, 16 units" };
const SEV_NAMES = ["Random forest", "Kernel ridge (SVR-style)", "KNN", "ELM"];
const MODEL_NAMES = { cnn: "1D-CNN (DL)", lstm: "LSTM (DL)", bilstm: "BiLSTM (DL)", gru: "GRU (DL)", cnnlstm: "CNN-LSTM (DL)", rf: "Random Forest", lssvm: "LS-SVM (RBF)", knn: "KNN", mlp: "BPNN (MLP)", elm: "ELM" };
function predictProba(m, X, d, i) { switch (m.type) { case "knn": return predKNN(m, X, d, i); case "elm": return predELM(m, X, d, i); case "lssvm": return predLSSVM(m, X, d, i); case "mlp": return predMLP(m, X, d, i); default: return predRF(m, X, d, i); } }

/* =====================================================================
   Training the twin
   ===================================================================== */
async function trainTwin(machine, topology, recs, opts, log, prog) {
  const t0 = performance.now(), train = recs.filter(r => r.split === "train"), test = recs.filter(r => r.split === "test");
  if (!train.length) throw new Error("No training files found. The folder needs a sub-folder called 'train'.");
  const classes = [...new Set(train.map(r => r.cls))].sort((a, b) => (a !== "healthy") - (b !== "healthy") || a.localeCompare(b)), K = classes.length;
  if (K < 2) throw new Error("Need at least two classes in the train folder (for example healthy + one fault).");
  const minLen = Math.min(...train.map(r => r.sig[0].length)), W = Math.min(pow2le(opts.W), pow2le(minLen)), fs = (train.find(r => r.fs) || {}).fs || null;
  const X = [], meta = [];
  for (const r of train) { const { X: xw } = makeWindows(r.sig, W, opts.step, opts.maxw); xw.forEach((w, k) => { X.push(w); meta.push({ file: r.file, y: classes.indexOf(r.cls), sev: r.sev, k }); }); }
  let sum = 0, sq = 0, cnt = 0; for (const w of X) for (const ch of w) for (let i = 0; i < ch.length; i += 4) { sum += ch[i]; sq += ch[i] * ch[i]; cnt++; }
  const scale = Math.sqrt(sq / cnt - (sum / cnt) ** 2) || 1, { F: Fraw, N, D: d } = featuresOf(X, scale);
  const mu = new Float64Array(d), sd = new Float64Array(d); for (let k = 0; k < d; k++) { let s = 0; for (let i = 0; i < N; i++) s += Fraw[i * d + k]; mu[k] = s / N; let v = 0; for (let i = 0; i < N; i++) v += (Fraw[i * d + k] - mu[k]) ** 2; sd[k] = Math.sqrt(v / N) || 1; }
  const F = new Float64Array(N * d); for (let i = 0; i < N; i++) for (let k = 0; k < d; k++) F[i * d + k] = (Fraw[i * d + k] - mu[k]) / sd[k];
  const y = meta.map(m => m.y), sev = meta.map(m => m.sev);
  log(`${N} training windows · ${d} features · classes: ${classes.map(pretty).join(", ")}`);
  const rng = mulberry32(42), models = {}, step = (p, label) => { prog(p); log(label); };
  step(0.06, "training KNN…"); await yieldUI(); models.knn = trainKNN(F, d, y, K);
  step(0.12, "training ELM…"); await yieldUI(); models.elm = trainELM(F, N, d, y, K);
  step(0.22, "training LS-SVM…"); await yieldUI(); models.lssvm = trainLSSVM(F, d, y, K, rng);
  step(0.30, "training BPNN…"); models.mlp = await trainMLP(F, N, d, y, K, rng, 48, 70, 2e-3, 32, p => prog(0.30 + 0.22 * p));
  step(0.55, "training Random Forest…"); models.rf = await trainForest(F, N, d, Int32Array.from(y), K, rng, 100, { maxDepth: 12, minLeaf: 2, mtry: Math.round(Math.sqrt(d)) }, p => prog(0.55 + 0.2 * p));
  const regs = {};
  for (let ci = 0; ci < K; ci++) {
    if (classes[ci] === "healthy") continue; step(0.78 + 0.1 * ci / K, `training severity models for ${pretty(classes[ci])}…`); await yieldUI();
    const hi = classes.indexOf("healthy"), sel = []; for (let i = 0; i < N; i++) if (y[i] === ci || y[i] === hi) sel.push(i);
    const Fs = new Float64Array(sel.length * d); sel.forEach((i, r) => Fs.set(F.subarray(i * d, i * d + d), r * d)); const tg = Float64Array.from(sel, i => sev[i]);
    regs[classes[ci]] = { rf: await trainForest(Fs, sel.length, d, tg, 0, rng, 60, { maxDepth: 10, minLeaf: 2, mtry: Math.round(d / 3) }), krr: trainKRR(Fs, d, tg, rng), knn: { F: Fs, tgt: tg, d }, elm: trainELMreg(Fs, sel.length, d, tg) };
  }
  step(0.84, "training the 1D-CNN (deep learning)…"); await yieldUI();
  const sevRefV = Math.max(1, ...train.map(r => r.sev)); let cnn = null;
  try { cnn = await trainCNN(X, y, sev, K, scale, sevRefV, rng, (p, ep, l, a) => { prog(0.84 + 0.06 * p); if (ep % 4 === 0) log(`CNN epoch ${ep}: loss ${l.toFixed(3)}, train acc ${(a * 100).toFixed(0)}%`); }); } catch (e) { log("1D-CNN skipped: " + e.message); }
  const seq = {};
  if (opts.rnn !== false) { const kinds = ["lstm", "bilstm", "gru", "cnnlstm"]; for (let qi = 0; qi < kinds.length; qi++) { const kd = kinds[qi]; step(0.88 + 0.022 * qi, `training ${SEQ_DEF[kd].name.replace(" (DL)", "")} (deep learning)…`); await yieldUI();
    try { seq[kd] = await trainSeq(kd, X, y, sev, K, scale, sevRefV, rng, (p, ep, l, a) => { prog(0.88 + 0.022 * (qi + p)); if (ep % 10 === 0) log(`${SEQ_DEF[kd].name.replace(" (DL)", "")} epoch ${ep}: train acc ${(a * 100).toFixed(0)}%`); }); log(`${SEQ_DEF[kd].name.replace(" (DL)", "")}: train acc ${(seq[kd].info.acc * 100).toFixed(0)}%${seq[kd].info.used ? "" : " (below 70%: shown but not used in the verdict)"}`); } catch (e) { log(`${kd} skipped: ${e.message}`); } } }
  step(0.97, "calibrating the data-familiarity check…");
  const files = meta.map(m => m.file), clsOfFile = {}; train.forEach(r => clsOfFile[r.file] = r.cls);
  const dists = [];
  for (const f of new Set(files)) {
    const mine = [], others = []; files.forEach((x, i) => { if (x === f) mine.push(i); else if (clsOfFile[x] === clsOfFile[f]) others.push(i); });
    let q = mine.filter((_, k) => k % Math.max(1, Math.floor(mine.length / 30)) === 0), ref = others;
    if (others.length < 5) { const h = Math.floor(mine.length / 2); ref = mine.slice(0, h); q = mine.slice(h).filter((_, k) => k % 2 === 0); }
    ref = ref.filter((_, k) => k % Math.max(1, Math.floor(ref.length / 400)) === 0);
    for (const a of q) { let b = Infinity; for (const r of ref) b = Math.min(b, sqDist(F, a, F, r, d)); dists.push(Math.sqrt(b)); }
  }
  const noveltyThr = pctile(dists, 95) * 1.5 + 1e-9, healthy = train.find(r => r.cls === "healthy");
  const M = { machine, topology, classes, models, regs, cnn, seq, scale, mu, sd, d, W, step: opts.step, maxw: opts.maxw, fs, sevRef: Math.max(1, ...train.map(r => r.sev)), noveltyThr,
    refSig: healthy ? healthy.sig.map(c => c.slice(0, 6000)) : null, ver: 4, trainedAt: new Date().toLocaleString(), nWindows: N,
    trainedOn: train.map(r => ({ file: r.file, cls: r.cls, sev: r.sev })), demo: !!opts.demo, holdout: [], seconds: 0 };
  step(0.98, "checking the hold-out test files…");
  const runHold = () => { M.holdout = []; for (const r of test) { try { const R = analyze(M, r); M.holdout.push({ file: r.file, truth: r.cls, trueSev: r.sev, pred: R.cls, predSev: R.severity, conf: R.confidence, ok: R.cls === r.cls, sm: R.sevModels }); } catch (e) { log(`hold-out ${r.file}: ${e.message}`); } } };
  runHold();
  const SK = [...SEV_NAMES, ...dlModels(M).filter(d => d.m.info.used !== false).map(d => d.name)], errs = {}; SK.forEach(k => errs[k] = []);
  for (const h of M.holdout) if (h.truth !== "healthy" && h.pred === h.truth && h.sm) SK.forEach(k => errs[k].push(Math.abs(h.sm[k] - h.trueSev)));
  if (SK.every(k => errs[k].length)) {
    M.sevErr = {}; SK.forEach(k => M.sevErr[k] = mean(errs[k]));
    const raw = SK.map(k => 1 / (M.sevErr[k] + 0.5) ** 2), tot = raw.reduce((a, b) => a + b, 0); M.sevW = {}; SK.forEach((k, i) => M.sevW[k] = 0.5 * raw[i] / tot + 0.5 / SK.length);
    log("severity weights from hold-out error: " + SK.map(k => `${k} ${(M.sevW[k] * 100).toFixed(0)}%`).join(", ")); runHold();
  } else log("no usable hold-out files for severity: models are averaged equally");
  M.seconds = +((performance.now() - t0) / 1000).toFixed(1); prog(1); log(`done in ${M.seconds} s`); return M;
}

/* =====================================================================
   Using the twin on a new record
   ===================================================================== */
function welch(x, fs, nper) {
  const win = hann(nper, false), hop = nper / 2; let wss = 0; for (const v of win) wss += v * v;
  const nf = nper / 2 + 1, psd = new Float64Array(nf); let cnt = 0;
  for (let s = 0; s + nper <= x.length; s += hop) {
    const seg = new Float64Array(nper); let m = 0; for (let i = 0; i < nper; i++) m += x[s + i]; m /= nper; for (let i = 0; i < nper; i++) seg[i] = (x[s + i] - m);
    const mag = rfftMag(seg, win); for (let k = 0; k < nf; k++) { let p = mag[k] * mag[k] / (fs * wss); if (k > 0 && k < nf - 1) p *= 2; psd[k] += p; } cnt++;
  }
  const f = new Float64Array(nf); for (let k = 0; k < nf; k++) f[k] = k * fs / nper; for (let k = 0; k < nf; k++) psd[k] /= Math.max(cnt, 1); return { f, psd };
}
function analyze(M, rec) {
  const K = M.classes.length, notes = []; let fs = rec.fs;
  if (fs && M.fs && Math.abs(fs - M.fs) / M.fs > 0.01) notes.push(`Sampling rate ${fs.toFixed(0)} Hz differs from the training data (${M.fs.toFixed(0)} Hz). Spectral features may not line up, so results are less reliable.`);
  if (!fs) { notes.push("No time column found; the training sampling rate is assumed."); fs = M.fs || 1; }
  const { X, starts } = makeWindows(rec.sig, M.W, M.step, M.maxw), { F: Fr, N, D: d } = featuresOf(X, M.scale), F = new Float64Array(N * d);
  for (let i = 0; i < N; i++) for (let k = 0; k < d; k++) F[i * d + k] = (Fr[i * d + k] - M.mu[k]) / M.sd[k];
  const per = {}, ens = Array.from({ length: N }, () => new Float64Array(K));
  const dlSev = {}, excluded = [];
  for (const [key, m] of Object.entries(M.models)) { per[key] = []; for (let i = 0; i < N; i++) per[key].push(predictProba(m, F, d, i)); }
  for (const dm of dlModels(M)) { per[dm.key] = []; dlSev[dm.key] = []; for (let i = 0; i < N; i++) { const o = dm.pred(X[i]); per[dm.key].push(o.p); dlSev[dm.key].push(o.sev); } if (dm.m.info && dm.m.info.used === false) excluded.push(dm.key); }
  const voters = Object.keys(per).filter(k => !excluded.includes(k)), nm = voters.length; for (const k of voters) for (let i = 0; i < N; i++) for (let c = 0; c < K; c++) ens[i][c] += per[k][i][c] / nm;
  const fileProb = new Float64Array(K); for (const p of ens) for (let c = 0; c < K; c++) fileProb[c] += p[c] / N;
  let k = 0; for (let c = 1; c < K; c++) if (fileProb[c] > fileProb[k]) k = c; const cls = M.classes[k];
  const winPred = ens.map(p => p.indexOf(Math.max(...p))), votes = {}, modelMean = {};
  for (const [key, arr] of Object.entries(per)) { const mm = new Float64Array(K); for (const p of arr) for (let c = 0; c < K; c++) mm[c] += p[c] / N; modelMean[key] = mm; let b = 0; for (let c = 1; c < K; c++) if (mm[c] > mm[b]) b = c; votes[key] = M.classes[b]; }
  let severity = 0, sevSd = 0, sevUsed = null; const sevModels = {};
  if (cls !== "healthy" && M.regs[cls]) {
    const r = M.regs[cls], R4 = { rf: [], krr: [], knn: [], elm: [] }; for (let i = 0; i < N; i++) { R4.rf.push(predRFreg(r.rf, F, d, i)); R4.krr.push(predKRR(r.krr, F, d, i)); R4.knn.push(predKNNreg(r.knn, F, d, i)); R4.elm.push(predELMreg(r.elm, F, d, i)); }
    const A = {}; ["rf", "krr", "knn", "elm"].forEach((k, q) => A[SEV_NAMES[q]] = R4[k]); for (const dm of dlModels(M)) if (!excluded.includes(dm.key)) A[dm.name] = dlSev[dm.key];
    const keys = Object.keys(A); keys.forEach(k => sevModels[k] = Math.max(median(A[k]), 0));
    const wv = keys.map(k => M.sevW && M.sevW[k] !== undefined ? M.sevW[k] : 0), wsum = wv.reduce((a, b) => a + b, 0), ww = wsum > 0.999 ? wv : keys.map(() => 1 / keys.length), mix = Array.from({ length: N }, (_, i) => keys.reduce((a, k, q) => a + ww[q] * A[k][i], 0));
    severity = Math.min(Math.max(median(mix), 0), M.sevRef * 1.3); sevSd = std(mix); sevUsed = Object.fromEntries(keys.map((k, q) => [k, ww[q]]));
  }
  const sevFrac = Math.min(severity / M.sevRef, 1), hi = M.classes.indexOf("healthy"), pH = hi >= 0 ? fileProb[hi] : 0, health = 100 * (pH + (1 - pH) * (1 - 0.9 * sevFrac));
  let status, level; if (cls === "healthy") [status, level] = ["NORMAL", "ok"]; else if (sevFrac < 0.34) [status, level] = ["INCIPIENT FAULT", "warn"]; else if (sevFrac < 0.67) [status, level] = ["MODERATE FAULT", "alert"]; else [status, level] = ["SEVERE FAULT", "crit"];
  const nn = []; for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 40))) { let b = Infinity; const kn = M.models.knn; for (let j = 0; j < kn.y.length; j++) b = Math.min(b, sqDist(F, i, kn.F, j, d)); nn.push(Math.sqrt(b)); }
  const novelty = median(nn) / M.noveltyThr;
  if (novelty > 1) notes.push("This record looks unlike the training data (different machine, speed, load or noise?). Treat the verdict with caution.");
  const sig = rec.sig, n = sig[0].length, rms = sig.map(c => Math.sqrt(c.reduce((s, v) => s + v * v, 0) / n)), imbalance = (Math.max(...rms) - Math.min(...rms)) / (mean(rms) + 1e-12) * 100;
  const nf = pow2le(Math.min(n, 16384)), a0 = sig[0].subarray(0, nf); let m0 = mean(a0); const mag = rfftMag(Float64Array.from(a0, v => v - m0), hann(nf, true)), fr = k2 => k2 * fs / nf;
  let kp = Math.max(1, Math.ceil(2 * nf / fs)); for (let q = kp; q < mag.length; q++) if (mag[q] > mag[kp]) kp = q; const f0 = fr(kp);
  const amp = fq => { const i = Math.round(fq * nf / fs); let b = 0; for (let q = Math.max(0, i - 2); q <= Math.min(mag.length - 1, i + 2); q++) b = Math.max(b, mag[q]); return b; };
  let hs = 0, nh = 0; for (let h = 2; h < 26 && h * f0 < fs / 2; h++) { hs += amp(h * f0) ** 2; nh++; } const thd = nh ? Math.sqrt(hs) / (amp(f0) + 1e-12) * 100 : 0;
  const ia = new Float64Array(n), ib = new Float64Array(n), rad = new Float64Array(n); for (let i = 0; i < n; i++) { ia[i] = (2 * sig[0][i] - sig[1][i] - sig[2][i]) / 3; ib[i] = (sig[1][i] - sig[2][i]) / Math.sqrt(3); rad[i] = Math.hypot(ia[i], ib[i]); }
  const parkRip = std(rad) / (mean(rad) + 1e-12) * 100, nper = pow2le(Math.min(4096, Math.max(256, Math.floor(n / 2))));
  const psd = welch(sig[0], fs, nper); let refPsd = null, refPark = null;
  if (M.refSig) { const rn = pow2le(Math.min(nper, Math.floor(M.refSig[0].length / 2))); refPsd = welch(M.refSig[0], M.fs || fs, rn); const rs = M.refSig, m = rs[0].length, ra = new Float64Array(m), rb = new Float64Array(m); for (let i = 0; i < m; i++) { ra[i] = (2 * rs[0][i] - rs[1][i] - rs[2][i]) / 3; rb[i] = (rs[1][i] - rs[2][i]) / Math.sqrt(3); } refPark = [ra, rb]; }
  const nwave = Math.min(n, Math.max(200, Math.floor(3 * fs / Math.max(f0, 1e-6))));
  return { name: rec.name || rec.file, cls, clsIdx: k, classes: M.classes, confidence: fileProb[k], fileProb, windowAgreement: winPred.filter(v => v === k).length / N,
    per, modelMean, votes, nAgree: voters.filter(k => votes[k] === cls).length, nModels: nm, excluded, ens, winT: starts.map(s => (s + M.W / 2) / fs),
    severity, sevSd, sevModels, sevW: sevUsed, sevFrac, health, status, level, novelty, notes, f0, rms, imbalance, thd, parkRip, ia, ib, refPark, psd, refPsd, fs, n, nWindows: N,
    waveT: Array.from({ length: nwave }, (_, i) => i / fs * 1e3), wave: sig.map(c => c.subarray(0, nwave)) };
}

/* =====================================================================
   Storage (IndexedDB keeps the trained twin in this browser)
   ===================================================================== */
const DB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("twin-electra", 1); r.onupgradeneeded = () => r.result.createObjectStore("models"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const q = db.transaction("models").objectStore("models").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return null; } },
  async put(k, v) { try { const db = await this.open(); return await new Promise((res, rej) => { const t = db.transaction("models", "readwrite"); t.objectStore("models").put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); } catch (e) { return false; } }
};

/* =====================================================================
   Digital-twin drawings
   ===================================================================== */
function svgAxial(kind, frac, color, label) {
  const theta = kind === "tilt" ? frac * 6 : 0, dx = kind === "disp" ? frac * 55 : kind === "orbit" ? frac * 30 : 0, cx = 300, cy = 192;
  const mags = Array.from({ length: 13 }, (_, i) => `<rect x="${40 + i * 44}" y="160" width="40" height="18" rx="3" fill="${i % 2 ? "#17c9a0" : "#2f7bff"}" opacity=".92"/>`).join("");
  const xs = [104, 140, 176, 212, 248, 330, 366, 402, 438, 474], coils = xs.map(x => `<rect x="${x}" y="206" width="30" height="26" rx="5" fill="url(#cu)"/>`).join("");
  const orbit = kind === "orbit" ? `<animateTransform attributeName="transform" type="translate" dur="2.4s" repeatCount="indefinite" values="${dx} 0;0 ${dx / 2};${-dx} 0;0 ${-dx / 2};${dx} 0"/>` : "";
  let gap = `<text x="518" y="196" fill="#7fe9c7" font-size="15" font-weight="700">L</text>`;
  if (kind === "tilt") gap = `<text x="62" y="196" fill="${color}" font-size="15" font-weight="700">L − x₁</text><text x="508" y="196" fill="${color}" font-size="15" font-weight="700">L + x₁</text>`;
  else if (kind === "disp" || kind === "orbit") gap = `<line x1="300" y1="288" x2="${300 + dx}" y2="288" stroke="${color}" stroke-width="3"/><text x="${300 + dx / 2 - 6}" y="308" fill="${color}" font-size="16" font-weight="700">ε</text>`;
  const tf = kind === "orbit" ? `rotate(${theta},${cx},${cy})` : `translate(${dx},0) rotate(${theta},${cx},${cy})`;
  return `<svg viewBox="0 0 600 340" width="100%" role="img" aria-label="Axial flux machine twin, ${esc(label)}" xmlns="http://www.w3.org/2000/svg" style="display:block">
<defs><linearGradient id="cu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0a35a"/><stop offset="1" stop-color="#b56a2a"/></linearGradient>
<linearGradient id="st" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d7490"/><stop offset="1" stop-color="#2b3a4f"/></linearGradient>
<linearGradient id="ro" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b78d6"/><stop offset="1" stop-color="#5a3fb3"/></linearGradient>
<clipPath id="rc"><rect x="100" y="160" width="400" height="18"/></clipPath>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#12263e" stroke-width="1"/></pattern></defs>
<rect width="600" height="340" fill="url(#grid)" opacity=".7"/>
<text x="16" y="26" fill="#8ea7c4" font-size="13" letter-spacing="2">DIGITAL TWIN · AXIAL FLUX PMSM · SIDE VIEW</text><text x="584" y="26" text-anchor="end" fill="${color}" font-size="14" font-weight="700">${esc(label)}</text>
<rect x="90" y="232" width="190" height="22" rx="3" fill="url(#st)"/><rect x="320" y="232" width="190" height="22" rx="3" fill="url(#st)"/>${coils}
<line x1="300" y1="60" x2="300" y2="300" stroke="#cfe3ff" stroke-opacity=".45" stroke-dasharray="6 5"/><text x="292" y="312" text-anchor="end" fill="#9db4cf" font-size="12">stator axis</text>
<g transform="${tf}"><g>${orbit}
<rect x="100" y="138" width="400" height="22" rx="3" fill="url(#ro)" stroke="${color}" stroke-width="2" filter="url(#glow)"/>
<g clip-path="url(#rc)"><g>${mags}<animateTransform attributeName="transform" type="translate" from="0 0" to="-88 0" dur="1.1s" repeatCount="indefinite"/></g></g>
<rect x="294" y="52" width="12" height="150" rx="3" fill="#b9c8dc"/><line x1="300" y1="40" x2="300" y2="300" stroke="${color}" stroke-opacity=".8" stroke-dasharray="3 5"/>
<ellipse cx="300" cy="64" rx="34" ry="9" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="10 8"><animate attributeName="stroke-dashoffset" from="0" to="-72" dur="1.1s" repeatCount="indefinite"/></ellipse>
<text x="312" y="48" fill="#9db4cf" font-size="12">rotor axis</text></g></g>${gap}
<text x="16" y="330" fill="#6f87a3" font-size="11">Tilt and offset are exaggerated for visibility. Size follows the estimated severity.</text></svg>`;
}
function svgRadial(kind, frac, color, label) {
  const dx = kind === "disp" || kind === "tilt" ? frac * 26 : 0, r = frac * 24;
  const orbit = kind === "orbit" ? `<animateTransform attributeName="transform" type="translate" dur="2.4s" repeatCount="indefinite" values="${r} 0;0 ${r};${-r} 0;0 ${-r};${r} 0"/>` : "";
  let slots = "", mg = ""; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; slots += `<line x1="${(180 + 120 * Math.cos(a)).toFixed(1)}" y1="${(180 + 120 * Math.sin(a)).toFixed(1)}" x2="${(180 + 142 * Math.cos(a)).toFixed(1)}" y2="${(180 + 142 * Math.sin(a)).toFixed(1)}" stroke="#5d7490" stroke-width="11" stroke-linecap="round"/><circle cx="${(180 + 134 * Math.cos(a + .26)).toFixed(1)}" cy="${(180 + 134 * Math.sin(a + .26)).toFixed(1)}" r="5" fill="#f0a35a"/>`; }
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; mg += `<path d="M ${(180 + 92 * Math.cos(a)).toFixed(1)} ${(180 + 92 * Math.sin(a)).toFixed(1)} A 92 92 0 0 1 ${(180 + 92 * Math.cos(a + .6)).toFixed(1)} ${(180 + 92 * Math.sin(a + .6)).toFixed(1)}" stroke="${i % 2 ? "#17c9a0" : "#2f7bff"}" stroke-width="14" fill="none" stroke-linecap="round"/>`; }
  return `<svg viewBox="0 0 360 385" width="100%" role="img" aria-label="Radial flux machine twin, ${esc(label)}" xmlns="http://www.w3.org/2000/svg" style="display:block;max-height:420px">
<defs><filter id="glow2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<text x="12" y="22" fill="#8ea7c4" font-size="12" letter-spacing="2">RADIAL FLUX PMSM TWIN</text><text x="348" y="22" text-anchor="end" fill="${color}" font-size="13" font-weight="700">${esc(label)}</text>
<g transform="translate(0,26)"><circle cx="180" cy="180" r="152" fill="none" stroke="#2b3a4f" stroke-width="34"/>${slots}
<g transform="translate(${dx},0)"><g>${orbit}<circle cx="180" cy="180" r="104" fill="#27364d" stroke="${color}" stroke-width="2.5" filter="url(#glow2)"/>
<g>${mg}<animateTransform attributeName="transform" type="rotate" from="0 180 180" to="360 180 180" dur="5s" repeatCount="indefinite"/></g>
<circle cx="180" cy="180" r="18" fill="#b9c8dc"/><circle cx="180" cy="180" r="5" fill="#0b1626"/></g></g>
<circle cx="180" cy="180" r="3" fill="#cfe3ff"/><text x="196" y="206" fill="#9db4cf" font-size="10">stator axis</text></g></svg>`;
}

/* =====================================================================
   Interface
   ===================================================================== */
const S = { machine: "Axial flux PMSM", twins: {}, results: {}, order: [], sel: null, tab: "twin", busy: false };
const topology = () => S.machine.startsWith("Radial") ? "radial" : "axial";
const twin = () => S.twins[S.machine] || null;
const drawTwin = (kind, frac, color, label) => (topology() === "radial" ? svgRadial : svgAxial)(kind, frac, color, label);
const PL = extra => Object.assign({ paper_bgcolor: "#0b1626", plot_bgcolor: "#0b1626", font: { family: "IBM Plex Sans, Segoe UI, sans-serif", size: 12, color: "#c8d8ec" }, margin: { l: 54, r: 20, t: 42, b: 44 }, legend: { x: 0.99, xanchor: "right", y: 0.98, yanchor: "top", bgcolor: "rgba(11,22,38,.7)" } }, extra);
const plot = (id, data, layout, h) => { const el = document.getElementById(id); if (el && !window.Plotly) { el.style.padding = "14px"; el.innerHTML = '<span class="small">Chart library failed to load.</span>'; return; } if (el && window.Plotly) Plotly.newPlot(el, data, PL(Object.assign({ height: h }, layout)), { displayModeBar: false, responsive: true }); };

function renderRail() {
  const T = twin(), card = $("#teachCard");
  $("#statusChip").className = "chip " + (T ? "on" : "off"); $("#statusChip").textContent = T ? `twin online · ${S.machine}` : "twin offline";
  const locked = !T || S.busy; $("#drop").classList.toggle("locked", locked);
  $("#feedMsg").textContent = T ? "The twin keeps running in this page. Each file is analysed in a second or two." : "Teach the twin first (step 1).";
  const folderBtn = `<label class="btn" for="trainZip">🗜 Upload train zip</label><input id="trainZip" type="file" accept=".zip,application/zip" hidden><div style="margin-top:8px"><label class="btn ghost" for="trainDir" style="min-height:36px;font-size:.85rem">or choose a folder instead</label><input id="trainDir" type="file" webkitdirectory directory multiple hidden></div>`;
  const demoBtn = `<button class="btn ghost" type="button" id="demoBtn" style="margin-top:8px">Try with synthetic demo signals</button>`;
  if (S.busy) return;
  if (!T) card.innerHTML = `<h3>1 · Teach the twin</h3><div class="small" style="margin-bottom:10px">${teachIntro()}</div>${S.stale ? '<div class="note" style="margin-bottom:10px">The twin saved in this browser came from an older version of this page. Please upload your train zip again to retrain it.</div>' : ""}${folderBtn}${topology()==="radial"?"":demoBtn}<div id="trainLog"></div>`;
  else if (T.kind === "radial") card.innerHTML = `<h3>1 · Twin status</h3><div class="kpi" style="color:var(--ok)">Online</div><div class="small">${esc(S.machine)} · trained ${esc(T.trainedAt)} in ${T.seconds} s<br>${esc(radStatusText(T))}</div><details style="margin-top:10px"><summary>Retrain with another folder</summary><div style="margin-top:8px">${folderBtn}</div></details><div id="trainLog"></div>`;
  else card.innerHTML = `<h3>1 · Twin status</h3><div class="kpi" style="color:var(--ok)">Online</div><div class="small">${esc(S.machine)} · trained ${esc(T.trainedAt)} in ${T.seconds} s<br>${T.nWindows} windows from ${T.trainedOn.length} files · ${T.classes.map(pretty).join(", ")}${T.demo ? '<br><b style="color:var(--warn)">DEMO twin: synthetic signals, not your machine</b>' : ""}</div>
    <details style="margin-top:10px"><summary>Retrain with another folder</summary><div style="margin-top:8px">${folderBtn}</div></details><div id="trainLog"></div>`;
  $("#trainDir") && ($("#trainDir").onchange = e => teach(e.target.files));
  $("#trainZip") && ($("#trainZip").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (f) teach(await unzip(f)); });
  $("#demoBtn") && ($("#demoBtn").onclick = () => teach(null, true));
}
function progressUI() { pmax = 0; $("#teachCard").innerHTML = `<h3>1 · Teaching the twin</h3><div class="small" id="pmsg">Reading files…</div><div class="prog"><i id="pbar"></i></div><div class="log" id="plog"></div>`; }
const logTo = m => { const l = $("#plog"); if (l) { l.textContent += m + "\n"; l.scrollTop = l.scrollHeight; } const p = $("#pmsg"); if (p) p.textContent = m; };
let pmax = 0; const progTo = p => { pmax = Math.max(pmax, p); const b = $("#pbar"); if (b) b.style.width = Math.round(pmax * 100) + "%"; };

function demoRecords() {
  const rng = mulberry32(11), mk = (kind, sev, n = 6000, dt = 0.05e-3, noise = 0.15, f = 100) => {
    const fr = f / 4, sig = [0, 1, 2].map(ph => { const a = new Float64Array(n); for (let i = 0; i < n; i++) { const t = i * dt, ang = 2 * Math.PI * f * t - ph * 2 * Math.PI / 3; let s = 10 * Math.sin(ang) + 0.4 * Math.sin(5 * ang) + 0.3 * Math.sin(7 * ang);
      if (kind === "tilt") s += sev * 0.05 * Math.sin(ang + 2 * Math.PI * fr * t * (1 + ph)) + sev * 0.03 * Math.sin(ang - 2 * Math.PI * fr * t); if (kind === "xdisp") s += sev * 0.04 * Math.sin(2 * ang) * (1 + 0.3 * ph) + sev * 0.02 * Math.sin(3 * ang + ph); a[i] = s + randn(rng) * noise; } return a; }); return { sig, fs: 1 / dt, n }; };
  const rows = [["Stator Currents-healthy", "train", "healthy", 0], ["Stator Currents-tilt10%", "train", "tilt", 10], ["Stator Currents-tilt-30%", "train", "tilt", 30], ["Stator Currents-x(disp)-4%", "train", "xdisp", 4], ["Stator Currents-x(disp)-20%", "train", "xdisp", 20], ["Stator Currents-tilt-20%", "test", "tilt", 20], ["Stator Currents-x(disp)-10%", "test", "xdisp", 10]];
  return { recs: rows.map(([file, split, cls, sev]) => ({ file, split, cls, sev, ...mk(cls, sev) })), mk };
}
let DEMO = null;
async function unzip(file) {
  if (!window.JSZip) { alert_("The zip reader did not load. Check your connection and reload."); return []; }
  const z = await JSZip.loadAsync(file), out = [];
  for (const [path, e] of Object.entries(z.files)) {
    if (e.dir || /(^|\/)(__MACOSX|\.)/.test(path) || !/\.(xls|xlsx|csv|txt)$/i.test(path)) continue;
    out.push({ name: path.split("/").pop(), webkitRelativePath: path, arrayBuffer: () => e.async("arraybuffer") });
  }
  return out;
}
const alert_ = m => { const l = $("#trainLog"); if (l) l.innerHTML = `<div class="note" style="border-color:var(--crit);background:#2a1014;color:#fca5a5">${esc(m)}</div>`; };
async function teach(fileList, demo = false) {
  if (topology() === "radial") return teachRadial(fileList);
  if (S.busy) return; S.busy = true; renderRail(); progressUI();
  try {
    const opts = { W: +$("#optW").value || 1024, step: +$("#optS").value || 128, maxw: 300, rnn: $("#optRnn").checked, demo, fs: +$("#optFs").value || null, channels: ($("#optCh").value || "").split(/[ ,;]+/).map(Number).filter(Boolean) };
    let recs;
    if (demo) { DEMO = demoRecords(); recs = DEMO.recs; logTo("generated synthetic demo signals (not real machine data)"); }
    else {
      const files = [...fileList].filter(f => /\.(xls|xlsx|csv|txt)$/i.test(f.name)); if (!files.length) throw new Error("No .xls / .xlsx / .csv files in that folder.");
      recs = []; let i = 0;
      for (const f of files) {
        const parts = (f.webkitRelativePath || f.name).split("/").slice(0, -1).map(s => s.toLowerCase()), split = parts.includes("test") ? "test" : "train";
        if (parts.includes("train") === false && parts.includes("test") === false && files.some(x => (x.webkitRelativePath || "").toLowerCase().split("/").some(p => p === "train" || p === "test"))) continue;
        const rec = loadSignal(await readRows(f), f.name, opts), [cls, sev] = parseLabel(f.name); recs.push({ file: f.name.replace(/\.[^.]+$/, ""), split, cls, sev, sig: rec.sig, fs: rec.fs, n: rec.n });
        logTo(`read ${split}/${f.name} → ${cls} ${sev}% · ${rec.n} samples${rec.fs ? " @ " + rec.fs.toFixed(0) + " Hz" : ""}`); progTo(0.05 * (++i / files.length)); await yieldUI();
      }
    }
    const M = await trainTwin(S.machine, topology(), recs, opts, logTo, progTo);
    S.twins[S.machine] = M; S.results = {}; S.order = []; S.sel = null; await DB.put(S.machine, M);
  } catch (e) { S.busy = false; renderRail(); $("#trainLog").innerHTML = `<div class="note" style="border-color:var(--crit);background:#2a1014;color:#fca5a5">${esc(e.message)}</div>`; renderMain(); return; }
  S.busy = false; renderRail(); renderMain();
}

async function feed(fileList) {
  const T = twin(); if (!T) return; const files = [...fileList]; if (!files.length) return; if (T.kind === "radial") return feedRadial(files);
  $("#feedMsg").textContent = `Analysing ${files.length} file(s)…`; await yieldUI(); const errs = [];
  for (const f of files) {
    try { const rec = loadSignal(await readRows(f), f.name, { fs: +$("#optFs").value || null }); S.results[f.name] = analyze(T, rec); if (!S.order.includes(f.name)) S.order.push(f.name); S.sel = f.name; }
    catch (e) { errs.push(`${f.name}: ${e.message}`); }
    await yieldUI();
  }
  S.tab = "twin"; renderMain(); $("#feedMsg").textContent = errs.length ? errs.join(" · ") : "Done. Drop another file any time.";
  if (errs.length) $("#feedMsg").style.color = "#fca5a5"; else $("#feedMsg").style.color = "";
}

const card = (t, big, sub, color) => `<div class="card"><h3>${t}</h3><div class="kpi" style="${color ? "color:" + color : ""}">${big}</div><div class="small">${sub}</div></div>`;
function renderMain() {
  if (topology() === "radial") return renderRadial();
  const m = $("#main"), T = twin();
  if (!T || !S.sel) {
    const msg = !T ? `<div class="card"><h3>${topology() === "radial" ? "In progress" : "Twin offline"}</h3><div class="kpi" style="color:var(--warn)">${topology() === "radial" ? "Radial models training" : "Not taught yet"}</div><div class="small" style="margin-top:8px;font-size:.95rem">${topology() === "radial" ? "The radial-flux slot is ready. When the radial data is available, upload its train zip in step 1 and this console will run it exactly like the axial machine." : "Upload your train zip in step 1. The page trains ten models (five ML + five deep learning: 1D-CNN, LSTM, BiLSTM, GRU, CNN-LSTM) in a minute or two and remembers them in this browser."}</div></div>`
      : `<div class="card"><h3>Awaiting data</h3><div class="kpi" style="color:var(--accent)">Twin ready</div><div class="small" style="margin-top:8px;font-size:.95rem">Drop a new stator-current file on the left. The twin classifies the eccentricity, estimates its severity and animates the machine.</div>${holdoutHTML(T)}</div>`;
    const demoRow = T && T.demo && DEMO ? `<div class="card demo"><h3>Demo files (synthetic)</h3><div class="small">Try the twin without a file:</div>${[["healthy", "healthy", 0], ["tilt 15 %", "tilt", 15], ["x-disp 25 %", "xdisp", 25], ["tilt 5 %", "tilt", 5]].map(([l, k, s]) => `<button class="btn ghost chip" type="button" data-demo="${k}|${s}">${l}</button>`).join("")}<button class="btn ghost chip" type="button" data-demo="unfamiliar|15">unfamiliar (other rate/noise)</button></div>` : "";
    m.innerHTML = `<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))"><div style="display:grid;gap:12px;align-content:start">${msg}${demoRow}</div><div class="plot" style="padding:6px">${drawTwin("none", 0, LEVEL[T ? "ok" : "idle"], T ? "NOMINAL" : "STANDBY")}</div></div>`;
    bindDemo(); return;
  }
  const R = S.results[S.sel], col = LEVEL[R.level], kind = faultKind(R.cls), sevTxt = R.cls === "healthy" ? "" : `≈ ${R.severity.toFixed(1)} %`, [tc, ts] = parseLabel(S.sel);
  const truth = T.classes.includes(tc) ? `<div class="small" style="margin-top:6px">File name says: <b>${pretty(tc)}${tc === "healthy" ? "" : " " + ts + " %"}</b> · ${tc === R.cls ? "✅ matches the twin" : "⚠️ differs from the twin"}</div>` : "";
  const sel = S.order.length > 1 ? `<label class="small" for="recSel">Record shown</label><select id="recSel" style="display:block;width:100%;margin:2px 0 10px;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px">${S.order.map(n => `<option ${n === S.sel ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : "";
  const fam = R.novelty <= .6 ? ["familiar data", LEVEL.ok] : R.novelty <= 1 ? ["somewhat new", LEVEL.warn] : ["unfamiliar data", LEVEL.crit];
  m.innerHTML = `${sel}${T.demo ? '<div class="note">DEMO twin: trained on synthetic signals. Teach it your own folder for real results.</div>' : ""}
  <div class="verdict" style="border-color:${rgba(col, .55)};background:linear-gradient(90deg,${rgba(col, .16)},rgba(11,22,38,.4))">
    <span class="pill" style="background:${col}">${R.status}</span>
    <div style="flex:1;min-width:220px"><div class="big" style="color:${col}">${esc(pretty(R.cls))}${sevTxt ? " · " + sevTxt : ""}</div>
      <div class="small" style="font-size:.95rem">${R.cls === "healthy" ? "No eccentricity signature found in the stator currents." : `${esc(pretty(R.cls))} detected, estimated severity <b>${R.severity.toFixed(1)} %</b> (± ${R.sevSd.toFixed(1)}).`}</div>${truth}</div>
    <div style="text-align:right"><div class="small">ensemble confidence</div><div class="kpi" style="color:${col};font-size:2.4rem">${(R.confidence * 100).toFixed(0)}%</div></div></div>
  ${R.notes.map(n => `<div class="note">⚠ ${esc(n)}</div>`).join("")}
  <div class="tabs" role="tablist">${[["twin", "◉ Live twin"], ["sig", "〜 Signals & spectrum"], ["model", "◈ Model room"], ["batch", "▤ Batch & report"]].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join("")}</div>
  <div class="pane" id="pane"></div>`;
  $("#recSel") && ($("#recSel").onchange = e => { S.sel = e.target.value; renderMain(); });
  m.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderMain(); });
  const pane = $("#pane");
  if (S.tab === "twin") {
    pane.innerHTML = `<div class="kpis">${card("Twin health index", `${R.health.toFixed(0)}<span class="small"> / 100</span>`, "100 = healthy twin", col)}${card("Estimated severity", R.cls === "healthy" ? "—" : R.severity.toFixed(1) + " %", `trained range up to ${T.sevRef} %`, col)}${card("Model agreement", `${R.nAgree}<span class="small"> / ${R.nModels} models</span>`, `${(R.windowAgreement * 100).toFixed(0)}% of ${R.nWindows} windows agree`)}${card("Data familiarity", fam[0], `distance ratio ${R.novelty.toFixed(2)} (above 1 = outside training)`, fam[1])}</div>
    <div class="two" style="margin-top:12px"><div class="plot" style="padding:6px">${drawTwin(kind, R.sevFrac, col, sevTxt || "NOMINAL")}</div>
    <div style="display:grid;gap:12px;min-width:0;align-content:start"><div class="plot" id="pGauge"></div><div class="plot" id="pProb"></div><div class="plot" id="pSev"></div><div class="small" id="sevNote" style="padding:0 4px"></div><div class="plot" id="pPark"></div></div></div>`;
    plot("pGauge", [{ type: "indicator", mode: "gauge+number", value: R.health, number: { font: { color: col, size: 40 } }, title: { text: "HEALTH INDEX", font: { size: 12, color: "#8ea7c4" } }, gauge: { axis: { range: [0, 100], tickvals: [0, 50, 100] }, bar: { color: col, thickness: .3 }, bgcolor: "#0e1d31", borderwidth: 0, steps: [{ range: [0, 40], color: "#3a1620" }, { range: [40, 70], color: "#3a2a14" }, { range: [70, 100], color: "#10342d" }] } }], { showlegend: false, margin: { l: 30, r: 30, t: 40, b: 10 } }, 190);
    plot("pProb", [{ type: "bar", orientation: "h", x: R.classes.map((c, i) => R.fileProb[i] * 100), y: R.classes.map(pretty), marker: { color: R.classes.map((c, i) => i === R.clsIdx ? col : "#2c4668") }, text: R.classes.map((c, i) => (R.fileProb[i] * 100).toFixed(0) + "%"), textposition: "outside", cliponaxis: false }], { showlegend: false, xaxis: { range: [0, 125], showgrid: false, ticksuffix: "%" }, yaxis: { automargin: true, autorange: "reversed" }, title: { text: "Class probability", font: { size: 13 } } }, 70 + 44 * R.classes.length);
    if (R.cls !== "healthy") { const keys = Object.keys(R.sevModels), names = keys.map(k => R.sevW ? `${k} · weight ${(R.sevW[k] * 100).toFixed(0)}%` : k), vals = keys.map(k => R.sevModels[k]), [tcl, tsv] = parseLabel(S.sel), shapes = [{ type: "line", x0: R.severity, x1: R.severity, y0: -.5, y1: names.length - .5, line: { color: "#e6eefb", dash: "dot", width: 2 } }]; if (tcl === R.cls) shapes.push({ type: "line", x0: tsv, x1: tsv, y0: -.5, y1: names.length - .5, line: { color: "#22d3a6", width: 2 } });
      plot("pSev", [{ type: "bar", orientation: "h", x: vals, y: names, marker: { color: col }, text: vals.map(v => v.toFixed(1) + " %"), textposition: "outside", cliponaxis: false }], { showlegend: false, shapes, xaxis: { range: [0, Math.max(T.sevRef * 1.3, ...vals) * 1.25], ticksuffix: " %", gridcolor: "#16283f" }, yaxis: { automargin: true, autorange: "reversed" }, title: { text: "Eccentricity severity predicted by each ML model" + (tcl === R.cls ? " (green line = file name, dotted = final)" : " (dotted = final)"), font: { size: 13 } } }, 70 + 44 * names.length); }
      $("#sevNote").textContent = R.cls === "healthy" ? "" : (R.sevW ? "Final severity = weighted combination of the four models in each window (weights from their error on your hold-out files), then the median over all windows." : "Final severity = equal average of the four models in each window, then the median over all windows. Add a test folder when teaching to weight models by accuracy.");
      if (R.cls === "healthy") plot("pSev", [], { title: { text: "Severity models are skipped for a healthy verdict", font: { size: 13 } }, xaxis: { visible: false }, yaxis: { visible: false } }, 80);
    const nPts = Math.min(R.ia.length, 4000), tr = [{ x: Array.from(R.ia.subarray(0, nPts)), y: Array.from(R.ib.subarray(0, nPts)), mode: "lines", line: { color: col, width: 2 }, name: "measured" }];
    if (R.refPark) tr.push({ x: Array.from(R.refPark[0].subarray(0, 4000)), y: Array.from(R.refPark[1].subarray(0, 4000)), mode: "lines", line: { color: "rgba(235,242,255,.9)", width: 1.4, dash: "dot" }, name: "healthy twin" });
    plot("pPark", tr, { title: { text: "Park-vector locus (αβ currents)", font: { size: 13 } }, xaxis: { title: "iα [A]", scaleanchor: "y", zeroline: false, gridcolor: "#16283f" }, yaxis: { title: "iβ [A]", zeroline: false, gridcolor: "#16283f" } }, 300);
  } else if (S.tab === "sig") {
    pane.innerHTML = `<div class="kpis">${card("Fundamental", R.f0.toFixed(1) + " Hz", `fs = ${R.fs.toFixed(0)} Hz · ${R.n} samples`)}${card("Phase imbalance", R.imbalance.toFixed(2) + " %", "RMS A/B/C " + R.rms.map(v => v.toFixed(2)).join(", "))}${card("THD (phase A)", R.thd.toFixed(1) + " %", "harmonics 2–25")}${card("Park-vector ripple", R.parkRip.toFixed(2) + " %", "radius spread of the αβ locus")}</div>
    <div class="plot" id="pWave" style="margin-top:12px"></div><div class="plot" id="pSpec" style="margin-top:12px"></div>`;
    plot("pWave", R.wave.map((w, i) => ({ x: R.waveT, y: Array.from(w), mode: "lines", name: "phase " + "ABC"[i], line: { color: PHASE[i], width: 2 } })), { title: { text: "Stator currents · first 3 electrical cycles", font: { size: 13 } }, xaxis: { title: "time [ms]", gridcolor: "#16283f" }, yaxis: { title: "current [A]", gridcolor: "#16283f" } }, 300);
    const fmax = Math.min(R.psd.f[R.psd.f.length - 1], Math.max(R.f0 * 25, 10)), idx = [...R.psd.f.keys()].filter(i => R.psd.f[i] <= fmax), db = v => 10 * Math.log10(v + 1e-18), tr2 = [{ x: idx.map(i => R.psd.f[i]), y: idx.map(i => db(R.psd.psd[i])), name: "measured", mode: "lines", line: { color: col, width: 2 }, xaxis: "x", yaxis: "y" }];
    if (R.refPsd) { const rf = R.refPsd.f, rp = R.refPsd.psd, interp = f => { let j = 0; while (j < rf.length - 2 && rf[j + 1] < f) j++; const t = (f - rf[j]) / ((rf[j + 1] - rf[j]) || 1); return db(rp[j] * (1 - t) + rp[j + 1] * t); }; const ri = [...rf.keys()].filter(i => rf[i] <= fmax);
      tr2.push({ x: ri.map(i => rf[i]), y: ri.map(i => db(rp[i])), name: "healthy twin", mode: "lines", line: { color: "rgba(150,170,200,.9)", width: 2, dash: "dot" }, xaxis: "x", yaxis: "y" });
      const dv = idx.map(i => db(R.psd.psd[i]) - interp(R.psd.f[i])); tr2.push({ type: "bar", x: idx.map(i => R.psd.f[i]), y: dv, marker: { color: dv.map(v => v > 0 ? "#fb923c" : "#38bdf8") }, showlegend: false, xaxis: "x", yaxis: "y2" }); }
    plot("pSpec", tr2, { title: { text: "Current spectrum vs healthy twin (phase A): eccentricity adds sidebands and harmonics", font: { size: 13 } }, xaxis: { title: "frequency [Hz]", gridcolor: "#16283f", anchor: "y2" }, yaxis: { domain: [.36, 1], title: "PSD [dB]", gridcolor: "#16283f" }, yaxis2: { domain: [0, .28], title: "Δ dB", gridcolor: "#16283f" } }, 480);
  } else if (S.tab === "model") {
    pane.innerHTML = `<div class="two"><div class="plot" id="pVotes"></div><div class="plot" id="pTime"></div></div>${Object.keys(R.sevModels).length ? `<p class="small" style="margin-top:10px">Severity predicted by each model (median over windows): ${Object.entries(R.sevModels).map(([k, v]) => `${k} <b>${v.toFixed(1)} %</b>`).join(" · ")} → ensemble <b>${R.severity.toFixed(1)} %</b></p>` : ""}
    ${dlModels(T).length ? `<div class="card scroll" style="margin-top:12px"><h3>Deep learning models</h3><table><thead><tr><th>Model</th><th>Architecture</th><th>Weights</th><th>Epochs</th><th>Train acc.</th><th>Status</th></tr></thead><tbody>${dlModels(T).map(d => `<tr><td>${esc(d.name)}</td><td>${esc(DL_DESC[d.key])}</td><td>${d.m.info.params.toLocaleString()}</td><td>${d.m.info.epochs}</td><td>${(d.m.info.acc * 100).toFixed(0)}%</td><td>${d.m.info.used === false ? "✕ not used (under 70%)" : "✓ votes"}</td></tr>`).join("")}</tbody></table><div class="small" style="margin-top:6px">They learn from the raw A/B/C current waveforms (no hand-made features) and output both the fault class and the severity. A deep model that does not learn (under 70% training accuracy) is shown but kept out of the verdict.</div></div>` : ""}<h3 style="margin:16px 0 6px">How far can you trust this twin?</h3>${holdoutHTML(T) || '<div class="small">No hold-out test folder was given when the twin was taught.</div>'}`;
    const keys = Object.keys(R.modelMean); plot("pVotes", [{ type: "heatmap", z: keys.map(k => Array.from(R.modelMean[k], v => v * 100)), x: R.classes.map(pretty), y: keys.map(k => MODEL_NAMES[k] + (R.excluded.includes(k) ? " ✕ not used" : "")), colorscale: [[0, "#0b1626"], [1, col]], zmin: 0, zmax: 100, showscale: false, text: keys.map(k => Array.from(R.modelMean[k], v => (v * 100).toFixed(0) + "%")), texttemplate: "%{text}" }], { title: { text: "Each model's vote (mean probability)", font: { size: 13 } }, yaxis: { autorange: "reversed" }, margin: { l: 175, r: 20, t: 42, b: 60 } }, 330 + 22 * Math.max(0, keys.length - 6));
    plot("pTime", R.classes.map((c, i) => ({ x: R.winT.map(t => t * 1e3), y: R.ens.map(p => p[i] * 100), stackgroup: "one", name: pretty(c), line: { width: .5, color: CLS_COL[i % 6] }, fillcolor: rgba(CLS_COL[i % 6], .65) })), { title: { text: "Class probability across the record", font: { size: 13 } }, xaxis: { title: "window centre [ms]", gridcolor: "#16283f" }, yaxis: { title: "%", range: [0, 100], gridcolor: "#16283f" } }, 330);
  } else {
    const rows = S.order.map(n => { const r = S.results[n], [c, s] = parseLabel(n), known = T.classes.includes(c); return `<tr><td>${esc(n)}</td><td>${esc(pretty(r.cls))}</td><td>${r.severity.toFixed(1)}</td><td>${(r.confidence * 100).toFixed(0)}</td><td>${r.status}</td><td>${r.health.toFixed(0)}</td><td>${r.nAgree}/${r.nModels}</td><td>${r.novelty.toFixed(2)}</td><td>${known ? esc(pretty(c)) + (c === "healthy" ? "" : " " + s + "%") : "—"}</td><td>${known ? (c === r.cls ? "✅" : "❌") : ""}</td></tr>`; }).join("");
    const adv = { ok: "Operate normally. Re-run the twin periodically to keep the trend.", warn: "Early sign of eccentricity. Schedule an inspection of bearings and mounting at the next maintenance window.", alert: "Clear eccentricity. Plan corrective action soon: check rotor alignment, shaft and bearing condition.", crit: "Severe eccentricity. Risk of rotor–stator contact: reduce load and inspect immediately." }[R.level];
    pane.innerHTML = `<div class="card scroll"><table><thead><tr><th>File</th><th>Twin verdict</th><th>Severity %</th><th>Confidence %</th><th>Status</th><th>Health</th><th>Models agree</th><th>Familiarity</th><th>File-name label</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="margin:12px 0;display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" id="copyCsv" type="button">Copy table (CSV)</button><button class="btn ghost" id="copyRep" type="button">Copy summary text</button><span class="small" id="copyMsg" style="align-self:center"></span></div>
    <div class="card"><h3>Plain-language summary</h3><div>${esc(S.sel)} → <b>${esc(pretty(R.cls))}</b>${R.cls === "healthy" ? "" : `, about ${R.severity.toFixed(1)} % severity`} (confidence ${(R.confidence * 100).toFixed(0)} %, ${R.nAgree} of ${R.nModels} models agree). ${adv}</div></div>`;
    const copy = (txt, b) => { const ok = () => $("#copyMsg").textContent = "Copied ✓", fail = () => { $("#copyMsg").textContent = "Your browser blocked copying. Select the table and copy it manually."; }; try { navigator.clipboard.writeText(txt).then(ok, fail); } catch (e) { fail(); } };
    $("#copyCsv").onclick = () => copy(["file,verdict,severity_pct,confidence_pct,status,health"].concat(S.order.map(n => { const r = S.results[n]; return `"${n}",${pretty(r.cls)},${r.severity.toFixed(1)},${(r.confidence * 100).toFixed(0)},${r.status},${r.health.toFixed(0)}`; })).join("\n"));
    $("#copyRep").onclick = () => copy(`${S.sel}: ${pretty(R.cls)}${R.cls === "healthy" ? "" : ", about " + R.severity.toFixed(1) + " % severity"} (confidence ${(R.confidence * 100).toFixed(0)} %, ${R.nAgree}/${R.nModels} models agree). ${adv}`);
  }
}
function holdoutHTML(T) {
  if (!T.holdout || !T.holdout.length) return "";
  return `<div class="card scroll" style="margin-top:10px"><h3>Hold-out test files (unseen during training)</h3><table><thead><tr><th>File</th><th>Truth</th><th>Twin</th><th>True %</th><th>Twin %</th><th>Conf.</th><th></th></tr></thead><tbody>${T.holdout.map(h => `<tr><td>${esc(h.file)}</td><td>${esc(pretty(h.truth))}</td><td>${esc(pretty(h.pred))}</td><td>${h.trueSev}</td><td>${h.predSev.toFixed(1)}</td><td>${(h.conf * 100).toFixed(0)}%</td><td>${h.ok ? "✅" : "❌"}</td></tr>`).join("")}</tbody></table>${T.sevErr ? `<div class="small" style="margin-top:8px">Severity error per model on these files (mean, % points) → weight: ${Object.keys(T.sevErr).map(k => `${k} <b>${T.sevErr[k].toFixed(1)}</b> → ${(T.sevW[k] * 100).toFixed(0)}%`).join(" · ")}</div>` : ""}<div class="small" style="margin-top:6px">${T.holdout.filter(h => h.ok).length} of ${T.holdout.length} correct. Few files means this is a spot check, not a guarantee.</div></div>`;
}
function bindDemo() {
  document.querySelectorAll("[data-demo]").forEach(b => b.onclick = async () => {
    const [k, s] = b.dataset.demo.split("|"), T = twin(); let rec;
    if (k === "unfamiliar") { const x = DEMO.mk("xdisp", +s, 6000, 0.02e-3, 1.2, 60); rec = { name: "demo_unfamiliar_x(disp)-15%", ...x }; }
    else { const x = DEMO.mk(k, +s); rec = { name: k === "healthy" ? "demo_healthy" : `demo_${k === "tilt" ? "tilt" : "x(disp)"}-${s}%`, ...x }; }
    S.results[rec.name] = analyze(T, rec); if (!S.order.includes(rec.name)) S.order.push(rec.name); S.sel = rec.name; S.tab = "twin"; renderMain();
  });
}

/* ======================================================================
   RADIAL-FLUX PMSM engine: JavaScript port of finalyearml_new.py
   one feature vector per recording (whole-cycle Fourier lines of the Park vector),
   Ridge + linear-SVR severity, Extra-Trees / SVM SE-vs-DE, leave-one-level-out validation
   ====================================================================== */
const RAD = { FS_OUT: 20000, FS_MID: 400000, TRANSIENT_S: 0.020, END_TRIM_S: 0.001, MAX_H: 25, HEALTHY_THR: 5.0, N_PERM_CLF: 100, N_PERM_SEV: 100, N_BOOT: 2000 };
const R_AMP = ["I1_A", "H5_pct", "H7_pct", "H11_pct", "H13_pct"], R_ASYM = ["AsymM1_log", "AsymP3_log", "AsymM3_log", "AsymP5_log", "AsymIndex_pct"];
const R_PHASE = [5, 7, 11, 13].flatMap(k => [`Ph${k}_cos`, `Ph${k}_sin`]);
const R_SEV = [...R_AMP, ...R_ASYM, "Batch"], R_CLF = [...R_AMP, ...R_ASYM, ...R_PHASE], R_CLASSES = ["SE", "DE"];
const R_ORDERS = Array.from({ length: 2 * RAD.MAX_H + 1 }, (_, i) => i - RAD.MAX_H);
const R_PRIMARY_SEV = "Ridge + linear-SVR average (primary)", R_PRIMARY_CLF = "Extra trees (primary)";

/* --- label from file name --- */
function radParseLabel(name) {
  let n = name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
  if (n.includes("mixed")) throw new Error("mixed eccentricity is not supported: " + name);
  if (n.includes("healthy")) return ["Healthy", 0];
  const isSE = /stat|(?<=\d)st(?![a-z])|(?<![a-z])st(?![a-z])/.test(n), isDE = /dyn|(?<=\d)dy(?![a-z])|(?<![a-z])dy(?![a-z])/.test(n);
  if (isSE === isDE) throw new Error("name must contain healthy, static or dynamic: " + name);
  const pct = [...n.matchAll(/(?<!\d)(\d+(?:\.\d+)?)\s*(?:%|pct)/g)].map(m => parseFloat(m[1])).filter(v => v >= 0 && v <= 100);
  const nums = pct.length ? pct : [...n.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  if (!nums.length) throw new Error("no eccentricity level in file name: " + name);
  return [isSE ? "SE" : "DE", nums[nums.length - 1]];
}
/* --- read an Ansys export (rows = array of arrays, first row = header) --- */
function radLoad(rows, name) {
  const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[ \-_]/g, "");
  const header = rows[0] || [], find = (...keys) => { for (let c = 0; c < header.length; c++) { const lc = norm(header[c]); if (keys.every(k => lc.includes(k))) return c; } return -1; };
  const isNum = v => v !== null && v !== undefined && v !== "" && isFinite(Number(v));
  let tc = find("time"), ph = [find("phasea") >= 0 ? find("phasea") : find("ia"), find("phaseb") >= 0 ? find("phaseb") : find("ib"), find("phasec") >= 0 ? find("phasec") : find("ic")], start = 1, hdr = String(header[tc] || "");
  if (tc < 0 || ph.some(c => c < 0)) { // fallback: first numeric row, columns time,A,B,C
    start = 0; while (start < rows.length && !(rows[start] || []).slice(0, 4).every(isNum)) start++; tc = 0; ph = [1, 2, 3]; hdr = start > 0 ? String(rows[start - 1][0] || "") : ""; if (start >= rows.length) throw new Error(`Time / Phase A,B,C columns not found in ${name}`);
  }
  const T = [], X = [[], [], []];
  for (let r = start; r < rows.length; r++) { const row = rows[r]; if (!row) continue; const t = Number(row[tc]); const a = ph.map(c => Number(row[c])); if (row[tc] === null || row[tc] === "" || !isFinite(t) || a.some((v, i) => row[ph[i]] === null || row[ph[i]] === "" || !isFinite(v))) continue; T.push(t); for (let k = 0; k < 3; k++) X[k].push(a[k]); }
  if (T.length < 100) throw new Error(`'${name}': too few valid rows (${T.length})`);
  const low = hdr.toLowerCase(); let tmax = -Infinity; for (const v of T) if (v > tmax) tmax = v;
  const scale = low.includes("ms") ? 1e-3 : (low.includes("us") || low.includes("µs")) ? 1e-6 : low.includes("[s]") ? 1 : (tmax > 5 ? 1e-3 : 1);
  const ord = Array.from({ length: T.length }, (_, i) => i).sort((a, b) => T[a] - T[b] || a - b), t = [], x = [[], [], []]; let last = NaN;
  for (const i of ord) { const v = T[i] * scale; if (v === last) continue; last = v; t.push(v); for (let k = 0; k < 3; k++) x[k].push(X[k][i]); }
  return { t: Float64Array.from(t), x: x.map(a => Float64Array.from(a)) };
}
/* --- irregular -> fine grid (linear) -> anti-aliased decimation --- */
function bessI0(x) { let s = 1, t = 1; for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-16 * s) break; } return s; }
let _firCache = null;
function radFir(q) {
  if (_firCache && _firCache.q === q) return _firCache.h; const half = 10 * q, n = 2 * half + 1, fc = 1 / q, h = new Float64Array(n), beta = 8, i0b = bessI0(beta); let sum = 0;
  for (let i = 0; i < n; i++) { const m = i - half, arg = Math.PI * fc * m, sinc = m === 0 ? 1 : Math.sin(arg) / arg, r = m / half, w = bessI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b; h[i] = fc * sinc * w; sum += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= sum; _firCache = { q, h }; return h;
}
function radToUniform(t, x) {
  const fsMid = RAD.FS_MID, fsOut = RAD.FS_OUT, q = Math.round(fsMid / fsOut), n = Math.ceil((t[t.length - 1] - t[0]) * fsMid - 1e-9), h = radFir(q), half = (h.length - 1) / 2, nOut = Math.ceil(n / q), out = [];
  for (const xi of x) {
    const mid = new Float64Array(n); let j = 0;
    for (let i = 0; i < n; i++) { const tm = t[0] + i / fsMid; while (j < t.length - 2 && t[j + 1] < tm) j++; const t0 = t[j], t1 = t[j + 1], f = t1 > t0 ? (tm - t0) / (t1 - t0) : 0; mid[i] = tm <= t[0] ? xi[0] : tm >= t[t.length - 1] ? xi[xi.length - 1] : xi[j] + (xi[j + 1] - xi[j]) * f; }
    const y = new Float64Array(nOut);
    for (let m = 0; m < nOut; m++) { let s = 0; const c = m * q; for (let k = -half; k <= half; k++) { let idx = c + k; idx = idx < 0 ? 0 : idx >= n ? n - 1 : idx; s += h[k + half] * mid[idx]; } y[m] = s; }
    out.push(y);
  }
  return out;
}
/* --- complex FFT (power of two) --- */
function cfft(re, im) {
  const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
function radPark(x) { const n = x[0].length, zr = new Float64Array(n), zi = new Float64Array(n), s3 = Math.sqrt(3); for (let i = 0; i < n; i++) { zr[i] = (2 * x[0][i] - x[1][i] - x[2][i]) / 3; zi[i] = (x[1][i] - x[2][i]) / s3; } return { zr, zi }; }
function radLockF0(zr, zi, fs) {
  const n = zr.length, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const nfft = 1 << 18, re = new Float64Array(nfft), im = new Float64Array(nfft); for (let i = 0; i < n; i++) { re[i] = zr[i] * w[i]; im[i] = zi[i] * w[i]; } cfft(re, im);
  let best = -1, bk = 0; for (let k = 0; k < nfft; k++) { const f = (k < nfft / 2 ? k : k - nfft) * fs / nfft, af = Math.abs(f); if (af >= 20 && af <= 1000) { const m = re[k] * re[k] + im[k] * im[k]; if (m > best) { best = m; bk = k; } } }
  const fk = (bk < nfft / 2 ? bk : bk - nfft) * fs / nfft, sign = fk > 0 ? 1 : -1, f0c = Math.abs(fk), step = fs / n, sr = zr, si = sign > 0 ? zi : zi.map(v => -v);
  const obj = ff => { let a = 0, b = 0; const wc = -2 * Math.PI * ff / fs; for (let i = 0; i < n; i++) { const c = Math.cos(wc * i), s = Math.sin(wc * i), pr = sr[i] * w[i], pi = si[i] * w[i]; a += pr * c - pi * s; b += pr * s + pi * c; } return -Math.hypot(a, b); };
  let lo = f0c - step, hi = f0c + step; const gr = (Math.sqrt(5) - 1) / 2; let c1 = hi - gr * (hi - lo), c2 = lo + gr * (hi - lo), f1 = obj(c1), f2 = obj(c2);
  while (hi - lo > 1e-7) { if (f1 < f2) { hi = c2; c2 = c1; f2 = f1; c1 = hi - gr * (hi - lo); f1 = obj(c1); } else { lo = c1; c1 = c2; f1 = f2; c2 = lo + gr * (hi - lo); f2 = obj(c2); } }
  return { f0: (lo + hi) / 2, sign };
}
/* --- Fourier coefficients over a whole number of cycles --- */
function radCoeffs(xu) {
  const fs = RAD.FS_OUT, i0 = Math.round(RAD.TRANSIENT_S * fs), i1 = xu[0].length - Math.round(RAD.END_TRIM_S * fs), seg = xu.map(a => a.subarray(i0, i1)), { zr, zi } = radPark(seg), { f0, sign } = radLockF0(zr, zi, fs);
  const zim = sign < 0 ? zi.map(v => -v) : zi, per = fs / f0, cycles = Math.floor(zr.length / per); if (cycles < 5) throw new Error("record too short: need at least 5 steady-state cycles");
  const L = Math.round(cycles * per), kmax = Math.min(RAD.MAX_H, Math.floor(0.4 * fs / f0)), C = {};
  for (let k = -kmax; k <= kmax; k++) { let a = 0, b = 0; const w = -2 * Math.PI * k * f0 / fs; for (let n = 0; n < L; n++) { const c = Math.cos(w * n), s = Math.sin(w * n); a += zr[n] * c - zim[n] * s; b += zr[n] * s + zim[n] * c; } C[k] = [a / L, b / L]; }
  return { C, f0, cycles, per, i0, L, zr: zr.subarray(0, L), zi: zim.subarray(0, L), kmax };
}
const cabs = c => Math.hypot(c[0], c[1]), carg = c => Math.atan2(c[1], c[0]);
function radFeatures(co, xu) {
  const { C, f0, cycles, per, i0, L, zr, zi } = co, fs = RAD.FS_OUT, c1 = C[1], a1 = cabs(c1), f = { I1_A: a1 }, get = k => C[k] || [0, 0];
  for (const k of [-5, 7, -11, 13]) f[`H${Math.abs(k)}_pct`] = 100 * cabs(get(k)) / a1;
  const allowed = new Set([1]); for (let m = 1; m <= 5; m++) allowed.add(6 * m + 1); for (let m = 0; m <= 5; m++) allowed.add(-(6 * m + 5));
  f.AsymM1_log = Math.log10(100 * cabs(get(-1)) / a1 + 1e-6); f.AsymP3_log = Math.log10(100 * cabs(get(3)) / a1 + 1e-6); f.AsymM3_log = Math.log10(100 * cabs(get(-3)) / a1 + 1e-6); f.AsymP5_log = Math.log10(100 * cabs(get(5)) / a1 + 1e-6);
  let sq = 0; for (const ks of Object.keys(C)) { const k = +ks; if (k !== 0 && !allowed.has(k)) sq += cabs(C[k]) ** 2; } f.AsymIndex_pct = 100 * Math.sqrt(sq) / a1;
  for (const k of [-5, 7, -11, 13]) { const ph = carg(get(k)) - k * carg(c1); f[`Ph${Math.abs(k)}_cos`] = Math.cos(ph); f[`Ph${Math.abs(k)}_sin`] = Math.sin(ph); }
  for (const k of R_ORDERS) f[`L${k >= 0 ? "+" : "-"}${Math.abs(k)}`] = 100 * cabs(get(k)) / a1;
  const xs = xu.map(a => a.subarray(i0, i0 + L)); let ss = 0; for (let c = 0; c < 3; c++) { let s = 0; for (let i = 0; i < L; i++) s += xs[c][i] * xs[c][i]; ss += Math.sqrt(s / L); } f.RMS_A = ss / 3;
  const spc = Math.round(per);
  if (Math.abs(per - spc) < 0.01) { let mx = 0, mxa = 0; const mean = new Float64Array(spc); for (let c = 0; c < cycles; c++) for (let i = 0; i < spc; i++) mean[i] += xs[0][c * spc + i] / cycles; for (let c = 0; c < cycles; c++) for (let i = 0; i < spc; i++) mx = Math.max(mx, Math.abs(xs[0][c * spc + i] - mean[i])); for (let i = 0; i < L; i++) mxa = Math.max(mxa, Math.abs(xs[0][i])); f.cycle_dev_pct = 100 * mx / mxa; } else f.cycle_dev_pct = NaN;
  // energy NOT on the harmonic grid
  const M = Math.floor(3000 * L / fs); let offMax = 0; const cs = new Float64Array(L), sn = new Float64Array(L); for (let q = 0; q < L; q++) { cs[q] = Math.cos(2 * Math.PI * q / L); sn[q] = -Math.sin(2 * Math.PI * q / L); }
  const bins = []; for (let m = 0; m <= M; m++) bins.push(m); for (let m = L - M; m < L; m++) if (m > M) bins.push(m);
  for (const m of bins) { if (m % cycles === 0) continue; let a = 0, b = 0; for (let n = 0; n < L; n++) { const idx = (m * n) % L, c = cs[idx], s = sn[idx]; a += zr[n] * c - zi[n] * s; b += zr[n] * s + zi[n] * c; } const mag = Math.hypot(a, b) / L; if (mag > offMax) offMax = mag; }
  f.offgrid_max_pct = 100 * offMax / a1; f.f0_Hz = f0; f.cycles = cycles; return f;
}
function radProcess(rows, name, role, md5, needLabel = true) {
  let fault = "?", level = NaN; if (needLabel) [fault, level] = radParseLabel(name); else { try { [fault, level] = radParseLabel(name); } catch (e) { /* unlabeled new file */ } }
  const { t, x } = radLoad(rows, name), xu = radToUniform(t, x), co = radCoeffs(xu), feats = radFeatures(co, xu);
  const per = co.per, one = Math.round(per) * 3, row = Object.assign({ file: name.replace(/^.*[\\/]/, ""), role, fault, level, md5: md5 || "" }, feats);
  row._wave = xu.map(a => Array.from(a.subarray(co.i0, co.i0 + one))); row._z = [Array.from(co.zr.subarray(0, Math.min(co.zr.length, Math.round(per) * 3))), Array.from(co.zi.subarray(0, Math.min(co.zi.length, Math.round(per) * 3)))]; row._fs = RAD.FS_OUT; return row;
}

/* ======================= radial ML (port of the scikit-learn parts) ======================= */
function radRng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rmean = a => { let s = 0; for (const v of a) s += v; return s / a.length; };
const rmedian = a => { const s = Array.from(a).sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const rquant = (a, q) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * (s.length - 1) - 1e-12))]; };   // method="higher"
function radSolve(A, n, b) { // Cholesky solve of A x = b (A symmetric positive definite, flat n*n)
  A = Float64Array.from(A); for (let j = 0; j < n; j++) { let s = A[j * n + j]; for (let k = 0; k < j; k++) s -= A[j * n + k] ** 2; const d = Math.sqrt(Math.max(s, 1e-14)); A[j * n + j] = d; for (let i = j + 1; i < n; i++) { let t = A[i * n + j]; for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k]; A[i * n + j] = t / d; } }
  const x = Float64Array.from(b); for (let i = 0; i < n; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= A[i * n + k] * x[k]; x[i] = s / A[i * n + i]; } for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k]; x[i] = s / A[i * n + i]; } return x;
}
function scalerFit(X) { const n = X.length, d = X[0].length, mu = new Float64Array(d), sd = new Float64Array(d); for (const r of X) for (let k = 0; k < d; k++) mu[k] += r[k] / n; for (const r of X) for (let k = 0; k < d; k++) sd[k] += (r[k] - mu[k]) ** 2 / n; for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k]) || 1; return { mu, sd }; }
const scalerApply = (S, X) => X.map(r => Float64Array.from(r, (v, k) => (v - S.mu[k]) / S.sd[k]));
/* libsvm-style SMO: min 1/2 a'Qa + p'a  s.t. y'a = 0, 0 <= a <= C */
function smoSolve(Q, n, p, y, C, eps = 1e-3) {
  const alpha = new Float64Array(n), G = Float64Array.from(p); let it = 0;
  while (it++ < 200000) {
    let gmax = -Infinity, gmin = Infinity, i = -1, j = -1;
    for (let t = 0; t < n; t++) { const v = -y[t] * G[t]; if ((y[t] === 1 && alpha[t] < C) || (y[t] === -1 && alpha[t] > 0)) { if (v > gmax) { gmax = v; i = t; } } if ((y[t] === 1 && alpha[t] > 0) || (y[t] === -1 && alpha[t] < C)) { if (v < gmin) { gmin = v; j = t; } } }
    if (i < 0 || j < 0 || gmax - gmin < eps) break;
    const oi = alpha[i], oj = alpha[j], Qii = Q[i * n + i], Qjj = Q[j * n + j], Qij = Q[i * n + j];
    if (y[i] !== y[j]) { let quad = Qii + Qjj + 2 * Qij; if (quad <= 0) quad = 1e-12; const delta = (-G[i] - G[j]) / quad, diff = alpha[i] - alpha[j]; alpha[i] += delta; alpha[j] += delta;
      if (diff > 0) { if (alpha[j] < 0) { alpha[j] = 0; alpha[i] = diff; } } else { if (alpha[i] < 0) { alpha[i] = 0; alpha[j] = -diff; } }
      if (diff > 0) { if (alpha[i] > C) { alpha[i] = C; alpha[j] = C - diff; } } else { if (alpha[j] > C) { alpha[j] = C; alpha[i] = C + diff; } } }
    else { let quad = Qii + Qjj - 2 * Qij; if (quad <= 0) quad = 1e-12; const delta = (G[i] - G[j]) / quad, sum = alpha[i] + alpha[j]; alpha[i] -= delta; alpha[j] += delta;
      if (sum > C) { if (alpha[i] > C) { alpha[i] = C; alpha[j] = sum - C; } } else { if (alpha[j] < 0) { alpha[j] = 0; alpha[i] = sum; } }
      if (sum > C) { if (alpha[j] > C) { alpha[j] = C; alpha[i] = sum - C; } } else { if (alpha[i] < 0) { alpha[i] = 0; alpha[j] = sum; } } }
    const di = alpha[i] - oi, dj = alpha[j] - oj; for (let k = 0; k < n; k++) G[k] += Q[k * n + i] * di + Q[k * n + j] * dj;
  }
  let ub = Infinity, lb = -Infinity, nf = 0, sf = 0;
  for (let i = 0; i < n; i++) { const yG = y[i] * G[i]; if (alpha[i] >= C) { if (y[i] === -1) ub = Math.min(ub, yG); else lb = Math.max(lb, yG); } else if (alpha[i] <= 0) { if (y[i] === 1) ub = Math.min(ub, yG); else lb = Math.max(lb, yG); } else { nf++; sf += yG; } }
  return { alpha, rho: nf > 0 ? sf / nf : (ub + lb) / 2 };
}
/* --- regression models: each fit(X, y) returns an object with predict(X) --- */
function fitRidge(X, y, alpha) { const S = scalerFit(X), Z = scalerApply(S, X), n = Z.length, d = Z[0].length, ym = rmean(y), A = new Float64Array(d * d), b = new Float64Array(d); for (let i = 0; i < n; i++) for (let a = 0; a < d; a++) { b[a] += Z[i][a] * (y[i] - ym); for (let c = 0; c <= a; c++) A[a * d + c] += Z[i][a] * Z[i][c]; } for (let a = 0; a < d; a++) { for (let c = a + 1; c < d; c++) A[a * d + c] = A[c * d + a]; A[a * d + a] += alpha; } return { type: "ridge", S, w: radSolve(A, d, b), b: ym }; }
function fitSVRlin(X, y, C, epsilon = 1.0) {
  const S = scalerFit(X), Z = scalerApply(S, X), l = Z.length, d = Z[0].length, n = 2 * l, Q = new Float64Array(n * n), sg = i => (i < l ? 1 : -1), K = new Float64Array(l * l);
  for (let i = 0; i < l; i++) for (let j = i; j < l; j++) { let s = 0; for (let k = 0; k < d; k++) s += Z[i][k] * Z[j][k]; K[i * l + j] = K[j * l + i] = s; }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Q[i * n + j] = sg(i) * sg(j) * K[(i % l) * l + (j % l)];
  const p = new Float64Array(n), ys = new Float64Array(n); for (let i = 0; i < l; i++) { p[i] = epsilon - y[i]; p[i + l] = epsilon + y[i]; ys[i] = 1; ys[i + l] = -1; }
  const { alpha, rho } = smoSolve(Q, n, p, ys, C), w = new Float64Array(d); for (let i = 0; i < l; i++) { const c = alpha[i] - alpha[i + l]; for (let k = 0; k < d; k++) w[k] += c * Z[i][k]; }
  return { type: "svr", S, w, b: -rho };
}
function predLin(m, X) { return scalerApply(m.S, X).map(z => { let s = m.b; for (let k = 0; k < z.length; k++) s += m.w[k] * z[k]; return s; }); }
const clip100 = v => Math.min(100, Math.max(0, v));
function fitLevelCV(kind, grid, X, y) {
  const mk = (a, Xt, yt) => kind === "ridge" ? fitRidge(Xt, yt, a) : fitSVRlin(Xt, yt, a); let best = [Infinity, grid[grid.length >> 1]]; const levels = [...new Set(y.filter(v => v > 0))].sort((a, b) => a - b);
  if (levels.length >= 3) for (const a of grid) { const err = []; for (const L of levels) { const tr = [], te = []; y.forEach((v, i) => (v === L ? te : tr).push(i)); const m = mk(a, tr.map(i => X[i]), tr.map(i => y[i])), p = predLin(m, te.map(i => X[i])); p.forEach((v, q) => err.push(Math.abs(clip100(v) - y[te[q]]))); } const e = rmean(err); if (e < best[0]) best = [e, a]; }
  const m = mk(best[1], X, y); m.param = best[1]; return m;
}
const RIDGE_GRID = [1e-3, 1e-2, 1e-1, 1, 10], SVR_GRID = [10, 100, 1000];
function fitAvgLinear(X, y) { return { type: "avg", a: fitLevelCV("ridge", RIDGE_GRID, X, y), b: fitLevelCV("svr", SVR_GRID, X, y) }; }
function predAvg(m, X) { const a = predLin(m.a, X), b = predLin(m.b, X); return a.map((v, i) => clip100(0.5 * (clip100(v) + clip100(b[i])))); }
const fitMean = (X, y) => ({ type: "mean", m: rmean(y) });
const SEV_FACTORIES = { "Mean-predictor baseline": fitMean, [R_PRIMARY_SEV]: fitAvgLinear, "Ridge, alpha by inner LOLO": (X, y) => fitLevelCV("ridge", RIDGE_GRID, X, y), "Linear SVR, C by inner LOLO": (X, y) => fitLevelCV("svr", SVR_GRID, X, y) };
function predSev(m, X) { if (m.type === "mean") return X.map(() => m.m); if (m.type === "avg") return predAvg(m, X); return predLin(m, X).map(clip100); }
/* --- classifiers --- */
function etBuild(X, y, idx, mtry, rng, nodes) {
  const id = nodes.length; nodes.push(null); let c0 = 0; for (const i of idx) if (y[i] === 0) c0++; const n = idx.length, c1 = n - c0;
  const leaf = () => { nodes[id] = { v: [c0 / n, c1 / n] }; return id; };
  if (c0 === 0 || c1 === 0 || n < 2) return leaf();
  const d = X[0].length, feats = Array.from({ length: d }, (_, i) => i); let best = null, found = 0;
  for (let q = 0; q < d && found < mtry; q++) { const j = q + Math.floor(rng() * (d - q)); [feats[q], feats[j]] = [feats[j], feats[q]]; const f = feats[q]; let mn = Infinity, mx = -Infinity; for (const i of idx) { const v = X[i][f]; if (v < mn) mn = v; if (v > mx) mx = v; } if (mx - mn <= 1e-12) continue; found++;
    let t = mn + rng() * (mx - mn); if (t >= mx) t = mn; let l0 = 0, l1 = 0, r0 = 0, r1 = 0; for (const i of idx) { if (X[i][f] <= t) { y[i] === 0 ? l0++ : l1++; } else { y[i] === 0 ? r0++ : r1++; } } const nl = l0 + l1, nr = r0 + r1; if (!nl || !nr) continue;
    const g = (nl * (1 - (l0 / nl) ** 2 - (l1 / nl) ** 2) + nr * (1 - (r0 / nr) ** 2 - (r1 / nr) ** 2)) / n; if (!best || g < best.g) best = { g, f, t }; }
  if (!best) return leaf(); const L = [], R = []; for (const i of idx) (X[i][best.f] <= best.t ? L : R).push(i);
  const li = etBuild(X, y, L, mtry, rng, nodes), ri = etBuild(X, y, R, mtry, rng, nodes); nodes[id] = { f: best.f, t: best.t, l: li, r: ri }; return id;
}
const CLS = ["DE", "SE"]; // sorted class order (as scikit-learn); index 0 = DE, 1 = SE
function fitET(X, labels, nTrees = 100, seed = 42) { const y = labels.map(l => (l === "DE" ? 0 : 1)), rng = radRng(seed), mtry = Math.max(1, Math.floor(Math.sqrt(X[0].length))), trees = []; for (let t = 0; t < nTrees; t++) { const nodes = []; etBuild(X, y, Array.from({ length: X.length }, (_, i) => i), mtry, rng, nodes); trees.push(nodes); } return { type: "et", trees }; }
function pDE_ET(m, X) { return X.map(x => { let s = 0; for (const t of m.trees) { let n = t[0]; while (n.f !== undefined) n = t[x[n.f] <= n.t ? n.l : n.r]; s += n.v[0]; } return s / m.trees.length; }); }
function fitSVC(X, labels, C = 10) {
  const S = scalerFit(X), Z = scalerApply(S, X), n = Z.length, d = Z[0].length; let sm = 0, sq = 0; for (const r of Z) for (const v of r) { sm += v; sq += v * v; } const cnt = n * d, variance = sq / cnt - (sm / cnt) ** 2, gamma = 1 / (d * (variance || 1)), y = labels.map(l => (l === "SE" ? 1 : -1)), Q = new Float64Array(n * n);
  const K = (a, b) => { let s = 0; for (let k = 0; k < d; k++) s += (a[k] - b[k]) ** 2; return Math.exp(-gamma * s); };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Q[i * n + j] = y[i] * y[j] * K(Z[i], Z[j]);
  const { alpha, rho } = smoSolve(Q, n, new Float64Array(n).fill(-1), Float64Array.from(y), C); return { type: "svc", S, Z, y, alpha, rho, gamma };
}
function pDE_SVC(m, X) { return scalerApply(m.S, X).map(z => { let s = -m.rho; for (let i = 0; i < m.Z.length; i++) { if (!m.alpha[i]) continue; let q = 0; for (let k = 0; k < z.length; k++) q += (z[k] - m.Z[i][k]) ** 2; s += m.alpha[i] * m.y[i] * Math.exp(-m.gamma * q); } return 1 / (1 + Math.exp(s)); }); }  // s>0 => SE
const fitMajority = (X, labels) => { const c = { DE: 0, SE: 0 }; labels.forEach(l => c[l]++); return { type: "maj", maj: c.DE >= c.SE ? "DE" : "SE", pDE: c.DE / labels.length }; };
const CLF_FACTORIES = { "Majority-class baseline": fitMajority, [R_PRIMARY_CLF]: (X, l) => fitET(X, l), "SVM (RBF)": (X, l) => fitSVC(X, l) };
function pDEof(m, X) { if (m.type === "maj") return X.map(() => m.pDE); if (m.type === "et") return pDE_ET(m, X); return pDE_SVC(m, X); }
const predCls = (m, X) => (m.type === "maj" ? X.map(() => m.maj) : pDEof(m, X).map(p => (p >= 0.5 ? "DE" : "SE")));
/* --- k-means (2 clusters) batch indicator --- */
function radBatch(rows, centres) {
  const X = rows.map(r => [r.I1_A, r.H5_pct]); let c = centres;
  if (!c) { const n = X.length, mu = [0, 1].map(k => rmean(X.map(r => r[k]))), sd = [0, 1].map(k => Math.sqrt(rmean(X.map(r => (r[k] - mu[k]) ** 2))) + 1e-12), Z = X.map(r => [(r[0] - mu[0]) / sd[0], (r[1] - mu[1]) / sd[1]]), rng = radRng(42); let bestIn = Infinity, bc = null;
    if (n >= 2) for (let init = 0; init < 20; init++) { let a = Math.floor(rng() * n), b = Math.floor(rng() * n); if (a === b) b = (b + 1) % n; let cs = [Z[a].slice(), Z[b].slice()], asg = new Array(n).fill(-1);
      for (let iter = 0; iter < 100; iter++) { let ch = false; Z.forEach((z, i) => { const d0 = (z[0] - cs[0][0]) ** 2 + (z[1] - cs[0][1]) ** 2, d1 = (z[0] - cs[1][0]) ** 2 + (z[1] - cs[1][1]) ** 2, k = d1 < d0 ? 1 : 0; if (asg[i] !== k) { asg[i] = k; ch = true; } }); for (let k = 0; k < 2; k++) { const m = Z.filter((_, i) => asg[i] === k); if (m.length) cs[k] = [rmean(m.map(z => z[0])), rmean(m.map(z => z[1]))]; } if (!ch) break; }
      const inertia = Z.reduce((s, z, i) => s + (z[0] - cs[asg[i]][0]) ** 2 + (z[1] - cs[asg[i]][1]) ** 2, 0); if (inertia < bestIn - 1e-12) { bestIn = inertia; bc = cs; } }
    if (!bc) bc = [[0, 0], [0, 0]]; if (bc[0][0] > bc[1][0]) bc = [bc[1], bc[0]]; c = { mu, sd, c: bc }; }
  const out = rows.map(r => { const z = [(r.I1_A - c.mu[0]) / c.sd[0], (r.H5_pct - c.mu[1]) / c.sd[1]], d0 = (z[0] - c.c[0][0]) ** 2 + (z[1] - c.c[0][1]) ** 2, d1 = (z[0] - c.c[1][0]) ** 2 + (z[1] - c.c[1][1]) ** 2; return d1 < d0 ? 1 : 0; });
  rows.forEach((r, i) => r.Batch = out[i]); return c;
}
/* --- validation: leave-one-severity-level-out at FILE level --- */
const featMat = (rows, feats) => rows.map(r => Float64Array.from(feats, f => r[f]));
function loloSeverity(rows, feats, factories) {
  const X = featMat(rows, feats), y = rows.map(r => r.level), out = {}; for (const k in factories) out[k] = new Float64Array(rows.length).fill(NaN);
  for (const L of [...new Set(y.filter(v => v > 0))].sort((a, b) => a - b)) { const tr = [], te = []; y.forEach((v, i) => (v === L ? te : tr).push(i)); for (const [name, fit] of Object.entries(factories)) { const m = fit(tr.map(i => X[i]), tr.map(i => y[i])), p = predSev(m, te.map(i => X[i])); te.forEach((i, q) => out[name][i] = clip100(p[q])); } }
  return out;
}
function loloClassify(rows, feats, factories) {
  const d = rows.filter(r => R_CLASSES.includes(r.fault)), X = featMat(d, feats), y = d.map(r => r.fault), lv = d.map(r => r.level), pred = {}, score = {}; for (const k in factories) { pred[k] = new Array(d.length); score[k] = new Float64Array(d.length).fill(NaN); }
  for (const L of [...new Set(lv)].sort((a, b) => a - b)) { const tr = [], te = []; lv.forEach((v, i) => (v === L ? te : tr).push(i)); for (const [name, fit] of Object.entries(factories)) { if (new Set(tr.map(i => y[i])).size < 2) { te.forEach(i => { pred[name][i] = y[tr[0]]; }); continue; } const m = fit(tr.map(i => X[i]), tr.map(i => y[i])), Xt = te.map(i => X[i]), p = predCls(m, Xt), sc = pDEof(m, Xt); te.forEach((i, q) => { pred[name][i] = p[q]; score[name][i] = sc[q]; }); } }
  return { d, pred, score };
}
function loloAcc(d, feats, fit) { const X = featMat(d, feats), y = d.map(r => r.fault), lv = d.map(r => r.level), ok = []; for (const L of [...new Set(lv)].sort((a, b) => a - b)) { const tr = [], te = []; lv.forEach((v, i) => (v === L ? te : tr).push(i)); if (new Set(tr.map(i => y[i])).size < 2) continue; const m = fit(tr.map(i => X[i]), tr.map(i => y[i])), p = predCls(m, te.map(i => X[i])); te.forEach((i, q) => ok.push(p[q] === y[i] ? 1 : 0)); } return ok.length ? rmean(ok) : NaN; }
async function permTestClassifier(rows, feats, fit, nPerm, seed = 1, tick) {
  const d = rows.filter(r => R_CLASSES.includes(r.fault)), obs = loloAcc(d, feats, fit), rng = radRng(seed), nul = [];
  for (let k = 0; k < nPerm; k++) { const lab = d.map(r => r.fault); for (let i = lab.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lab[i], lab[j]] = [lab[j], lab[i]]; } nul.push(loloAcc(d.map((r, i) => Object.assign({}, r, { fault: lab[i] })), feats, fit)); if (tick && k % 10 === 9) await tick(k / nPerm); }
  return { obs, p: (nul.filter(v => v >= obs).length + 1) / (nPerm + 1), nul };
}
async function permTestSeverity(rows, feats, nPerm, seed = 2, tick) {
  const gain = d => { const pr = loloSeverity(d, feats, { b: fitMean, m: fitAvgLinear }), f = d.map((r, i) => i).filter(i => d[i].level > 0); return rmean(f.map(i => Math.abs(pr.b[i] - d[i].level))) - rmean(f.map(i => Math.abs(pr.m[i] - d[i].level))); };
  const obs = gain(rows), rng = radRng(seed), idx = rows.map((r, i) => i).filter(i => rows[i].level > 0), nul = [];
  for (let k = 0; k < nPerm; k++) { const lv = idx.map(i => rows[i].level); for (let i = lv.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lv[i], lv[j]] = [lv[j], lv[i]]; } const dd = rows.map(r => Object.assign({}, r)); idx.forEach((i, q) => dd[i].level = lv[q]); nul.push(gain(dd)); if (tick && k % 2 === 1) await tick(k / nPerm); }
  return { obs, p: (nul.filter(v => v >= obs).length + 1) / (nPerm + 1) };
}
function bootCI(vals, B = RAD.N_BOOT, seed = 0) { const v = Array.from(vals).filter(Number.isFinite); if (v.length < 2) return [NaN, NaN]; const rng = radRng(seed + 1), ms = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[Math.floor(rng() * v.length)]; ms.push(s / v.length); } ms.sort((a, c) => a - c); const q = p => { const k = (ms.length - 1) * p, f = Math.floor(k), c2 = Math.min(f + 1, ms.length - 1); return ms[f] + (ms[c2] - ms[f]) * (k - f); }; return [q(0.025), q(0.975)]; }
function severityMetrics(rows, preds) {
  const idx = rows.map((r, i) => i).filter(i => rows[i].level > 0), y = idx.map(i => rows[i].level), base = rmean(idx.map(i => Math.abs(preds["Mean-predictor baseline"][i] - rows[i].level))), out = [];
  for (const [name, p0] of Object.entries(preds)) { const p = idx.map(i => p0[i]), e = p.map((v, i) => Math.abs(v - y[i])), ym = rmean(y), ss = y.reduce((s, v) => s + (v - ym) ** 2, 0), sr = p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0), pm = rmean(p), cov = y.reduce((s, v, i) => s + (v - ym) * (p[i] - pm), 0), vp = p.reduce((s, v) => s + (v - pm) ** 2, 0), [lo, hi] = bootCI(e);
    out.push({ Model: name, MAE: rmean(e), lo, hi, RMSE: Math.sqrt(sr / y.length), MedAE: rmedian(e), MaxAE: Math.max(...e), R2: 1 - sr / ss, r: vp > 1e-12 ? cov / Math.sqrt(ss * vp) : NaN, skill: 1 - rmean(e) / base }); }
  return out;
}
function auc(y, s) { let pos = 0, neg = 0, w = 0; for (let i = 0; i < y.length; i++) for (let j = 0; j < y.length; j++) if (y[i] === 1 && y[j] === 0) { pos++; w += s[i] > s[j] ? 1 : s[i] === s[j] ? 0.5 : 0; } return pos ? w / pos : NaN; }
function classificationMetrics(d, pred, score) {
  const y = d.map(r => r.fault), out = [];
  for (const [name, p] of Object.entries(pred)) { const ok = p.map((v, i) => (v === y[i] ? 1 : 0)), [lo, hi] = bootCI(ok); let tp = 0, tn = 0, fp = 0, fn = 0; y.forEach((t, i) => { const pd = p[i] === "DE", td = t === "DE"; if (pd && td) tp++; else if (!pd && !td) tn++; else if (pd && !td) fp++; else fn++; });
    const rec = (a, b) => (a + b ? a / (a + b) : 0), prec = (a, b) => (a + b ? a / (a + b) : 0), f1 = (pr, rc) => (pr + rc ? 2 * pr * rc / (pr + rc) : 0), pD = prec(tp, fp), rD = rec(tp, fn), pS = prec(tn, fn), rS = rec(tn, fp), den = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)), s = score[name], ok2 = Array.from(s).every(Number.isFinite) && new Set(Array.from(s)).size > 1;
    out.push({ Model: name, Accuracy: rmean(ok), lo, hi, Balanced: (rD + rS) / 2, MacroF1: (f1(pD, rD) + f1(pS, rS)) / 2, MCC: den ? (tp * tn - fp * fn) / den : 0, AUC: ok2 ? auc(y.map(t => (t === "DE" ? 1 : 0)), Array.from(s)) : NaN, tp, tn, fp, fn }); }
  return out;
}
/* --- clean, fit, diagnose --- */
function radClean(rows) {
  const msgs = []; let d = rows.slice(); const byMd5 = {}; d.forEach(r => (byMd5[r.md5] = byMd5[r.md5] || []).push(r)); const bad = new Set();
  for (const g of Object.values(byMd5)) if (g.length > 1 && new Set(g.map(r => r.fault + "|" + r.level)).size > 1) { g.forEach(r => bad.add(r.file)); msgs.push("IDENTICAL CONTENT BUT DIFFERENT LABELS (both removed): " + g.map(r => r.file).join(", ")); }
  d = d.filter(r => !bad.has(r.file)); const seen = new Set(), out = []; for (const r of d) { const k = r.md5 + "|" + r.fault + "|" + r.level; if (seen.has(k)) { msgs.push("identical copy skipped: " + r.file); continue; } seen.add(k); out.push(r); }
  const last = new Map(); out.forEach(r => last.set(r.file, r)); return { rows: [...last.values()], msgs };
}
async function radFitBundle(train, log, tick) {
  const Xs = featMat(train, R_SEV), ys = train.map(r => r.level), sev = fitAvgLinear(Xs, ys), fa = train.filter(r => R_CLASSES.includes(r.fault)), clf = fitET(featMat(fa, R_CLF), fa.map(r => r.fault));
  log("validating on unseen severity levels (leave-one-level-out)…"); if (tick) await tick(0.1);
  const prs = loloSeverity(train, R_SEV, { base: fitMean, m: fitAvgLinear }), fi = train.map((r, i) => i).filter(i => train[i].level > 0), y = fi.map(i => train[i].level), pm = fi.map(i => prs.m[i]), res = pm.map((v, i) => Math.abs(v - y[i])), mae = rmean(res), maeBase = rmean(fi.map(i => Math.abs(prs.base[i] - train[i].level)));
  const lmin = Math.min(...y), lmax = Math.max(...y), inner = res.filter((_, i) => y[i] > lmin && y[i] < lmax), resIn = inner.length >= 3 ? inner : res, maeIn = rmean(resIn), q80 = rquant(resIn, 0.8);
  log("permutation test for SE vs DE (100 label shuffles)…"); const pc = await permTestClassifier(train, R_CLF, (X, l) => fitET(X, l, 100), RAD.N_PERM_CLF, 1, tick ? p => tick(0.1 + 0.4 * p) : null);
  const lo = R_SEV.map(f => Math.min(...train.map(r => r[f]))), hi = R_SEV.map(f => Math.max(...train.map(r => r[f]))), span = hi.map((h, i) => h - lo[i]), cnt = { SE: 0, DE: 0 }; fa.forEach(r => cnt[r.fault]++);
  return { sevModel: sev, clfModel: clf, lo: lo.map((v, i) => v - 0.25 * span[i]), hi: hi.map((v, i) => v + 0.25 * span[i]), val: { sev_q80: q80, sev_mae_interior: maeIn, sev_mae: mae, sev_mae_baseline: maeBase, clf_acc: pc.obs, clf_p: pc.p, clf_majority: Math.max(cnt.SE, cnt.DE) / fa.length, n_train_files: train.length } };
}
function radDiagnose(b, row) {
  const xs = [Float64Array.from(R_SEV, f => row[f])], sev = predSev(b.sevModel, xs)[0], xc = [Float64Array.from(R_CLF, f => row[f])], pde = pDE_ET(b.clfModel, xc)[0], typ = pde >= 0.5 ? "DE" : "SE", v = b.val, oor = R_SEV.filter((f, i) => row[f] < b.lo[i] || row[f] > b.hi[i]), faulty = sev >= RAD.HEALTHY_THR;
  return { file: row.file, status: faulty ? "FAULTY" : "HEALTHY", severity: sev, type: typ, pDE: pde, typeReliable: v.clf_p <= 0.05 && v.clf_acc > v.clf_majority, outOfRange: oor, lo80: Math.max(0, sev - v.sev_q80), hi80: Math.min(100, sev + v.sev_q80) };
}


/* ===================== RADIAL: interface ===================== */
const RAD_NAME = { SE: "Static eccentricity (SE)", DE: "Dynamic eccentricity (DE)", Healthy: "Healthy" };
const radRole = p => { const parts = String(p || "").split("/").slice(0, -1).map(s => s.toLowerCase()); for (let i = parts.length - 1; i >= 0; i--) { const t = /test/.test(parts[i]), r = /train/.test(parts[i]); if (t && !r) return "test"; if (r && !t) return "train"; } return "train"; };
async function radHash(buf) { try { const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join(""); } catch (e) { const a = new Uint8Array(buf); let s = 0; for (let i = 0; i < a.length; i += 7) s = (s * 31 + a[i]) >>> 0; return a.length + "_" + s; } }
const rf = (v, n = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "--" : v.toFixed(n));
const lineKey = k => `L${k >= 0 ? "+" : "-"}${Math.abs(k)}`;
const radStripRow = r => { const o = Object.assign({}, r); delete o._wave; delete o._z; delete o._fs; return o; };
const radTable = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
function radStatusText(T) { const tr = T.rows.filter(r => r.role === "train"), c = f => tr.filter(r => r.fault === f).length; return `${tr.length} training files (${c("Healthy")} healthy, ${c("SE")} static, ${c("DE")} dynamic) · levels ${[...new Set(tr.filter(r => r.level > 0).map(r => r.level))].sort((a, b) => a - b).join(", ")} %${T.rows.some(r => r.role === "test") ? " · " + T.rows.filter(r => r.role === "test").length + " test files" : ""}`; }
function teachIntro() { return topology() === "radial" ? 'Zip your radial <b>train</b> folder (optionally with a <b>test</b> folder inside) and upload the .zip. Each file needs a <b>Time</b> column and <b>Phase A / B / C</b> currents. File names give the labels: <code>Healthy</code>, <code>Static_10%</code>, <code>Dynamic_20%</code>. Needs one Healthy file and at least 3 faulty levels. Training takes a few seconds and is remembered in this browser.' : 'Zip your <b>train</b> folder (optionally with a <b>test</b> folder inside for a hold-out check) and upload the .zip. File names give the labels: <code>healthy</code>, <code>tilt-30%</code>, <code>x(disp)-4%</code>. Training takes a few seconds and is remembered in this browser.'; }

async function teachRadial(fileList) {
  if (S.busy) return; S.busy = true; S.permTok = (S.permTok || 0) + 1; renderRail(); progressUI(); const t0 = performance.now();
  try {
    const files = [...fileList].filter(f => /\.(xls|xlsx|csv)$/i.test(f.name)); if (!files.length) throw new Error("No .xls / .xlsx / .csv files found in that upload.");
    const rows = []; let n = 0;
    for (const f of files) {
      const role = radRole(f.webkitRelativePath || f.name);
      try { const buf = await f.arrayBuffer(), md5 = await radHash(buf), data = await readRows({ name: f.name, arrayBuffer: async () => buf }), r = radProcess(data, f.name, role, md5, true); rows.push(r); logTo(`${r.file} → ${r.fault} ${r.level}% [${role}] · f0 ${r.f0_Hz.toFixed(2)} Hz, ${r.cycles} cycles, |I1| ${r.I1_A.toFixed(3)} A`); }
      catch (e) { logTo(`SKIPPED ${f.name}: ${e.message}`); } progTo(0.22 * (++n / files.length)); await yieldUI();
    }
    if (!rows.length) throw new Error("No usable files. Each file needs Time and Phase A/B/C columns and a name with healthy / static / dynamic and the %.");
    const { rows: clean, msgs } = radClean(rows); msgs.forEach(m => logTo("NOTE: " + m));
    const centres = radBatch(clean), train = clean.filter(r => r.role === "train"), test = clean.filter(r => r.role === "test");
    if (!train.some(r => r.fault === "Healthy") || new Set(train.filter(r => R_CLASSES.includes(r.fault)).map(r => r.level)).size < 3) throw new Error("Need a Healthy file and at least 3 different faulty levels among the training files.");
    logTo(`training set: ${train.length} files, one sample per recording`);
    const tick = async p => { progTo(0.22 + 0.4 * p); await yieldUI(); };
    const bundle = await radFitBundle(train, logTo, tick); progTo(0.65);
    logTo("building the validation report…"); await yieldUI();
    const preds = loloSeverity(clean, R_SEV, SEV_FACTORIES), sevMetrics = severityMetrics(clean, preds), cl = loloClassify(clean, R_CLF, CLF_FACTORIES), clsMetrics = classificationMetrics(cl.d, cl.pred, cl.score);
    progTo(0.8); await yieldUI(); const pc = await permTestClassifier(clean, R_CLF, (X, l) => fitET(X, l, 100), RAD.N_PERM_CLF, 1, async p => { progTo(0.8 + 0.15 * p); await yieldUI(); });
    const report = { sevMetrics, clsMetrics, clsPerm: { obs: pc.obs, p: pc.p }, lolo: clean.map((r, i) => ({ file: r.file, fault: r.fault, level: r.level, pred: preds[R_PRIMARY_SEV][i] })), loloClsFiles: cl.d.map((r, i) => ({ file: r.file, fault: r.fault, level: r.level, pred: cl.pred[R_PRIMARY_CLF][i], score: cl.score[R_PRIMARY_CLF][i] })), sevPerm: null, split: null };
    if (test.length && train.length >= 4) {
      const Xtr = featMat(train, R_SEV), ytr = train.map(r => r.level), Xte = featMat(test, R_SEV), sevRows = {}; for (const [name, fit] of Object.entries(SEV_FACTORIES)) sevRows[name] = predSev(fit(Xtr, ytr), Xte).map(clip100);
      const fa = train.filter(r => R_CLASSES.includes(r.fault)), Xc = featMat(fa, R_CLF), yc = fa.map(r => r.fault), Xtc = featMat(test, R_CLF), typ = {}; for (const [name, fit] of Object.entries(CLF_FACTORIES)) typ[name] = predCls(fit(Xc, yc), Xtc);
      report.split = { files: test.map(r => ({ file: r.file, fault: r.fault, level: r.level })), sev: sevRows, typ };
    }
    const healthy = train.find(r => r.fault === "Healthy"), M = { kind: "radial", ver: 5, machine: S.machine, topology: "radial", trainedAt: new Date().toLocaleString(), seconds: +((performance.now() - t0) / 1000).toFixed(1), bundle, centres, rows: clean.map(radStripRow),
      sevMax: Math.max(...train.map(r => r.level)), refLines: healthy ? R_ORDERS.map(k => healthy[lineKey(k)]) : null, refZ: healthy ? healthy._z : null, refWave: healthy ? healthy._wave : null, report, demo: false };
    S.twins[S.machine] = M; S.results = {}; S.order = []; S.sel = null; progTo(1); await DB.put(S.machine, M); logTo(`done in ${M.seconds} s`);
    S.busy = false; renderRail(); renderMain(); radSevPermAsync(M, clean);
  } catch (e) { S.busy = false; renderRail(); const l = $("#trainLog"); if (l) l.innerHTML = `<div class="note" style="border-color:var(--crit);background:#2a1014;color:#fca5a5">${esc(e.message)}</div>`; renderMain(); }
}
async function radSevPermAsync(M, rows) {
  const tok = S.permTok; try { const r = await permTestSeverity(rows, R_SEV, RAD.N_PERM_SEV, 2, async p => { if (S.permTok !== tok) throw new Error("stale"); M.permProgress = p; await yieldUI(); if (S.tab === "model" && twin() === M) { const el = $("#sevPermMsg"); if (el) el.textContent = `running… ${Math.round(p * 100)} %`; } }); M.report.sevPerm = r; await DB.put(M.machine, M); if (S.tab === "model" && twin() === M && topology() === "radial") renderMain(); } catch (e) { /* cancelled */ }
}
async function feedRadial(files) {
  const T = twin(); if (!T || T.kind !== "radial") return; const errs = []; $("#feedMsg").textContent = `Analysing ${files.length} file(s)…`; await yieldUI();
  for (const f of files) {
    try { const buf = await f.arrayBuffer(), md5 = await radHash(buf), data = await readRows({ name: f.name, arrayBuffer: async () => buf }), row = radProcess(data, f.name, "test", md5, false); radBatch([row], T.centres); const d = radDiagnose(T.bundle, row);
      S.results[f.name] = Object.assign(d, { name: f.name, row, lines: R_ORDERS.map(k => row[lineKey(k)]), wave: row._wave, z: row._z, fs: RAD.FS_OUT }); if (!S.order.includes(f.name)) S.order.push(f.name); S.sel = f.name; }
    catch (e) { errs.push(`${f.name}: ${e.message}`); } await yieldUI();
  }
  S.tab = "twin"; renderMain(); $("#feedMsg").textContent = errs.length ? errs.join(" · ") : "Done. Drop another file any time."; $("#feedMsg").style.color = errs.length ? "#fca5a5" : "";
}
const radColor = (R, T) => { if (R.status === "HEALTHY") return LEVEL.ok; const f = R.severity / T.sevMax; return f < 0.34 ? LEVEL.warn : f < 0.67 ? LEVEL.alert : LEVEL.crit; };
const radKind = R => (R.status === "HEALTHY" ? "none" : R.type === "DE" ? "orbit" : "disp");
function radTruth(name) { try { const [f, l] = radParseLabel(name); return { fault: f, level: l }; } catch (e) { return null; } }
function radValText(T) { const v = T.bundle.val; return `validation MAE ${v.sev_mae_interior.toFixed(1)} points (interior levels), ${v.sev_mae.toFixed(1)} including extremes, mean-predictor baseline ${v.sev_mae_baseline.toFixed(1)}`; }
function renderRadial() {
  const m = $("#main"), T = twin();
  if (!T || T.kind !== "radial") { m.innerHTML = `<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))"><div style="display:grid;gap:12px;align-content:start"><div class="card"><h3>Twin offline</h3><div class="kpi" style="color:var(--warn)">Not taught yet</div><div class="small" style="margin-top:8px;font-size:.95rem">Upload your radial train zip in step 1. The page extracts one set of whole-cycle Fourier features per recording, fits the severity and SE/DE models, and validates them on unseen levels.</div></div></div><div class="plot" style="padding:6px">${svgRadial("none", 0, LEVEL.idle, "STANDBY")}</div></div>`; return; }
  const v = T.bundle.val, rep = T.report;
  if (!S.sel) { m.innerHTML = `<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))"><div style="display:grid;gap:12px;align-content:start"><div class="card"><h3>Awaiting data</h3><div class="kpi" style="color:var(--accent)">Twin ready</div><div class="small" style="margin-top:8px;font-size:.95rem">Drop a new radial stator-current file on the left. The twin estimates the eccentricity %, the type (static or dynamic) and tells you how far to trust each answer.</div></div>${radValidationCard(T)}</div><div class="plot" style="padding:6px">${svgRadial("none", 0, LEVEL.ok, "NOMINAL")}</div></div>`; return; }
  const R = S.results[S.sel], col = radColor(R, T), faulty = R.status === "FAULTY", tr = radTruth(S.sel), kind = radKind(R), frac = Math.min(R.severity / T.sevMax, 1);
  const typeTxt = RAD_NAME[R.type], titleTxt = !faulty ? "Healthy" : R.typeReliable ? `${typeTxt} · ≈ ${rf(R.severity, 1)} %` : `Eccentricity ≈ ${rf(R.severity, 1)} % · type uncertain`;
  const truth = tr && tr.fault !== "?" ? `<div class="small" style="margin-top:6px">File name says: <b>${esc(RAD_NAME[tr.fault] || tr.fault)}${tr.fault === "Healthy" ? "" : " " + tr.level + " %"}</b> · severity error ${R.severity - tr.level >= 0 ? "+" : ""}${rf(R.severity - tr.level, 1)} points${faulty && tr.fault !== "Healthy" ? " · type " + (tr.fault === R.type ? "✅ matches" : "⚠️ differs") : ""}</div>` : "";
  const sel = S.order.length > 1 ? `<label class="small" for="recSel">Record shown</label><select id="recSel" style="display:block;width:100%;margin:2px 0 10px;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px">${S.order.map(n => `<option ${n === S.sel ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : "";
  const notes = []; if (R.outOfRange.length) notes.push("Features outside the training range (extrapolation): " + R.outOfRange.join(", ") + ". Treat the numbers with caution."); if (!faulty) notes.push(`Healthy rule: estimate below ${RAD.HEALTHY_THR} %. It rests on ${T.rows.filter(r => r.fault === "Healthy" && r.role === "train").length} healthy recording(s), so specificity cannot be validated.`); if (faulty && !R.typeReliable) notes.push(`SE vs DE is NOT reliable on the current data (validation p = ${rf(v.clf_p)}). The type below is tentative.`);
  m.innerHTML = `${sel}<div class="verdict" style="border-color:${rgba(col, .55)};background:linear-gradient(90deg,${rgba(col, .16)},rgba(11,22,38,.4))"><span class="pill" style="background:${col}">${R.status}</span>
    <div style="flex:1;min-width:220px"><div class="big" style="color:${col}">${esc(titleTxt)}</div><div class="small" style="font-size:.95rem">${faulty ? `Estimated eccentricity <b>${rf(R.severity, 1)} %</b>, 80 % interval ${R.lo80.toFixed(0)}–${R.hi80.toFixed(0)} %. Type: <b>${esc(typeTxt)}</b> (P(DE) = ${rf(R.pDE)}), ${R.typeReliable ? "validated" : "<b>NOT reliable</b>"}.` : `Estimated eccentricity ${rf(R.severity, 1)} %, below the ${RAD.HEALTHY_THR} % healthy threshold.`}</div>${truth}</div>
    <div style="text-align:right"><div class="small">estimated eccentricity</div><div class="kpi" style="color:${col};font-size:2.4rem">${rf(R.severity, 1)}%</div></div></div>${notes.map(n => `<div class="note">⚠ ${esc(n)}</div>`).join("")}
  <div class="tabs" role="tablist">${[["twin", "◉ Live twin"], ["sig", "〜 Signals & spectrum"], ["model", "◈ Model room"], ["batch", "▤ Batch & report"]].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join("")}</div><div class="pane" id="pane"></div>`;
  $("#recSel") && ($("#recSel").onchange = e => { S.sel = e.target.value; renderMain(); }); m.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderMain(); });
  const pane = $("#pane"), health = faulty ? 100 * (1 - 0.9 * frac) : 100 - Math.min(R.severity, 100) * 0.9 / T.sevMax * 100 * 0 ;
  if (S.tab === "twin") {
    pane.innerHTML = `<div class="kpis">${card("Estimated eccentricity", rf(R.severity, 1) + " %", `80 % interval ${R.lo80.toFixed(0)}–${R.hi80.toFixed(0)} % · trained up to ${T.sevMax} %`, col)}${card("Fault type", faulty ? R.type : "—", faulty ? `P(DE) = ${rf(R.pDE)} · ${R.typeReliable ? "validated" : "NOT reliable (p = " + rf(v.clf_p) + ")"}` : "no fault flagged", faulty ? (R.typeReliable ? col : LEVEL.warn) : LEVEL.ok)}${card("Validation (unseen levels)", rf(v.sev_mae_interior, 1) + " pts", `mean error vs ${rf(v.sev_mae_baseline, 1)} for the mean predictor · ${v.n_train_files} files`)}${card("Data familiarity", R.outOfRange.length ? "outside range" : "inside range", R.outOfRange.length ? esc(R.outOfRange.join(", ")) : "all features within the training range", R.outOfRange.length ? LEVEL.crit : LEVEL.ok)}</div>
    <div class="two" style="margin-top:12px"><div class="plot" style="padding:6px">${svgRadial(kind, frac, col, faulty ? `${R.type} ≈ ${rf(R.severity, 1)} %` : "NOMINAL")}</div><div style="display:grid;gap:12px;min-width:0;align-content:start"><div class="plot" id="pGauge"></div><div class="plot" id="pProb"></div><div class="plot" id="pSev"></div><div class="plot" id="pPark"></div></div></div>`;
    plot("pGauge", [{ type: "indicator", mode: "gauge+number", value: faulty ? health : 100, number: { font: { color: col, size: 40 } }, title: { text: "HEALTH INDEX", font: { size: 12, color: "#8ea7c4" } }, gauge: { axis: { range: [0, 100], tickvals: [0, 50, 100] }, bar: { color: col, thickness: .3 }, bgcolor: "#0e1d31", borderwidth: 0, steps: [{ range: [0, 40], color: "#3a1620" }, { range: [40, 70], color: "#3a2a14" }, { range: [70, 100], color: "#10342d" }] } }], { showlegend: false, margin: { l: 30, r: 30, t: 40, b: 10 } }, 190);
    plot("pProb", [{ type: "bar", orientation: "h", x: [(1 - R.pDE) * 100, R.pDE * 100], y: ["Static (SE)", "Dynamic (DE)"], marker: { color: [R.type === "SE" ? col : "#2c4668", R.type === "DE" ? col : "#2c4668"] }, text: [((1 - R.pDE) * 100).toFixed(0) + "%", (R.pDE * 100).toFixed(0) + "%"], textposition: "outside", cliponaxis: false }], { showlegend: false, xaxis: { range: [0, 125], showgrid: false, ticksuffix: "%" }, yaxis: { automargin: true, autorange: "reversed" }, title: { text: "Fault-type score (Extra trees)" + (R.typeReliable ? "" : " · tentative"), font: { size: 13 } } }, 190);
    const shapes = tr && tr.fault !== "?" && tr.fault !== "Healthy" ? [{ type: "line", x0: tr.level, x1: tr.level, y0: -.5, y1: .5, line: { color: "#22d3a6", width: 3 } }] : [];
    plot("pSev", [{ type: "scatter", mode: "markers", x: [R.severity], y: ["estimate"], marker: { color: col, size: 14 }, error_x: { type: "data", symmetric: false, array: [R.hi80 - R.severity], arrayminus: [R.severity - R.lo80], color: col, thickness: 3, width: 8 }, hovertemplate: "%{x:.1f} %<extra></extra>" }], { showlegend: false, shapes, xaxis: { range: [0, Math.max(60, R.hi80 * 1.15)], ticksuffix: " %", gridcolor: "#16283f" }, yaxis: { visible: false }, title: { text: "Eccentricity estimate with 80 % interval" + (shapes.length ? " (green = file name)" : ""), font: { size: 13 } } }, 150);
    const nz = R.z[0].length, tr2 = [{ x: R.z[0], y: R.z[1], mode: "lines", line: { color: col, width: 2 }, name: "measured" }]; if (T.refZ) tr2.push({ x: T.refZ[0], y: T.refZ[1], mode: "lines", line: { color: "rgba(235,242,255,.9)", width: 1.4, dash: "dot" }, name: "healthy twin" });
    plot("pPark", tr2, { title: { text: "Park-vector locus (αβ currents)", font: { size: 13 } }, xaxis: { title: "iα [A]", scaleanchor: "y", zeroline: false, gridcolor: "#16283f" }, yaxis: { title: "iβ [A]", zeroline: false, gridcolor: "#16283f" } }, 300);
  } else if (S.tab === "sig") {
    const rw = R.row;
    pane.innerHTML = `<div class="kpis">${card("Supply frequency", rf(rw.f0_Hz, 2) + " Hz", `${rw.cycles} whole cycles analysed · fs ${R.fs} Hz`)}${card("Fundamental |I₁|", rf(rw.I1_A, 3) + " A", `RMS ${rf(rw.RMS_A, 3)} A · batch ${rw.Batch}`)}${card("Harmonics (5th / 7th)", rf(rw.H5_pct, 2) + " / " + rf(rw.H7_pct, 2) + " %", `11th ${rf(rw.H11_pct, 2)} % · 13th ${rf(rw.H13_pct, 2)} %`)}${card("Asymmetry index", rf(rw.AsymIndex_pct, 3) + " %", `lines a symmetric machine cannot have, % of fundamental`)}${card("Cycle repeatability", rf(rw.cycle_dev_pct, 3) + " %", `largest cycle-to-cycle deviation (tiny = exactly periodic)`)}${card("Off-grid max", rf(rw.offgrid_max_pct, 3) + " %", `largest line not on a multiple of f0 (sidebands / noise)`)}</div>
    <div class="plot" id="pLines" style="margin-top:12px"></div><div class="plot" id="pWave" style="margin-top:12px"></div>`;
    const ks = R_ORDERS, tr3 = []; if (T.refLines) tr3.push({ type: "bar", x: ks.map(k => k - 0.2), y: T.refLines.map(v => Math.max(v, 1e-4)), width: 0.4, name: "healthy twin", marker: { color: "#8a8985" } }); tr3.push({ type: "bar", x: ks.map(k => k + 0.2), y: R.lines.map(v => Math.max(v, 1e-4)), width: 0.4, name: "this record", marker: { color: col } });
    plot("pLines", tr3, { title: { text: `Park-vector line spectrum: energy only at multiples of ${rf(rw.f0_Hz, 0)} Hz (% of fundamental)`, font: { size: 13 } }, barmode: "overlay", xaxis: { title: "harmonic order k  (line at k × f0)", gridcolor: "#16283f", dtick: 5 }, yaxis: { type: "log", range: [-3, 2.7], title: "amplitude [% of fundamental]", gridcolor: "#16283f" } }, 340);
    const tt = R.wave[0].map((_, i) => i / R.fs * 1e3); plot("pWave", R.wave.map((w, i) => ({ x: tt, y: w, mode: "lines", name: "phase " + "ABC"[i], line: { color: PHASE[i], width: 2 } })), { title: { text: "Stator currents · 3 electrical cycles (after the start-up transient)", font: { size: 13 } }, xaxis: { title: "time [ms]", gridcolor: "#16283f" }, yaxis: { title: "current [A]", gridcolor: "#16283f" } }, 300);
  } else if (S.tab === "model") {
    pane.innerHTML = `${radValidationCard(T)}${radModelRoom(T)}`; radModelPlots(T);
  } else {
    const rows = S.order.map(n => { const r = S.results[n], t = radTruth(n); return [esc(n), r.status, rf(r.severity, 1), `${r.lo80.toFixed(0)}–${r.hi80.toFixed(0)}`, r.status === "FAULTY" ? r.type : "—", rf(r.pDE), r.status === "FAULTY" ? (r.typeReliable ? "validated" : "NOT reliable") : "—", r.outOfRange.length ? "outside" : "inside", t && t.fault !== "?" ? esc(RAD_NAME[t.fault]) + (t.fault === "Healthy" ? "" : " " + t.level + "%") : "—", t && t.fault !== "?" ? (r.severity - t.level >= 0 ? "+" : "") + rf(r.severity - t.level, 1) : ""]; });
    const adv = !faulty ? "Operate normally. Re-run the twin periodically to keep the trend." : (R.severity / T.sevMax < 0.34 ? "Early sign of eccentricity. Plan an inspection of bearings and rotor alignment at the next maintenance window." : R.severity / T.sevMax < 0.67 ? "Clear eccentricity. Plan corrective action soon." : "Severe eccentricity. Risk of rotor–stator contact: reduce load and inspect immediately.");
    pane.innerHTML = `<div class="card scroll">${radTable(["File", "Status", "Est. %", "80% interval", "Type", "P(DE)", "Type check", "Familiarity", "File-name label", "Error (pts)"], rows)}</div><div style="margin:12px 0;display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" id="copyCsv" type="button">Copy table (CSV)</button><button class="btn ghost" id="copyRep" type="button">Copy summary text</button><span class="small" id="copyMsg" style="align-self:center"></span></div>
    <div class="card"><h3>Plain-language summary</h3><div>${esc(S.sel)} → <b>${esc(faulty ? "eccentricity detected" : "healthy")}</b>${faulty ? `, about ${rf(R.severity, 1)} % (80 % interval ${R.lo80.toFixed(0)}–${R.hi80.toFixed(0)} %), type ${esc(RAD_NAME[R.type])} ${R.typeReliable ? "(validated)" : "(tentative, NOT reliable on current data)"}` : ""}. ${adv} Reference: ${esc(radValText(T))}.</div></div>`;
    const copy = txt => { const ok = () => $("#copyMsg").textContent = "Copied ✓", fail = () => { $("#copyMsg").textContent = "Your browser blocked copying. Select the table and copy it manually."; }; try { navigator.clipboard.writeText(txt).then(ok, fail); } catch (e) { fail(); } };
    $("#copyCsv").onclick = () => copy(["file,status,severity_pct,lo80,hi80,type,pDE,type_reliable"].concat(S.order.map(n => { const r = S.results[n]; return `"${n}",${r.status},${rf(r.severity, 1)},${r.lo80.toFixed(0)},${r.hi80.toFixed(0)},${r.type},${rf(r.pDE)},${r.typeReliable}`; })).join("\n"));
    $("#copyRep").onclick = () => copy(`${S.sel}: ${faulty ? "eccentricity about " + rf(R.severity, 1) + " % (80 % interval " + R.lo80.toFixed(0) + "-" + R.hi80.toFixed(0) + " %), type " + RAD_NAME[R.type] + (R.typeReliable ? " (validated)" : " (tentative)") : "healthy"}. ${adv}`);
  }
}
function radValidationCard(T) {
  const v = T.bundle.val, ok = v.clf_p <= 0.05 && v.clf_acc > v.clf_majority, good = v.sev_mae < v.sev_mae_baseline;
  return `<div class="card" style="margin-top:0"><h3>How far can you trust this twin? (unseen severity levels)</h3><div style="display:grid;gap:8px;font-size:.95rem">
  <div><b style="color:${good ? "var(--ok)" : "var(--warn)"}">Eccentricity %:</b> mean error <b>${rf(v.sev_mae_interior, 1)}</b> points on interior levels (${rf(v.sev_mae, 1)} including the lowest and highest level, which are extrapolations) versus ${rf(v.sev_mae_baseline, 1)} for always guessing the average. 80 % of interior errors were at most ${rf(v.sev_q80, 1)} points.${good ? "" : " With so few levels, holding one out leaves too little to interpolate: add more levels."}</div>
  <div><b style="color:${ok ? "var(--ok)" : "var(--warn)"}">Static vs dynamic:</b> accuracy ${(v.clf_acc * 100).toFixed(0)} % on unseen levels (majority guess ${(v.clf_majority * 100).toFixed(0)} %), permutation test p = ${rf(v.clf_p)}. ${ok ? "Better than chance, but the classifier was chosen on these same files, so treat it as tentative." : "<b>Not separable from these currents</b> with the current data: the type is shown as tentative only."}</div>
  <div class="small">Each recording is one sample (its identical cycles are not separate samples). Trained ${esc(T.trainedAt)} in ${T.seconds} s on ${v.n_train_files} files.</div></div></div>`;
}
function radModelRoom(T) {
  const rep = T.report, sm = rep.sevMetrics, cm = rep.clsMetrics, best = (arr, k, mode) => (mode === "min" ? Math.min : Math.max)(...arr.map(r => r[k]).filter(Number.isFinite));
  const bold = (v, b, nd) => (Number.isFinite(v) && Math.abs(v - b) < 1e-9 ? `<b style="color:var(--accent)">${rf(v, nd)}</b>` : rf(v, nd));
  const t2 = radTable(["Model", "MAE (%)", "95% CI", "RMSE", "MedAE", "MaxAE", "R²", "Pearson r", "Skill vs baseline"], sm.map(r => [esc(r.Model), bold(r.MAE, best(sm, "MAE", "min"), 2), `[${rf(r.lo, 1)}, ${rf(r.hi, 1)}]`, bold(r.RMSE, best(sm, "RMSE", "min"), 2), bold(r.MedAE, best(sm, "MedAE", "min"), 2), bold(r.MaxAE, best(sm, "MaxAE", "min"), 2), bold(r.R2, best(sm, "R2", "max"), 2), bold(r.r, best(sm, "r", "max"), 2), bold(r.skill, best(sm, "skill", "max"), 2)]));
  const t3 = radTable(["Model", "Accuracy", "95% CI", "Balanced acc.", "Macro-F1", "MCC", "AUC (SE/DE)"], cm.map(r => [esc(r.Model), bold(r.Accuracy, best(cm, "Accuracy", "max"), 2), `[${rf(r.lo, 2)}, ${rf(r.hi, 2)}]`, bold(r.Balanced, best(cm, "Balanced", "max"), 2), bold(r.MacroF1, best(cm, "MacroF1", "max"), 2), bold(r.MCC, best(cm, "MCC", "max"), 2), bold(r.AUC, best(cm, "AUC", "max"), 2)]));
  const sp = rep.sevPerm ? `Severity permutation test (levels shuffled, ${RAD.N_PERM_SEV} runs): the primary model beats the mean predictor by ${rf(rep.sevPerm.obs, 2)} points, p = ${rf(rep.sevPerm.p, 3)}.` : `Severity permutation test: <span id="sevPermMsg">running… ${Math.round((T.permProgress || 0) * 100)} %</span> (runs in the background, about half a minute).`;
  let split = ""; if (rep.split) { const sp2 = rep.split, names = Object.keys(sp2.sev), head = ["Model", ...sp2.files.map(f => `${f.fault} ${f.level}%`), "MAE (%)", "Bias"]; split = `<div class="card scroll" style="margin-top:12px"><h3>Official split: models fitted on the train files, applied to your unseen test files</h3>${radTable(head, names.map(n => { const e = sp2.sev[n].map((p, i) => p - sp2.files[i].level); return [esc(n), ...sp2.sev[n].map((p, i) => `${rf(p, 1)} (${e[i] >= 0 ? "+" : ""}${rf(e[i], 1)})`), rf(rmean(e.map(Math.abs)), 2), rf(rmean(e), 2)]; }))}<div class="small" style="margin:6px 0">Estimated eccentricity % with signed error in brackets. Few files: read as an illustration, not a statistic.</div>${radTable(["Classifier", ...sp2.files.map(f => `${f.fault} ${f.level}%`), "Correct"], Object.keys(sp2.typ).map(n => [esc(n), ...sp2.typ[n].map((p, i) => (p === sp2.files[i].fault ? "ok " : "<b style='color:var(--crit)'>WRONG</b> ") + p), `${sp2.typ[n].filter((p, i) => p === sp2.files[i].fault).length}/${sp2.files.length}`]))}</div>`; }
  const qc = radTable(["File", "Role", "Type", "Level %", "f0 (Hz)", "Cycles", "|I1| (A)", "H5 %", "H7 %", "Asym. idx %", "Cycle dev %", "Off-grid %", "Batch"], T.rows.slice().sort((a, b) => a.role.localeCompare(b.role) || a.fault.localeCompare(b.fault) || a.level - b.level).map(r => [esc(r.file), r.role, r.fault, r.level, rf(r.f0_Hz, 2), r.cycles, rf(r.I1_A, 3), rf(r.H5_pct, 2), rf(r.H7_pct, 2), rf(r.AsymIndex_pct, 3), rf(r.cycle_dev_pct, 3), rf(r.offgrid_max_pct, 3), r.Batch]));
  return `<div class="two" style="margin-top:12px"><div class="plot" id="pRadSev"></div><div class="plot" id="pRadErr"></div></div>
  <div class="card scroll" style="margin-top:12px"><h3>Table II · severity models, leave-one-level-out (unseen levels)</h3>${t2}<div class="small" style="margin:6px 0">Skill = 1 − MAE / MAE(mean predictor). CI: bootstrap over files. ${sp}</div></div>
  <div class="card scroll" style="margin-top:12px"><h3>Table III · static vs dynamic classifiers, leave-one-level-out</h3>${t3}<div class="small" style="margin:6px 0">Primary classifier: accuracy ${rf(rep.clsPerm.obs, 2)}, permutation p = ${rf(rep.clsPerm.p, 3)} (${rep.clsPerm.p <= 0.05 ? "significant" : "NOT significant: SE/DE is not reliably separable from these currents"}). The classifiers were selected on these same files, so their accuracy is optimistic.</div></div>${split}
  <div class="card scroll" style="margin-top:12px"><h3>Table I · dataset quality control (one row per recording)</h3>${qc}<div class="small" style="margin:6px 0">Cycle dev. and Off-grid max tiny means the signal is exactly periodic. Batch is an unsupervised run-batch indicator from |I₁| and the 5th harmonic (no labels used).</div></div>`;
}
function radModelPlots(T) {
  const rep = T.report, f = rep.lolo.filter(r => r.level > 0), mae = rmean(f.map(r => Math.abs(r.pred - r.level))), mx = Math.max(60, ...f.map(r => r.level), ...f.map(r => r.pred)) * 1.05;
  const mk = (type, sym, col) => { const g = f.filter(r => r.fault === type); return { x: g.map(r => r.level), y: g.map(r => r.pred), mode: "markers", name: RAD_NAME[type], marker: { symbol: sym, size: 11, color: col, line: { color: "#fff", width: 1 } }, text: g.map(r => r.file), hovertemplate: "%{text}<br>true %{x} %, predicted %{y:.1f} %<extra></extra>" }; };
  plot("pRadSev", [{ x: [0, mx], y: [0, mx], mode: "lines", line: { color: "#8ea7c4", dash: "dash" }, name: "perfect" }, { x: [0, mx, mx, 0], y: [-mae, mx - mae, mx + mae, mae], fill: "toself", mode: "none", fillcolor: "rgba(142,167,196,.15)", name: `± MAE (${mae.toFixed(1)} pts)` }, mk("SE", "circle", "#38bdf8"), mk("DE", "square", "#fb923c")], { title: { text: "Predictions for held-out levels (primary severity model)", font: { size: 13 } }, xaxis: { title: "true eccentricity [%]", range: [0, mx], gridcolor: "#16283f" }, yaxis: { title: "predicted [%] (level unseen)", range: [0, mx], gridcolor: "#16283f" } }, 360);
  const g = f.slice().sort((a, b) => a.level - b.level || a.fault.localeCompare(b.fault)); plot("pRadErr", [{ type: "bar", x: g.map(r => `${r.fault} ${r.level}%`), y: g.map(r => r.pred - r.level), marker: { color: g.map(r => (r.pred - r.level >= 0 ? "#38bdf8" : "#fb923c")) }, text: g.map(r => (r.pred - r.level >= 0 ? "+" : "") + (r.pred - r.level).toFixed(1)), textposition: "outside", cliponaxis: false }], { showlegend: false, title: { text: "Signed error per file (points), whole level held out", font: { size: 13 } }, xaxis: { tickangle: -45, gridcolor: "#16283f" }, yaxis: { title: "prediction − truth [points]", gridcolor: "#16283f" } }, 360);
}

/* ---------- wiring ---------- */
async function switchMachine(name) {
  S.permTok = (S.permTok||0)+1; S.machine = name; S.sel = null; S.results = {}; S.order = [];
  $("#mAxial").setAttribute("aria-pressed", String(name.startsWith("Axial"))); $("#mRadial").setAttribute("aria-pressed", String(name.startsWith("Radial")));
  S.stale = false; if (!S.twins[name]) { const saved = await DB.get(name); if (saved && saved.ver >= 3 && (name.startsWith("Radial") ? saved.kind === "radial" : saved.kind !== "radial")) { S.twins[name] = saved; if (saved.demo) { DEMO = demoRecords(); } } else if (saved) S.stale = true; }
  renderRail(); renderMain();
}
$("#mAxial").onclick = () => switchMachine("Axial flux PMSM"); $("#mRadial").onclick = () => switchMachine("Radial flux PMSM");
$("#testFiles").onchange = e => { feed(e.target.files); e.target.value = ""; };
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => feed(e.dataTransfer.files));
switchMachine("Axial flux PMSM");
