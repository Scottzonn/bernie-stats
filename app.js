import { parseXlsx, exportCsv } from './io.js';
import { fitSample } from './fit.js';
import { plotPerSample, plotOverlay, paletteFor, computeSharedRange } from './plots.js';

const dropZone = document.getElementById('drop');
const fileInput = document.getElementById('file');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) handleFile(f);
  fileInput.value = '';
});

// Toggle universal vs per-plot autoscale. Re-renders per-sample plots only
// (the overlay plot keeps its own autoscale).
document.getElementById('universal-scale')?.addEventListener('change', () => {
  if (!lastResults || !lastResults.length || !window.Plotly) return;
  const shared = document.getElementById('universal-scale').checked
    ? computeSharedRange(lastResults)
    : null;
  lastResults.forEach((r, i) => {
    const div = document.getElementById(`plot-${i}`);
    if (!div) return;
    const layoutUpdate = shared && shared.xLogRange && shared.yRange
      ? { 'xaxis.range': shared.xLogRange.slice(), 'yaxis.range': shared.yRange.slice(),
          'xaxis.autorange': false, 'yaxis.autorange': false }
      : { 'xaxis.autorange': true, 'yaxis.autorange': true,
          'xaxis.range': null, 'yaxis.range': null };
    try { window.Plotly.relayout(div, layoutUpdate); } catch (_) {}
  });
});

let lastResults = null;
let resizeObserver = null;

async function handleFile(file) {
  hideError();
  try {
    const { x, samples } = await parseXlsx(file);
    showPreview(x, samples);
    document.getElementById('info').classList.remove('hidden');

    const results = samples.map((s) => {
      const xFlat = [], yFlat = [];
      for (const rep of s.replicates) {
        for (let i = 0; i < x.length; i++) {
          const xi = x[i], yi = rep[i];
          if (Number.isFinite(xi) && xi > 0 && Number.isFinite(yi)) {
            xFlat.push(xi);
            yFlat.push(yi);
          }
        }
      }
      return {
        name: s.name,
        x,
        replicates: s.replicates,
        fit: fitSample(xFlat, yFlat),
      };
    });
    lastResults = results;
    renderResults(results);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    console.error(err);
  }
}

function showPreview(x, samples) {
  const wrap = document.getElementById('preview-table');
  let html = '<table><thead><tr><th>Conc (nM)</th>';
  samples.forEach((s) => {
    s.replicates.forEach((_, ri) => {
      const label = s.replicates.length > 1 ? `${s.name} (rep ${ri + 1})` : s.name;
      html += `<th>${esc(label)}</th>`;
    });
  });
  html += '</tr></thead><tbody>';
  x.forEach((xi, i) => {
    html += `<tr><td>${xi}</td>`;
    samples.forEach((s) => {
      s.replicates.forEach((rep) => {
        const v = rep[i];
        html += `<td>${Number.isFinite(v) ? v : ''}</td>`;
      });
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  document.getElementById('preview').classList.remove('hidden');
}

function renderResults(results) {
  const ptable = document.getElementById('params-table');
  const cols = [
    'Sample', 'N pts', 'Xpeak (nM)', 'Width (nM)', 'Width (fold)',
    'Bottom', 'Top', 'EC50 (apparent)', 'IC50 (apparent)',
    'Hill1', 'Hill2', 'R²', 'Conv?', 'At bound',
  ];
  let html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach((c) => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';
  results.forEach((r) => {
    const f = r.fit;
    const boundaryHits = f.boundaryHits || [];
    const flagged = !f.converged || boundaryHits.length > 0 || !(f.r2 > 0.8);
    const tip = flagged
      ? ` title="Flagged: ${[
          !f.converged ? 'did not converge' : null,
          boundaryHits.length > 0 ? `parameter(s) at bound: ${boundaryHits.join(', ')}` : null,
          !(f.r2 > 0.8) ? `low R² (${fmtR2(f.r2)})` : null,
        ].filter(Boolean).join('; ')}"`
      : '';
    const nReps = (r.replicates || []).length;
    const nPtsCell = `${f.nPoints != null ? f.nPoints : '—'}` + (nReps > 1 ? ` <span style="color:#888">(${nReps} reps)</span>` : '');
    html += `<tr class="${flagged ? 'flagged' : ''}"${tip}>`;
    html += `<td>${esc(r.name)}</td>`;
    html += `<td>${nPtsCell}</td>`;
    html += `<td><strong>${fmt(f.xpeak)}</strong></td>`;
    html += `<td>${fmt(f.widthLinear)}</td>`;
    html += `<td>${fmtFold(f.widthFold)}</td>`;
    html += `<td>${withSE(f.params.Bottom, f.errors && f.errors.Bottom)}</td>`;
    html += `<td>${withSE(f.params.Top, f.errors && f.errors.Top)}</td>`;
    html += `<td>${withSE(f.params.EC50, f.errors && f.errors.EC50)}</td>`;
    html += `<td>${withSE(f.params.IC50, f.errors && f.errors.IC50)}</td>`;
    html += `<td>${withSE(f.params.Hill1, f.errors && f.errors.Hill1)}</td>`;
    html += `<td>${withSE(f.params.Hill2, f.errors && f.errors.Hill2)}</td>`;
    html += `<td>${fmtR2(f.r2)}</td>`;
    html += `<td>${f.converged ? '✓' : '✗'}</td>`;
    html += `<td>${boundaryHits.length === 0 ? '—' : '<span style="color:#c00">' + esc(boundaryHits.join(', ')) + '</span>'}</td>`;
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  ptable.innerHTML = html;

  // Reveal the results section BEFORE creating any plots so the chart
  // containers have real dimensions when Plotly measures them.
  document.getElementById('results').classList.remove('hidden');

  const grid = document.getElementById('per-sample-plots');
  grid.innerHTML = '';

  // Tear down any prior ResizeObserver and rebuild it for this batch.
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      if (window.Plotly && e.target.isConnected) {
        try { window.Plotly.Plots.resize(e.target); } catch (_) {}
      }
    }
  });

  // Defer plot creation until after the browser has laid out the grid (the
  // grid uses auto-fit/minmax which needs the container's width settled).
  // Two animation frames is the safest bet — the first frame the layout
  // happens, the second frame we render into known-good dimensions.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const useUniversal = document.getElementById('universal-scale')?.checked;
    const shared = useUniversal ? computeSharedRange(results) : null;

    results.forEach((r, i) => {
      const cell = document.createElement('div');
      cell.className = 'plot-cell';

      const plotDiv = document.createElement('div');
      plotDiv.id = `plot-${i}`;
      plotDiv.className = 'plot-target';
      cell.appendChild(plotDiv);

      const eqDiv = document.createElement('div');
      eqDiv.className = 'equation';
      eqDiv.innerHTML = formatEquation(r.fit.params);
      cell.appendChild(eqDiv);

      grid.appendChild(cell);
      plotPerSample(plotDiv.id, r, paletteFor(i), shared);
      resizeObserver.observe(plotDiv);
    });
    plotOverlay('overlay-plot', results);
    const overlay = document.getElementById('overlay-plot');
    if (overlay) resizeObserver.observe(overlay);
  }));

  document.getElementById('download-csv').onclick = () => {
    const csv = exportCsv(lastResults || results);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fit_results.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e5 || abs < 1e-3) return v.toExponential(3);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(3);
  return v.toPrecision(3);
}

function withSE(value, se) {
  const v = fmt(value);
  if (!Number.isFinite(se)) return v;
  return `${v} <span style="color:#888">±${fmt(se)}</span>`;
}

function fmtFold(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 100) return `${v.toFixed(0)}×`;
  if (v >= 10) return `${v.toFixed(1)}×`;
  return `${v.toFixed(2)}×`;
}

// Number format optimised for inline equation text (avoid scientific where
// possible because it makes formulas hard to read).
function fmtEq(v) {
  if (!Number.isFinite(v)) return 'NaN';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e7) return v.toExponential(2);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
}

function formatEquation(p) {
  if (!p || !Number.isFinite(p.Top) || !Number.isFinite(p.Bottom) ||
      !Number.isFinite(p.EC50) || !Number.isFinite(p.IC50) ||
      !Number.isFinite(p.Hill1) || !Number.isFinite(p.Hill2)) {
    return '<span class="eq-line" style="color:#999">(no equation — fit failed)</span>';
  }
  const amp = p.Top - p.Bottom;
  const ampSign = amp >= 0 ? '+' : '−';
  const ampAbs = fmtEq(Math.abs(amp));
  const ec = fmtEq(p.EC50);
  const ic = fmtEq(p.IC50);
  const h1 = fmtEq(p.Hill1);
  const h2 = fmtEq(p.Hill2);
  // Y(X) = Bottom + (Top−Bottom) · [(X/EC50)^H1 / (1 + (X/EC50)^H1)] · [1 / (1 + (X/IC50)^H2)]
  return (
    `<span class="eq-line"><span class="eq-y">Y(X)</span> = ${fmtEq(p.Bottom)} ${ampSign} ${ampAbs} ·</span>` +
    `<span class="eq-line">&nbsp;&nbsp;[ (X / ${ec})<sup>${h1}</sup> / (1 + (X / ${ec})<sup>${h1}</sup>) ] ·</span>` +
    `<span class="eq-line">&nbsp;&nbsp;[ 1 / (1 + (X / ${ic})<sup>${h2}</sup>) ]</span>`
  );
}

// Format R² without ever rounding up to 1.0000. If the value is < 1 but would
// round to 1 at 4 decimals, show as "1 − Xe-N" so the user can see the gap.
function fmtR2(r) {
  if (!Number.isFinite(r)) return '—';
  if (r === 1) return '1.0000';
  if (r > 1) return r.toFixed(4); // shouldn't happen, but render safely
  if (r < 0) return r.toFixed(4); // negative R² means fit worse than constant mean
  const oneMinus = 1 - r;
  if (oneMinus < 5e-5) {
    // Would round to 1.0000 — show the residual gap instead.
    return `1 − ${oneMinus.toExponential(2)}`;
  }
  if (oneMinus < 5e-4) {
    // 0.9995–0.99995 → show 4 decimals (truncated, never rounded up).
    return (Math.floor(r * 10000) / 10000).toFixed(4);
  }
  // Otherwise 3 decimals, truncated so we never display a value above the actual R².
  return (Math.floor(r * 1000) / 1000).toFixed(3);
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() {
  document.getElementById('error').classList.add('hidden');
}
