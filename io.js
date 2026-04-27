export async function parseXlsx(file) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS (XLSX) failed to load.');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('No sheets in workbook.');
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  let dataStart = -1;
  for (let i = 0; i < aoa.length; i++) {
    const v = aoa[i] && aoa[i][0];
    if (typeof v === 'number' && Number.isFinite(v)) { dataStart = i; break; }
  }
  if (dataStart === -1) {
    throw new Error('No numeric data found in column A. Column A should contain compound concentrations (nM).');
  }

  const headerRow = dataStart > 0 ? (aoa[dataStart - 1] || []) : [];
  const ncols = Math.max(...aoa.slice(dataStart).map(r => (r ? r.length : 0)));

  const sampleCols = [];
  for (let c = 1; c < ncols; c++) {
    let hasNum = false;
    for (let r = dataStart; r < aoa.length; r++) {
      const v = aoa[r] && aoa[r][c];
      if (typeof v === 'number' && Number.isFinite(v)) { hasNum = true; break; }
    }
    if (hasNum) sampleCols.push(c);
  }
  if (sampleCols.length === 0) {
    throw new Error('No numeric sample columns found. Columns B onwards should contain signal values.');
  }

  // Build the unique X array.
  const x = [];
  for (let r = dataStart; r < aoa.length; r++) {
    const xv = aoa[r] && aoa[r][0];
    if (typeof xv === 'number' && Number.isFinite(xv)) x.push(xv);
  }

  // Group sample columns by trimmed, case-insensitive header name.
  // Columns with empty headers each become their own (un-grouped) sample.
  const groups = new Map();
  let unnamedCounter = 0;
  for (const c of sampleCols) {
    const raw = headerRow[c];
    const hasName = raw != null && String(raw).trim().length > 0;
    const display = hasName ? String(raw).trim() : `Sample ${++unnamedCounter}`;
    const key = hasName ? display.toLowerCase() : `__unnamed_${c}`;
    if (!groups.has(key)) groups.set(key, { displayName: display, columns: [] });
    groups.get(key).columns.push(c);
  }

  // Build per-sample replicate arrays (one y array per replicate column, aligned with x).
  const samples = [];
  for (const group of groups.values()) {
    const replicates = group.columns.map((c) => {
      const yArr = [];
      for (let r = dataStart; r < aoa.length; r++) {
        const xv = aoa[r] && aoa[r][0];
        if (typeof xv !== 'number' || !Number.isFinite(xv)) continue;
        const yv = aoa[r] && aoa[r][c];
        yArr.push(typeof yv === 'number' && Number.isFinite(yv) ? yv : NaN);
      }
      return yArr;
    }).filter(rep => rep.some(v => Number.isFinite(v)));
    if (replicates.length > 0) {
      samples.push({ name: group.displayName, replicates });
    }
  }

  if (samples.length === 0) throw new Error('No usable sample data.');
  return { x, samples };
}

export function exportCsv(results) {
  const cols = [
    'Sample', 'N_replicates', 'N_points',
    'Xpeak_nM',
    'EC50_apparent_nM', 'IC50_apparent_nM',
    'Width_nM', 'Width_fold',
    'Bottom', 'Top',
    'EC50_model_nM', 'IC50_model_nM',
    'Hill1', 'Hill2', 'R2', 'Converged', 'Flags',
    'Bottom_SE', 'Top_SE', 'EC50_model_SE', 'IC50_model_SE', 'Hill1_SE', 'Hill2_SE',
  ];
  const rows = [cols.join(',')];
  results.forEach(r => {
    const f = r.fit;
    const p = f.params;
    const e = f.errors || {};
    const r2Low = !(f.r2 > 0.8);
    const flagParts = [
      !f.converged ? 'no convergence' : null,
      ...((f.boundaryHits || []).map(b => `${b} at bound`)),
      r2Low ? `low R2` : null,
      f.topInflated ? 'degenerate fit (Top >> peak)' : null,
    ].filter(Boolean);
    const flagsField = flagParts.length ? flagParts.join('; ') : '';
    const cells = [
      csvCell(r.name),
      r.replicates ? r.replicates.length : 1,
      f.nPoints != null ? f.nPoints : '',
      num(f.xpeak),
      num(f.apparentEC50), num(f.apparentIC50),
      num(f.widthLinear), num(f.widthFold),
      num(p.Bottom), num(p.Top),
      num(p.EC50), num(p.IC50),
      num(p.Hill1), num(p.Hill2), num(f.r2),
      f.converged ? 1 : 0, csvCell(flagsField),
      num(e.Bottom), num(e.Top), num(e.EC50), num(e.IC50), num(e.Hill1), num(e.Hill2),
    ];
    rows.push(cells.join(','));
  });
  return rows.join('\n') + '\n';
}

function csvCell(s) {
  const v = String(s == null ? '' : s);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function num(v) {
  return Number.isFinite(v) ? String(v) : '';
}
