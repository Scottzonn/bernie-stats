# Bernie Stats — Bell Curve Fitter

A static web app for fitting bell-shaped (hook-effect) dose–response curves from ternary-complex AlphaLISA assays. Each sample is fit independently with a product-of-sigmoids model; the headline output is **Xpeak**, the concentration giving maximum ternary complex formation.

## Use it locally

```sh
cd bernie-stats
python3 -m http.server 8000
# open http://localhost:8000
```

(Most browsers will refuse `file://` ES-module imports, so use a tiny local server like the one above. Any static server works.)

## Hosting

This is a fully static site — no backend, no build step. Drop the folder onto:

- **Netlify Drop**: https://app.netlify.com/drop (drag the folder)
- **GitHub Pages**: push to a repo, enable Pages on the `main` branch
- **Vercel** / **Cloudflare Pages**: connect a repo, no build command needed

Data never leaves the user's browser.

## Expected xlsx layout

### Without replicates

| Conc (nM) | Compound A | Compound B | Compound C |
|---|---|---|---|
| 0.03 | 9747  | 10279 | 13794 |
| 0.1  | 11514 | 12236 | 13699 |
| …    | …     | …     | …     |

One column per compound.

### With replicates (recommended for noisy real-world data)

| Conc (nM) | Compound A | Compound A | Compound A | Compound B | Compound B | Compound B |
|---|---|---|---|---|---|---|
| 0.03 | 9747  | 10279 | 9911  | 13794 | 14002 | 13455 |
| 0.1  | 11514 | 12236 | 11890 | 13699 | 14122 | 13501 |
| …    | …     | …     | …     | …     | …     | …     |

**Columns sharing the same sample name** (case-insensitive, after trimming whitespace) are treated as replicates of the same sample and fit together as one curve. With 8 concentrations × 3 replicates = 24 data points fitting 6 parameters, fits are dramatically more stable than from a single replicate.

### General rules

- **Column A:** compound concentration in nM (linear values, e.g. `0.03, 0.1, 0.3, 1, 3, 10, 30, 100`).
- **Columns B onwards:** signal values. Column header in the row immediately above the first numeric data row.
- The tool auto-detects the data start by finding the first numeric value in column A.
- Empty cells inside a replicate column are treated as missing (skipped, not zero-filled).

## What the outputs mean

| Output | Meaning |
|---|---|
| **Xpeak** | Concentration at the curve's maximum — the headline ranking number. |
| **Width (nM)** | Linear distance between the two inflection points: `IC50 − EC50`. |
| **Width (fold)** | Fold ratio between the two inflection points: `IC50 / EC50`. Scale-invariant. |
| N pts | Total number of individual data points used in the fit (= concentrations × replicates after dropping missing values). |
| Bottom, Top | Fitted baseline and asymptotic top of the model. Top is by definition above the visible peak. |
| EC50 (apparent) | Empirical midpoint of the rising side — **not** a binding constant. |
| IC50 (apparent) | Empirical midpoint of the falling/hook side — **not** a binding constant. |
| Hill1, Hill2 | Slope parameters for rising and falling sides. Bounded to [0.5, 4]. |
| R² | Goodness-of-fit on the supplied data points. |
| ± values | Standard errors from the Jacobian at the solution. |
| Conv? / At bound | Diagnostic flags — pink rows indicate likely bad fits. "At bound" lists any parameters pinned at their min/max. |

## How the fit works

- The model is a product of two sigmoids: an ascending Hill curve × a descending hook. Six free parameters: Bottom, Top, EC50, IC50, Hill1, Hill2.
- LM is run from **10 different starting points per sample** (1 deterministic heuristic + 9 randomised within bounds, using a fixed seed so re-runs of the same data give identical results); the best fit by residual sum of squares is kept.
- IC50 > EC50 is enforced at the model level (via reparameterisation), so the optimizer can't produce geometrically nonsensical results.
- Xpeak is computed numerically from the fitted curve on a 5000-point log-spaced grid — there is no closed-form expression for the peak of a product of two sigmoids.
- Standard errors come from the Jacobian at the solution: `σ = √(diag((JᵀJ)⁻¹) × residual_variance)`.

## Advanced settings (fitting constraints)

The collapsed **Advanced settings** panel above the dropzone lets you change the bounds the optimizer respects when fitting each curve. Defaults are shown as placeholder text in each input.

| Parameter | Default | When to widen |
|---|---|---|
| Hill1 | 0.5 to 4 | Your assay genuinely produces sharper rising sigmoids than biology typically does. |
| Hill2 | 0.5 to 4 | Hooks sharper than ~5-fold drop per concentration step (rare). |
| EC50 | data-derived (xMin/100 to xMax·100) | Almost never. |
| IC50 | data-derived (xMin/100 to xMax·100) | Almost never. |

Tick **"Unconstrained"** on a row to remove that parameter's bounds entirely (the optimizer will be given a `[1e-9, 1e9]` window for concentrations or `[0.01, 1000]` for Hill).

`IC50 > EC50` is always enforced as a post-fit check — required for the result to be a real bell shape. If a fit ends up with IC50 ≤ EC50, the row is flagged.

After changing settings, click **"Re-fit with current settings"** inside the panel to re-run the fit on the currently-loaded data without re-uploading.

Settings persist in your browser via `localStorage`. Click **"Reset to defaults"** to clear them.

## Caveats

- The model is empirical, not mechanistic. It does **not** give cooperativity (α) or true binding constants. Use it for ranking, not for biophysics.
- With few data points, R² can sit very close to 1 even when individual parameters are highly uncertain. Trust Xpeak (data-driven) more than Bottom/Top (asymptote-driven, often poorly identified). Use replicates whenever possible — they materially improve parameter identifiability.
- "Apparent EC50" and "apparent IC50" are descriptive fit parameters, not Kd values. Don't report them as binding constants.
