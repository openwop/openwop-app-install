/**
 * ADR 0945 D3 — the stage-A threshold table. Changing ANY value bumps
 * {@link FIDELITY_RULESET_VERSION}: a verdict names the ruleset it was held
 * to, so an approval binds to a reproducible result (Q5: the P2 eval suite
 * calibrates these; until then they are set from the witnesses in
 * `adr0945-p1-stage-a.test.ts` — identity ≈ 0, a recolour far past ΔE 8).
 */
export const FIDELITY_RULESET_VERSION = 'fid-a-1';

export const STAGE_A_RULES = {
  /** Raster grid both images are compared on. */
  grid: 32,
  /** Source alpha at or above this is product interior (the mask). */
  maskAlphaMin: 250,
  /** Max Hamming distance (of 64 bits). */
  dhashMax: 10,
  phashMax: 12,
  /** Max CIEDE2000 between mean masked colours. */
  deltaEMax: 8,
  /** Fewer masked cells than this cannot be judged (a near-empty cut-out). */
  minMaskCells: 16,
} as const;
