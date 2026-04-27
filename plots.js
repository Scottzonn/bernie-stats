import { evalCurve } from './fit.js';

const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#17becf',
];

// Lines drawn at apparent EC50 and IC50 use a fixed pair so they read the
// same on every plot regardless of the sample's data colour.
const EC50_LINE_COLOR = '#2ca02c'; // green — rising side
const IC50_LINE_COLOR = '#d62728'; // red   — falling side

function logSpacedRange(xMin, xMax, n) {
  const lo = Math.log(Math.max(xMin / 3, 1e-12));
  const hi = Math.log(xMax * 3);
  return Array.from({ length: n }, (_, i) => Math.exp(lo + (hi - lo) * (i / (n - 1))));
}

// Build a Plotly log-axis config with explicit decade ticks rendered as plain
// decimals (0.01, 0.1, 1, 10, 100…) instead of "1e-2" etc. xLogRange is the
// optional shared visible range in log10 units; otherwise tick range is
// derived from xMin/xMax in linear units.
function logXAxisConfig(xMin, xMax, xLogRange) {
  const log10Min = xLogRange ? xLogRange[0] : Math.log10(xMin / 3);
  const log10Max = xLogRange ? xLogRange[1] : Math.log10(xMax * 3);
  const decadeLo = Math.floor(log10Min);
  const decadeHi = Math.ceil(log10Max);
  const tickvals = [];
  const ticktext = [];
  for (let k = decadeLo; k <= decadeHi; k++) {
    const v = Math.pow(10, k);
    tickvals.push(v);
    ticktext.push(formatTick(v));
  }
  return {
    type: 'log',
    title: { text: 'Concentration (nM)' },
    tickmode: 'array',
    tickvals,
    ticktext,
    ticks: 'outside',
    minor: { ticks: 'outside', ticklen: 3, tickcolor: '#bbb' },
    showgrid: true,
    gridcolor: '#eee',
  };
}

// Format a positive number for axis ticks: keep things short and avoid
// scientific notation across the typical assay range (1e-3 .. 1e6 nM).
function formatTick(v) {
  if (!(v > 0)) return String(v);
  if (v >= 1) return v >= 10000 ? v.toExponential(0) : String(v);
  // 0.001, 0.01, 0.1
  return v.toString();
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
  const dataHover = '<b>%{x:~r} nM</b><br>Signal: %{y:.0f}<extra></extra>';
  const traces = [
    {
      x: xs, y: ys,
      mode: 'markers',
      type: 'scatter',
      name: nReps > 1 ? `Data (${nReps} reps)` : 'Data',
      marker: { size: 9, color, opacity: nReps > 1 ? 0.7 : 1 },
      hovertemplate: dataHover,
    },
    {
      x: xCurve, y: yCurve,
      mode: 'lines',
      type: 'scatter',
      name: 'Fit',
      line: { width: 2, color },
      hovertemplate: dataHover,
    },
  ];
  if (Number.isFinite(fit.xpeak)) {
    const yPeak = evalCurve(fit.params, [fit.xpeak])[0];
    traces.push({
      x: [fit.xpeak], y: [yPeak],
      mode: 'markers',
      type: 'scatter',
      name: `Xpeak ≈ ${formatConc(fit.xpeak)} nM`,
      marker: { size: 14, symbol: 'x', color: '#000', line: { width: 2 } },
      hovertemplate: '<b>Xpeak %{x:~r} nM</b><br>Signal: %{y:.0f}<extra></extra>',
    });
  }

  // Vertical lines at apparent EC50 / IC50 (half-peak crossings of the fitted
  // curve). Drawn from the plot's bottom (Bottom param or 0) up through the
  // fitted peak so they intercept the x-axis without inflating the y-axis.
  const lineYBase = Number.isFinite(fit.params && fit.params.Bottom) ? fit.params.Bottom : 0;
  const lineYTop = Number.isFinite(fit.peakY) ? fit.peakY : Math.max(...ys);
  if (Number.isFinite(fit.apparentEC50)) {
    traces.push({
      x: [fit.apparentEC50, fit.apparentEC50],
      y: [lineYBase, lineYTop],
      mode: 'lines',
      type: 'scatter',
      name: `EC50 (apparent) ≈ ${formatConc(fit.apparentEC50)} nM`,
      line: { color: EC50_LINE_COLOR, width: 2, dash: 'dash' },
      hovertemplate: `<b>EC50 (apparent)</b><br>%{x:~r} nM<extra></extra>`,
    });
  }
  if (Number.isFinite(fit.apparentIC50)) {
    traces.push({
      x: [fit.apparentIC50, fit.apparentIC50],
      y: [lineYBase, lineYTop],
      mode: 'lines',
      type: 'scatter',
      name: `IC50 (apparent) ≈ ${formatConc(fit.apparentIC50)} nM`,
      line: { color: IC50_LINE_COLOR, width: 2, dash: 'dash' },
      hovertemplate: `<b>IC50 (apparent)</b><br>%{x:~r} nM<extra></extra>`,
    });
  }

  // sharedRange = null  → autoscale per plot.
  // sharedRange = { xLogRange:[a,b], yRange:[a,b] } → fixed axes for cross-plot comparison.
  const xaxis = logXAxisConfig(xMin, xMax, sharedRange && sharedRange.xLogRange);
  const yaxis = { title: { text: 'Signal' } };
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
    margin: { t: 40, l: 64, r: 16, b: 60 },
    legend: { orientation: 'h', y: -0.25 },
    showlegend: true,
    hovermode: 'closest',
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
    const hover = `<b>${esc(r.name)}</b><br>%{x:~r} nM<br>Signal: %{y:.0f}<extra></extra>`;
    traces.push({
      x: xs, y: ys,
      mode: 'markers',
      type: 'scatter',
      name: r.name,
      legendgroup: r.name,
      marker: { size: 8, color, opacity: 0.7 },
      hovertemplate: hover,
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
      hovertemplate: hover,
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
        hovertemplate: `<b>${esc(r.name)} — Xpeak</b><br>%{x:~r} nM<br>Signal: %{y:.0f}<extra></extra>`,
      });
    }
  });

  Plotly.newPlot(divId, traces, {
    title: { text: 'All samples (Xpeak marked with ✕)', font: { size: 15 } },
    xaxis: logXAxisConfig(xMin, xMax),
    yaxis: { title: { text: 'Signal' } },
    margin: { t: 50, l: 64, r: 16, b: 60 },
    hovermode: 'closest',
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

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
