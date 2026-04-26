import { evalCurve } from './fit.js';

const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#17becf',
];

function logSpacedRange(xMin, xMax, n) {
  const lo = Math.log(Math.max(xMin / 3, 1e-12));
  const hi = Math.log(xMax * 3);
  return Array.from({ length: n }, (_, i) => Math.exp(lo + (hi - lo) * (i / (n - 1))));
}

// Flatten a sample's replicates into parallel x/y arrays of all individual data points.
function allPointsFor(result) {
  const xs = [], ys = [];
  const reps = result.replicates || [];
  for (const rep of reps) {
    for (let i = 0; i < result.x.length; i++) {
      const xi = result.x[i], yi = rep[i];
      if (Number.isFinite(xi) && xi > 0 && Number.isFinite(yi)) {
        xs.push(xi);
        ys.push(yi);
      }
    }
  }
  return { xs, ys };
}

export function plotPerSample(divId, result, color, sharedRange) {
  const Plotly = window.Plotly;
  const { name, x, fit } = result;
  const { xs, ys } = allPointsFor(result);
  if (xs.length === 0) return;
  const xMin = Math.min(...x.filter(v => v > 0));
  const xMax = Math.max(...x);
  const xCurve = logSpacedRange(xMin, xMax, 300);
  const yCurve = evalCurve(fit.params, xCurve);

  const nReps = (result.replicates || []).length;
  const traces = [
    {
      x: xs, y: ys,
      mode: 'markers',
      type: 'scatter',
      name: nReps > 1 ? `Data (${nReps} reps)` : 'Data',
      marker: { size: 9, color, opacity: nReps > 1 ? 0.7 : 1 },
    },
    {
      x: xCurve, y: yCurve,
      mode: 'lines',
      type: 'scatter',
      name: 'Fit',
      line: { width: 2, color },
    },
  ];
  if (Number.isFinite(fit.xpeak)) {
    const yPeak = evalCurve(fit.params, [fit.xpeak])[0];
    traces.push({
      x: [fit.xpeak], y: [yPeak],
      mode: 'markers',
      type: 'scatter',
      name: `Xpeak ≈ ${formatConc(fit.xpeak)} nM`,
      marker: { size: 14, symbol: 'x', color: '#d62728', line: { width: 2 } },
    });
  }

  // sharedRange = null  → autoscale per plot.
  // sharedRange = { xLogRange:[a,b], yRange:[a,b] } → fixed axes for cross-plot comparison.
  const xaxis = { type: 'log', title: 'Concentration (nM)' };
  const yaxis = { title: 'Signal' };
  if (sharedRange && sharedRange.xLogRange && sharedRange.yRange) {
    xaxis.range = sharedRange.xLogRange.slice();
    yaxis.range = sharedRange.yRange.slice();
  } else {
    xaxis.autorange = true;
    yaxis.autorange = true;
  }

  Plotly.newPlot(divId, traces, {
    title: { text: name, font: { size: 14 } },
    xaxis,
    yaxis,
    margin: { t: 40, l: 64, r: 16, b: 50 },
    legend: { orientation: 'h', y: -0.2 },
    showlegend: true,
  }, { responsive: true, displaylogo: false });
}

// Compute a shared X (log) and Y range that comfortably covers every sample's
// data points and fitted curve. Returned object is the `sharedRange` argument
// expected by `plotPerSample`.
export function computeSharedRange(results) {
  const xs = [];
  const ys = [];
  for (const r of results) {
    const xPositive = r.x.filter(v => v > 0);
    if (xPositive.length === 0) continue;
    xs.push(...xPositive);
    for (const rep of (r.replicates || [])) {
      for (let i = 0; i < r.x.length; i++) {
        if (Number.isFinite(rep[i]) && r.x[i] > 0) ys.push(rep[i]);
      }
    }
    // Include the fitted curve sampled across the data range so the y-axis
    // covers the predicted peak even if data doesn't sit right on it.
    const xMin = Math.min(...xPositive), xMax = Math.max(...r.x);
    const sampleX = logSpacedRange(xMin, xMax, 50);
    const sampleY = evalCurve(r.fit.params, sampleX);
    for (const v of sampleY) if (Number.isFinite(v)) ys.push(v);
  }
  if (xs.length === 0 || ys.length === 0) return null;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  // Pad by ~30% on the X log scale and ~5% on Y for visual breathing room.
  const xLog = [Math.log10(xMin / 3), Math.log10(xMax * 3)];
  const ySpan = yMax - yMin;
  const yLo = Math.min(0, yMin - ySpan * 0.02);
  const yHi = yMax + ySpan * 0.05;
  return { xLogRange: xLog, yRange: [yLo, yHi] };
}

export function plotOverlay(divId, results) {
  const Plotly = window.Plotly;
  const allXPositive = results.flatMap(r => r.x.filter(v => v > 0));
  if (allXPositive.length === 0) return;
  const xMin = Math.min(...allXPositive);
  const xMax = Math.max(...results.flatMap(r => r.x));
  const xCurve = logSpacedRange(xMin, xMax, 300);

  const traces = [];
  results.forEach((r, i) => {
    const color = COLORS[i % COLORS.length];
    const { xs, ys } = allPointsFor(r);
    traces.push({
      x: xs, y: ys,
      mode: 'markers',
      type: 'scatter',
      name: r.name,
      legendgroup: r.name,
      marker: { size: 8, color, opacity: 0.7 },
    });
    const yCurve = evalCurve(r.fit.params, xCurve);
    traces.push({
      x: xCurve, y: yCurve,
      mode: 'lines',
      type: 'scatter',
      name: r.name,
      legendgroup: r.name,
      showlegend: false,
      line: { color, width: 2 },
    });
    if (Number.isFinite(r.fit.xpeak)) {
      const yPeak = evalCurve(r.fit.params, [r.fit.xpeak])[0];
      traces.push({
        x: [r.fit.xpeak], y: [yPeak],
        mode: 'markers',
        type: 'scatter',
        name: r.name,
        legendgroup: r.name,
        showlegend: false,
        marker: { size: 12, symbol: 'x', color },
      });
    }
  });

  Plotly.newPlot(divId, traces, {
    title: { text: 'All samples (Xpeak marked with ✕)', font: { size: 15 } },
    xaxis: { type: 'log', title: 'Concentration (nM)' },
    yaxis: { title: 'Signal' },
    margin: { t: 50, l: 64, r: 16, b: 50 },
  }, { responsive: true, displaylogo: false });
}

export function paletteFor(i) {
  return COLORS[i % COLORS.length];
}

function formatConc(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
