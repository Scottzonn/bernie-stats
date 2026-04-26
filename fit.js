import { levenbergMarquardt as LM } from 'https://esm.sh/ml-levenberg-marquardt@4.1.3';

export const PARAM_NAMES = ['Bottom', 'Top', 'EC50', 'IC50', 'Hill1', 'Hill2'];

const N_STARTS = 10;
const PRNG_SEED = 0x42424242;

function bellModel([Bottom, Top, EC50, IC50, Hill1, Hill2]) {
  return (x) => {
    if (!(x > 0) || EC50 <= 0 || IC50 <= 0) return Bottom;
    const a = Math.pow(x / EC50, Hill1);
    const b = Math.pow(x / IC50, Hill2);
    if (!isFinite(a) || !isFinite(b)) return Bottom;
    return Bottom + (Top - Bottom) * (a / (1 + a)) * (1 / (1 + b));
  };
}

function bellModelInternal(intParams) {
  const [Bottom, Top, EC50, logRatio, Hill1, Hill2] = intParams;
  const IC50 = EC50 * Math.exp(logRatio);
  return bellModel([Bottom, Top, EC50, IC50, Hill1, Hill2]);
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
// Internal param order: [Bottom, Top, EC50, logRatio, Hill1, Hill2].
// EC50 is log-uniform (orders of magnitude); others are uniform.
function randomStart(minVals, maxVals, rng) {
  const u = (lo, hi) => lo + rng() * (hi - lo);
  const logU = (lo, hi) => Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo)));
  return [
    u(minVals[0], maxVals[0]),
    u(minVals[1], maxVals[1]),
    logU(minVals[2], maxVals[2]),
    u(minVals[3], maxVals[3]),
    u(minVals[4], maxVals[4]),
    u(minVals[5], maxVals[5]),
  ];
}

export function fitSample(xRaw, yRaw) {
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
  let peakX = xs[0], peakY = -Infinity;
  for (const [x, arr] of meansByX) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (m > peakY) { peakY = m; peakX = x; }
  }

  const yScale = yMax > 0 ? yMax : 1;
  const ysScaled = ys.map(v => v / yScale);
  const yMinScaled = yMin / yScale;

  const heuristicEC50 = Math.max(0.3 * peakX, xMin / 10);
  const heuristicIC50 = Math.max(3 * peakX, xMin * 1.5);
  const heuristicLogRatio = Math.max(Math.log(heuristicIC50 / heuristicEC50), Math.log(1.5));

  const heuristicStart = [
    Math.max(0, yMinScaled),
    2.5,
    heuristicEC50,
    heuristicLogRatio,
    1,
    1,
  ];
  const minValues = [
    0,
    yMinScaled,
    xMin / 100,
    Math.log(1.05),
    0.5,
    0.5,
  ];
  const maxValues = [
    yMinScaled + 1,
    30,
    xMax * 100,
    Math.log(1000),
    4,
    4,
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
    const start = attempt === 0 ? heuristicStart : clampToBounds(randomStart(minValues, maxValues, rng), minValues, maxValues);
    try {
      const res = LM(data, bellModelInternal, { ...lmOpts, initialValues: start });
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

  const intScaled = result.parameterValues;
  const extScaled = [
    intScaled[0],
    intScaled[1],
    intScaled[2],
    intScaled[2] * Math.exp(intScaled[3]),
    intScaled[4],
    intScaled[5],
  ];
  const ext = extScaled.slice();
  ext[0] = extScaled[0] * yScale;
  ext[1] = extScaled[1] * yScale;

  const yhat = evalAt(ext, xs);
  const ssRes = ys.reduce((s, yi, i) => s + (yi - yhat[i]) ** 2, 0);
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;

  const xpeak = findPeak(ext, xMin, xMax);
  const boundaryHits = detectBoundaryHits(intScaled, minValues, maxValues);
  const params = paramsObj(ext);
  const constraintOk = params.IC50 > params.EC50;
  const errors = computeStandardErrors(ext, xs, ys);

  const widthLinear = Number.isFinite(params.IC50) && Number.isFinite(params.EC50) ? params.IC50 - params.EC50 : NaN;
  const widthFold = Number.isFinite(params.IC50) && Number.isFinite(params.EC50) && params.EC50 > 0 ? params.IC50 / params.EC50 : NaN;

  return {
    params,
    xpeak,
    widthLinear,
    widthFold,
    r2,
    converged: converged && Number.isFinite(r2),
    constraintOk,
    errors,
    reason,
    boundaryHits,
    iterations: result && result.iterations,
    nPoints: pts.length,
    nStartsTried: candidates.length,
  };
}


function clampToBounds(p, lo, hi) {
  return p.map((v, i) => Math.min(Math.max(v, lo[i]), hi[i]));
}

function detectBoundaryHits(intParams, minVals, maxVals) {
  // Internal order: [Bottom, Top, EC50, logRatio, Hill1, Hill2].
  // EC50 has log-decade bounds → use log-space tolerance.
  // logRatio is already a log-space parameter (= log(IC50/EC50)) with a
  // narrow linear range; use linear tolerance there.
  // Everyone else has a narrow linear range; use linear tolerance.
  // logRatio at bound is reported to the user as "IC50" (a tight ratio
  // means IC50 ≈ EC50; a wide ratio means IC50 ≫ all measured X).
  const labelByIdx = ['Bottom', 'Top', 'EC50', 'IC50', 'Hill1', 'Hill2'];
  const useLogTol = [false, false, true, false, false, false];
  const hits = [];
  for (let i = 0; i < intParams.length; i++) {
    const v = intParams[i], lo = minVals[i], hi = maxVals[i];
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

function findPeak(params, xMin, xMax) {
  const N = 5000;
  const lo = Math.log(Math.max(xMin / 10, 1e-12));
  const hi = Math.log(xMax * 10);
  const f = bellModel(params);
  let bestX = NaN, bestY = -Infinity;
  for (let i = 0; i < N; i++) {
    const xv = Math.exp(lo + (hi - lo) * (i / (N - 1)));
    const yv = f(xv);
    if (Number.isFinite(yv) && yv > bestY) { bestY = yv; bestX = xv; }
  }
  return bestX;
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
