import { parseXlsx, exportCsv } from './io.js';
import {
  fitSample,
  DEFAULT_HILL_MIN, DEFAULT_HILL_MAX,
  UNCONSTRAINED_HILL_MIN, UNCONSTRAINED_HILL_MAX,
  UNCONSTRAINED_CONC_MIN, UNCONSTRAINED_CONC_MAX,
  DEFAULT_CONC_FACTOR_BELOW, DEFAULT_CONC_FACTOR_ABOVE,
} from './fit.js';
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
let lastInput = null; // { x, samples } from the last successful parse — used for re-fit.
let resizeObserver = null;

// ----- Advanced settings: form ↔ localStorage ↔ fit options -----

const STORAGE_PREFIX = 'bs.bounds.';
const PARAMS = ['hill1', 'hill2', 'ec50', 'ic50'];

function settingsRoot() { return document.getElementById('advanced-settings'); }

function eachInput(cb) {
  for (const param of PARAMS) {
    const row = settingsRoot().querySelector(`.bounds-row[data-param="${param}"]`);
    if (!row) continue;
    cb(param, {
      min: row.querySelector('input[data-bound="min"]'),
      max: row.querySelector('input[data-bound="max"]'),
      uncon: row.querySelector('input[data-bound="unconstrained"]'),
      err: row.querySelector('[data-error]'),
      row,
    });
  }
}

function loadSettingsToForm() {
  eachInput((param, els) => {
    const minVal = localStorage.getItem(STORAGE_PREFIX + param + '.min');
    const maxVal = localStorage.getItem(STORAGE_PREFIX + param + '.max');
    const uncon = localStorage.getItem(STORAGE_PREFIX + param + '.unconstrained') === '1';
    els.min.value = minVal != null ? minVal : '';
    els.max.value = maxVal != null ? maxVal : '';
    els.uncon.checked = uncon;
    els.min.disabled = uncon;
    els.max.disabled = uncon;
  });
}

function saveSettingsFromForm() {
  eachInput((param, els) => {
    const setOrClear = (suffix, value) => {
      if (value === '' || value == null) localStorage.removeItem(STORAGE_PREFIX + param + '.' + suffix);
      else localStorage.setItem(STORAGE_PREFIX + param + '.' + suffix, value);
    };
    setOrClear('min', els.min.value);
    setOrClear('max', els.max.value);
    if (els.uncon.checked) localStorage.setItem(STORAGE_PREFIX + param + '.unconstrained', '1');
    else localStorage.removeItem(STORAGE_PREFIX + param + '.unconstrained');
  });
}

function clearStoredSettings() {
  for (const param of PARAMS) {
    localStorage.removeItem(STORAGE_PREFIX + param + '.min');
    localStorage.removeItem(STORAGE_PREFIX + param + '.max');
    localStorage.removeItem(STORAGE_PREFIX + param + '.unconstrained');
  }
}

function fmtBound(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e7 || abs < 1e-4) return v.toExponential(0).replace('e+', 'e').replace('e-', 'e-');
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toPrecision(2).replace(/\.?0+$/, '');
}

function dataXBounds() {
  if (!lastInput || !Array.isArray(lastInput.x)) return null;
  const positive = lastInput.x.filter(v => v > 0 && Number.isFinite(v));
  if (positive.length === 0) return null;
  return { xMin: Math.min(...positive), xMax: Math.max(...positive) };
}

function effectiveBoundsText(param, els) {
  const uncon = els.uncon.checked;
  const isHill = param === 'hill1' || param === 'hill2';
  const unit = isHill ? '' : ' nM';

  if (uncon) {
    const lo = isHill ? UNCONSTRAINED_HILL_MIN : UNCONSTRAINED_CONC_MIN;
    const hi = isHill ? UNCONSTRAINED_HILL_MAX : UNCONSTRAINED_CONC_MAX;
    return `using ${fmtBound(lo)} to ${fmtBound(hi)}${unit} (unconstrained)`;
  }

  const minRaw = els.min.value.trim();
  const maxRaw = els.max.value.trim();
  const minVal = minRaw ? Number(minRaw) : null;
  const maxVal = maxRaw ? Number(maxRaw) : null;

  const x = dataXBounds();
  let defLo = null, defHi = null;
  if (isHill) {
    defLo = DEFAULT_HILL_MIN;
    defHi = DEFAULT_HILL_MAX;
  } else if (x) {
    defLo = x.xMin / DEFAULT_CONC_FACTOR_BELOW;
    defHi = x.xMax * DEFAULT_CONC_FACTOR_ABOVE;
  }

  if (defLo == null) return 'auto bounds depend on data — drop a file';

  const lo = Number.isFinite(minVal) ? minVal : defLo;
  const hi = Number.isFinite(maxVal) ? maxVal : defHi;
  const minTag = minVal == null ? ' (auto)' : '';
  const maxTag = maxVal == null ? ' (auto)' : '';
  if (minTag && maxTag) return `using ${fmtBound(lo)} to ${fmtBound(hi)}${unit} (auto)`;
  return `using ${fmtBound(lo)}${minTag} to ${fmtBound(hi)}${maxTag}${unit}`;
}

// Returns { valid: bool, options: {...}, message: string }
function getCurrentSettings() {
  const options = {};
  let valid = true;
  let firstMessage = '';
  eachInput((param, els) => {
    els.err.classList.remove('is-error');
    els.min.classList.remove('invalid');
    els.max.classList.remove('invalid');
    const uncon = els.uncon.checked;
    const minRaw = els.min.value.trim();
    const maxRaw = els.max.value.trim();
    const minVal = minRaw === '' ? null : Number(minRaw);
    const maxVal = maxRaw === '' ? null : Number(maxRaw);

    let err = '';
    if (!uncon) {
      if (minRaw !== '' && (!Number.isFinite(minVal) || minVal <= 0)) {
        err = 'Min must be a positive number';
        els.min.classList.add('invalid');
      } else if (maxRaw !== '' && (!Number.isFinite(maxVal) || maxVal <= 0)) {
        err = 'Max must be a positive number';
        els.max.classList.add('invalid');
      } else if (minVal != null && maxVal != null && maxVal <= minVal) {
        err = 'Max must be greater than min';
        els.min.classList.add('invalid');
        els.max.classList.add('invalid');
      }
    }
    if (err) {
      els.err.textContent = err;
      els.err.classList.add('is-error');
      valid = false;
      if (!firstMessage) firstMessage = `${param}: ${err}`;
    } else {
      els.err.textContent = effectiveBoundsText(param, els);
    }
    options[param] = {
      min: uncon ? null : minVal,
      max: uncon ? null : maxVal,
      unconstrained: uncon,
    };
  });
  return { valid, options, message: firstMessage };
}

function syncDisabledStateFromCheckboxes() {
  eachInput((_param, els) => {
    const uncon = els.uncon.checked;
    els.min.disabled = uncon;
    els.max.disabled = uncon;
  });
}

function refreshRefitButton() {
  const btn = document.getElementById('refit-btn');
  const status = document.getElementById('advanced-status');
  if (!btn) return;
  const { valid, message } = getCurrentSettings();
  const hasData = !!(lastInput && lastInput.samples && lastInput.samples.length);
  btn.disabled = !(valid && hasData);
  if (!hasData) {
    status.textContent = 'Drop a file to enable re-fitting.';
    status.classList.remove('success');
  } else if (!valid) {
    status.textContent = message || 'Fix invalid bounds.';
    status.classList.remove('success');
  } else {
    status.textContent = '';
    status.classList.remove('success');
  }
}

function wireSettingsEventListeners() {
  eachInput((_param, els) => {
    const onChange = () => {
      syncDisabledStateFromCheckboxes();
      saveSettingsFromForm();
      refreshRefitButton();
    };
    els.min.addEventListener('input', onChange);
    els.max.addEventListener('input', onChange);
    els.uncon.addEventListener('change', onChange);
  });
  document.getElementById('reset-bounds-btn')?.addEventListener('click', () => {
    clearStoredSettings();
    loadSettingsToForm();
    refreshRefitButton();
    const status = document.getElementById('advanced-status');
    if (status) {
      status.textContent = 'Reset to defaults.';
      status.classList.add('success');
    }
  });
  document.getElementById('refit-btn')?.addEventListener('click', () => {
    if (!lastInput) return;
    const { valid, options } = getCurrentSettings();
    if (!valid) return;
    runFitsAndRender(lastInput.x, lastInput.samples, options);
    const status = document.getElementById('advanced-status');
    if (status) {
      status.textContent = 'Re-fitted with current settings.';
      status.classList.add('success');
      setTimeout(() => { status.classList.remove('success'); status.textContent = ''; }, 3000);
    }
  });
}

function runFitsAndRender(x, samples, options) {
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
      fit: fitSample(xFlat, yFlat, options),
    };
  });
  lastResults = results;
  renderResults(results);
}

async function handleFile(file) {
  hideError();
  try {
    const { x, samples } = await parseXlsx(file);
    lastInput = { x, samples };
    showPreview(x, samples);
    document.getElementById('info').classList.remove('hidden');

    const { valid, options } = getCurrentSettings();
    if (!valid) {
      // Should not normally hit because the user can't fix bounds before
      // dropping a file in any meaningful way, but be defensive.
      showError('Advanced settings have invalid bounds. Open the Advanced settings panel to correct them.');
      return;
    }
    runFitsAndRender(x, samples, options);
    refreshRefitButton();
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
    'Sample', 'N pts', 'Xpeak (nM)',
    'EC50 (apparent)', 'IC50 (apparent)',
    'Width (nM)', 'Width (fold)',
    'Bottom', 'Top',
    'EC50 (model)', 'IC50 (model)',
    'Hill1', 'Hill2', 'R²', 'Conv?', 'Flags',
  ];
  let html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach((c) => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';
  results.forEach((r) => {
    const f = r.fit;
    const boundaryHits = f.boundaryHits || [];
    const r2Low = !(f.r2 > 0.8);
    const flagParts = [
      !f.converged ? 'no convergence' : null,
      ...boundaryHits.map(b => `${b} at bound`),
      r2Low ? `low R² (${fmtR2(f.r2)})` : null,
      f.topInflated ? 'degenerate fit (Top ≫ peak; model EC50/IC50 unreliable, use apparent)' : null,
    ].filter(Boolean);
    const flagged = flagParts.length > 0;
    const flagsHtml = flagged
      ? `<span style="color:#c00">${esc(flagParts.join('; '))}</span>`
      : '—';
    const tip = flagged ? ` title="${esc(flagParts.join('; '))}"` : '';
    const nReps = (r.replicates || []).length;
    const nPtsCell = `${f.nPoints != null ? f.nPoints : '—'}` + (nReps > 1 ? ` <span style="color:#888">(${nReps} reps)</span>` : '');
    html += `<tr class="${flagged ? 'flagged' : ''}"${tip}>`;
    html += `<td>${esc(r.name)}</td>`;
    html += `<td>${nPtsCell}</td>`;
    html += `<td><strong>${fmt(f.xpeak)}</strong></td>`;
    html += `<td>${fmt(f.apparentEC50)}</td>`;
    html += `<td>${fmt(f.apparentIC50)}</td>`;
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
    html += `<td>${flagsHtml}</td>`;
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

// ----- Bootstrap -----

loadSettingsToForm();
syncDisabledStateFromCheckboxes();
wireSettingsEventListeners();
refreshRefitButton();
