import { levenbergMarquardt as LM } from 'https://esm.sh/ml-levenberg-marquardt@4.1.3';

export const PARAM_NAMES = ['Bottom', 'Top', 'EC50', 'IC50', 'Hill1', 'Hill2'];

const N_STARTS = 10;
const PRNG_SEED = 0x42424242;

// Wide-open values used when a parameter is "Unconstrained" by the user.
export const UNCONSTRAINED_HILL_MIN = 0.01;
export const UNCONSTRAINED_HILL_MAX = 1000;
export const UNCONSTRAINED_CONC_MIN = 1e-9;   // nM
export const UNCONSTRAINED_CONC_MAX = 1e9;    // nM

// Default Hill bounds when caller doesn't supply them.
export const DEFAULT_HILL_MIN = 0.5;
export const DEFAULT_HILL_MAX = 4;

// Data-derived defaults for EC50 and IC50 are
//   min = xMin / DATA_FACTOR_BELOW, max = xMax * DATA_FACTOR_ABOVE
// chosen so the optimizer has plenty of room outside the measured range
// without being completely unbounded.
export const DEFAULT_CONC_FACTOR_BELOW = 100;
export const DEFAULT_CONC_FACTOR_ABOVE = 100;

function bellModel([Bottom, Top, EC50, IC50, Hill1, Hill2]) {
  return (x) => {
    if (!(x > 0) || EC50 <= 0 || IC50 <= 0) return Bottom;
    const a = Math.pow(x / EC50, Hill1);
    const b = Math.pow(x / IC50, Hill2);
    if (!isFinite(a) || !isFinite(b)) return Bottom;
    return Bottom + (Top - Bottom) * (a / (1 + a)) * (1 / (1 + b));
  };
}

function evalAt(params, xs) {
  const f = bellModel(params);
  return xs.map(f);
}

function paramsObj(arr) {
  return Object.fromEntries(PARAM_NAMES.map((k, i) => [k, arr[i]]));
}

function naParams() {
  return Object.fromEntries(PARAM_NAMES.map(k => [k, NaN]));
}

// Deterministic PRNG so repeat fits on the same data give identical results.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample one random starting point inside the bounds.
// Param order: [Bottom, Top, EC50, IC50, Hill1, Hill2].
// EC50 and IC50 are log-uniform (orders of magnitude); others are uniform.
function randomStart(minVals, maxVals, rng) {
  const u = (lo, hi) => lo + rng() * (hi - lo);
  const logU = (lo, hi) => Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo)));
  const start = [
    u(minVals[0], maxVals[0]),
    u(minVals[1], maxVals[1]),
    logU(minVals[2], maxVals[2]),
    logU(minVals[3], maxVals[3]),
    u(minVals[4], maxVals[4]),
    u(minVals[5], maxVals[5]),
  ];
  // Geometrically valid bell needs IC50 > EC50; nudge if random sample violated it.
  if (start[3] <= start[2]) start[3] = start[2] * 1.05;
  return start;
}

// Resolve user-provided options into concrete (min, max) pairs for each parameter.
// `options` shape:
//   { hill1: {min, max, unconstrained}, hill2: {...},
//     ec50:  {min, max, unconstrained}, ic50:  {...} }
// Any field can be missing/blank → fall back to data-derived or biological defaults.
function resolveBounds(options, xMin, xMax, yMinScaled) {
  const opts = options || {};
  const h1 = opts.hill1 || {};
  const h2 = opts.hill2 || {};
  const ec = opts.ec50 || {};
  const ic = opts.ic50 || {};

  const num = (v) => Number.isFinite(v) ? v : null;

  // Hill1
  const hill1Min = h1.unconstrained ? UNCONSTRAINED_HILL_MIN : (num(h1.min) ?? DEFAULT_HILL_MIN);
  const hill1Max = h1.unconstrained ? UNCONSTRAINED_HILL_MAX : (num(h1.max) ?? DEFAULT_HILL_MAX);

  // Hill2
  const hill2Min = h2.unconstrained ? UNCONSTRAINED_HILL_MIN : (num(h2.min) ?? DEFAULT_HILL_MIN);
  const hill2Max = h2.unconstrained ? UNCONSTRAINED_HILL_MAX : (num(h2.max) ?? DEFAULT_HILL_MAX);

  // EC50 — defaults derived from data range.
  const defaultEc50Min = xMin / DEFAULT_CONC_FACTOR_BELOW;
  const defaultEc50Max = xMax * DEFAULT_CONC_FACTOR_ABOVE;
  const ec50Min = ec.unconstrained ? UNCONSTRAINED_CONC_MIN : (num(ec.min) ?? defaultEc50Min);
  const ec50Max = ec.unconstrained ? UNCONSTRAINED_CONC_MAX : (num(ec.max) ?? defaultEc50Max);

  // IC50 — same default scheme as EC50.
  const ic50Min = ic.unconstrained ? UNCONSTRAINED_CONC_MIN : (num(ic.min) ?? defaultEc50Min);
  const ic50Max = ic.unconstrained ? UNCONSTRAINED_CONC_MAX : (num(ic.max) ?? defaultEc50Max);

  // Bottom and Top stay data-derived (not user-editable per Round 4 scope).
  const bottomMin = 0;
  const bottomMax = yMinScaled + 1;
  const topMin = yMinScaled;
  const topMax = 30;

  // Per-parameter unconstrained flags, aligned with PARAM_NAMES order
  // [Bottom, Top, EC50, IC50, Hill1, Hill2]. Bottom/Top are not user-editable.
  const unconstrainedMask = [
    false,
    false,
    !!ec.unconstrained,
    !!ic.unconstrained,
    !!h1.unconstrained,
    !!h2.unconstrained,
  ];

  return {
    minValues: [bottomMin, topMin, ec50Min, ic50Min, hill1Min, hill2Min],
    maxValues: [bottomMax, topMax, ec50Max, ic50Max, hill1Max, hill2Max],
    unconstrainedMask,
  };
}

export function fitSample(xRaw, yRaw, options) {
  const pts = [];
  for (let i = 0; i < xRaw.length; i++) {
    const xi = xRaw[i], yi = yRaw[i];
    if (Number.isFinite(xi) && Number.isFinite(yi) && xi > 0) pts.push([xi, yi]);
  }
  if (pts.length < 6) {
    return {
      params: naParams(),
      xpeak: NaN,
      r2: NaN,
      converged: false,
      constraintOk: false,
      errors: naParams(),
      reason: `Need at least 6 valid data points (have ${pts.length}).`,
      nPoints: pts.length,
      boundaryHits: [],
    };
  }

  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  // For peak heuristic, group by X and use mean Y at each X (works for replicates).
  const meansByX = new Map();
  for (let i = 0; i < xs.length; i++) {
    const arr = meansByX.get(xs[i]) || [];
    arr.push(ys[i]);
    meansByX.set(xs[i], arr);
  }
  let peakX = xs[0], dataPeakY = -Infinity;
  for (const [x, arr] of meansByX) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (m > dataPeakY) { dataPeakY = m; peakX = x; }
  }

  const yScale = yMax > 0 ? yMax : 1;
  const ysScaled = ys.map(v => v / yScale);
  const yMinScaled = yMin / yScale;

  const { minValues, maxValues, unconstrainedMask } = resolveBounds(options, xMin, xMax, yMinScaled);

  // Heuristic start (clamped to user bounds so we never propose out-of-range values).
  const heuristicEC50 = clamp1(Math.max(0.3 * peakX, xMin / 10), minValues[2], maxValues[2]);
  let heuristicIC50 = clamp1(Math.max(3 * peakX, xMin * 1.5), minValues[3], maxValues[3]);
  if (heuristicIC50 <= heuristicEC50) heuristicIC50 = Math.min(heuristicEC50 * 3, maxValues[3]);
  const heuristicStart = [
    Math.max(0, yMinScaled),
    clamp1(2.5, minValues[1], maxValues[1]),
    heuristicEC50,
    heuristicIC50,
    clamp1(1, minValues[4], maxValues[4]),
    clamp1(1, minValues[5], maxValues[5]),
  ];

  // Multi-start: heuristic guess + (N-1) random starts. Keep best by parameterError.
  const data = { x: xs, y: ysScaled };
  const lmOpts = {
    damping: 1e-2,
    minValues,
    maxValues,
    maxIterations: 800,
    errorTolerance: 1e-10,
    gradientDifference: 1e-5,
  };
  const rng = mulberry32(PRNG_SEED);
  const candidates = [];
  let lastError = '';
  for (let attempt = 0; attempt < N_STARTS; attempt++) {
    const start = attempt === 0
      ? heuristicStart
      : clampToBounds(randomStart(minValues, maxValues, rng), minValues, maxValues);
    try {
      const res = LM(data, bellModel, { ...lmOpts, initialValues: start });
      if (res && Array.isArray(res.parameterValues) && Number.isFinite(res.parameterError)) {
        candidates.push(res);
      }
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  let result;
  let converged = true;
  let reason = '';
  if (candidates.length === 0) {
    converged = false;
    reason = lastError || 'All optimizer starts failed.';
    result = { parameterValues: heuristicStart };
  } else {
    candidates.sort((a, b) => a.parameterError - b.parameterError);
    result = candidates[0];
  }

  // Unscale Bottom and Top back to original Y units; EC50, IC50, Hill1, Hill2 unchanged.
  const fitted = result.parameterValues.slice();
  fitted[0] = fitted[0] * yScale;
  fitted[1] = fitted[1] * yScale;

  const yhat = evalAt(fitted, xs);
  const ssRes = ys.reduce((s, yi, i) => s + (yi - yhat[i]) ** 2, 0);
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;

  const { xpeak, peakY, halfY, apparentEC50, apparentIC50 } = peakAndApparentMidpoints(fitted, xMin, xMax);
  const boundaryHits = detectBoundaryHits(result.parameterValues, minValues, maxValues, unconstrainedMask);
  const params = paramsObj(fitted);
  const constraintOk = params.IC50 > params.EC50;
  const errors = computeStandardErrors(fitted, xs, ys);

  // Width is computed from apparent midpoints (half-peak crossings of the
  // fitted curve), not the raw model EC50/IC50. The product-of-sigmoids model
  // has a parameter degeneracy where the optimizer can land in a regime where
  // model EC50 and IC50 swap roles and Top inflates to compensate; the curve
  // still fits but the model labels stop matching the visible rise/fall
  // midpoints. Apparent values come straight off the curve so they always
  // satisfy apparentIC50 > apparentEC50.
  const widthLinear = Number.isFinite(apparentIC50) && Number.isFinite(apparentEC50) ? apparentIC50 - apparentEC50 : NaN;
  const widthFold = Number.isFinite(apparentIC50) && Number.isFinite(apparentEC50) && apparentEC50 > 0 ? apparentIC50 / apparentEC50 : NaN;

  // Top wildly above the data peak is the smoking gun for the degenerate regime.
  const topInflated = Number.isFinite(params.Top) && Number.isFinite(peakY) && peakY > 0 && params.Top > 2 * peakY;

  return {
    params,
    xpeak,
    peakY,
    halfY,
    apparentEC50,
    apparentIC50,
    widthLinear,
    widthFold,
    r2,
    converged: converged && Number.isFinite(r2),
    constraintOk,
    topInflated,
    errors,
    reason,
    boundaryHits,
    iterations: result && result.iterations,
    nPoints: pts.length,
    nStartsTried: candidates.length,
  };
}

function clamp1(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function clampToBounds(p, lo, hi) {
  return p.map((v, i) => Math.min(Math.max(v, lo[i]), hi[i]));
}

function detectBoundaryHits(params, minVals, maxVals, unconstrainedMask) {
  // Param order: [Bottom, Top, EC50, IC50, Hill1, Hill2].
  // EC50 and IC50 have log-spread bounds — use log-space tolerance so a small
  // EC50 isn't falsely flagged near the (very small) lower bound.
  // Parameters the user explicitly marked Unconstrained are skipped — the
  // wide bounds we pass to the optimizer in that case are an internal
  // implementation detail; hitting them isn't a constraint the user cares about.
  // Bottom and Top are skipped too: they're not user-editable, so a flag on
  // them is purely noise — degenerate Top fits are surfaced via the huge
  // standard errors instead, which is the meaningful diagnostic.
  const labelByIdx = ['Bottom', 'Top', 'EC50', 'IC50', 'Hill1', 'Hill2'];
  const useLogTol = [false, false, true, true, false, false];
  const skipAlways = [true, true, false, false, false, false];
  const hits = [];
  for (let i = 0; i < params.length; i++) {
    if (skipAlways[i]) continue;
    if (unconstrainedMask && unconstrainedMask[i]) continue;
    const v = params[i], lo = minVals[i], hi = maxVals[i];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;
    let atLo, atHi;
    if (useLogTol[i] && lo > 0 && v > 0) {
      const logSpan = Math.log(hi) - Math.log(lo);
      const logTol = logSpan * 1e-3;
      atLo = (Math.log(v) - Math.log(lo)) < logTol;
      atHi = (Math.log(hi) - Math.log(v)) < logTol;
    } else {
      const tol = (hi - lo) * 1e-3 + 1e-9;
      atLo = Math.abs(v - lo) < tol;
      atHi = Math.abs(v - hi) < tol;
    }
    if (atLo || atHi) hits.push(labelByIdx[i]);
  }
  return hits;
}

// Sample the fitted curve on a log grid spanning ~2 decades beyond the data.
// Returns:
//   xpeak       — concentration of curve maximum
//   peakY       — fitted Y at xpeak
//   halfY       — Bottom + (peakY - Bottom) / 2  (the half-peak threshold)
//   apparentEC50 — x where the rising arm of the fitted curve crosses halfY
//   apparentIC50 — x where the falling arm of the fitted curve crosses halfY
// "Apparent" values are read directly off the fitted curve and are always
// well-defined regardless of which regime the optimizer landed in. They can
// disagree with raw model EC50/IC50 when Top is degenerate.
function peakAndApparentMidpoints(params, xMin, xMax) {
  const N = 5000;
  const lo = Math.log(Math.max(xMin / 100, 1e-12));
  const hi = Math.log(xMax * 100);
  const f = bellModel(params);
  const xs = new Array(N);
  const ys = new Array(N);
  let peakIdx = 0, peakY = -Infinity;
  for (let i = 0; i < N; i++) {
    const xv = Math.exp(lo + (hi - lo) * (i / (N - 1)));
    const yv = f(xv);
    xs[i] = xv;
    ys[i] = yv;
    if (Number.isFinite(yv) && yv > peakY) { peakY = yv; peakIdx = i; }
  }
  const xpeak = xs[peakIdx];
  const Bottom = params[0];
  const halfY = Bottom + (peakY - Bottom) / 2;

  // Rising arm: walk left from peak, find first interval bracketing halfY.
  let apparentEC50 = NaN;
  for (let i = peakIdx; i > 0; i--) {
    if (ys[i] >= halfY && ys[i - 1] < halfY) {
      const t = (halfY - ys[i - 1]) / (ys[i] - ys[i - 1]);
      apparentEC50 = Math.exp(Math.log(xs[i - 1]) + t * (Math.log(xs[i]) - Math.log(xs[i - 1])));
      break;
    }
  }
  // Falling arm: walk right from peak.
  let apparentIC50 = NaN;
  for (let i = peakIdx; i < N - 1; i++) {
    if (ys[i] >= halfY && ys[i + 1] < halfY) {
      const t = (ys[i] - halfY) / (ys[i] - ys[i + 1]);
      apparentIC50 = Math.exp(Math.log(xs[i]) + t * (Math.log(xs[i + 1]) - Math.log(xs[i])));
      break;
    }
  }
  return { xpeak, peakY, halfY, apparentEC50, apparentIC50 };
}

function computeStandardErrors(params, xs, ys) {
  const n = xs.length;
  const p = params.length;
  if (n <= p) return naParams();
  const J = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(p);
    for (let j = 0; j < p; j++) {
      const h = Math.max(Math.abs(params[j]) * 1e-6, 1e-8);
      const pPlus = params.slice(); pPlus[j] += h;
      const pMinus = params.slice(); pMinus[j] -= h;
      const fp = bellModel(pPlus)(xs[i]);
      const fm = bellModel(pMinus)(xs[i]);
      row[j] = (fp - fm) / (2 * h);
    }
    J.push(row);
  }
  const JtJ = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < p; k++) {
        JtJ[j][k] += J[i][j] * J[i][k];
      }
    }
  }
  for (let j = 0; j < p; j++) JtJ[j][j] += 1e-12;
  const inv = matInverse(JtJ);
  if (!inv) return naParams();
  const yhat = evalAt(params, xs);
  const ssRes = ys.reduce((s, yi, i) => s + (yi - yhat[i]) ** 2, 0);
  const sigma2 = ssRes / (n - p);
  const errs = {};
  PARAM_NAMES.forEach((k, j) => {
    const v = sigma2 * inv[j][j];
    errs[k] = v > 0 && Number.isFinite(v) ? Math.sqrt(v) : NaN;
  });
  return errs;
}

function matInverse(M) {
  const n = M.length;
  const a = M.map((row, i) => row.slice().concat(Array.from({ length: n }, (_, j) => i === j ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    }
    if (Math.abs(a[pivot][i]) < 1e-18) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i];
    for (let j = 0; j < 2 * n; j++) a[i][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = a[r][i];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[i][j];
    }
  }
  return a.map(row => row.slice(n));
}

export function evalCurve(params, xs) {
  return evalAt([params.Bottom, params.Top, params.EC50, params.IC50, params.Hill1, params.Hill2], xs);
}
