/**
 * Shared priority-matrix vocabulary used by BOTH the portfolio/index page
 * (`PriorityMatrixPage`) and the routed list-detail page (`PriorityListPage`),
 * kept out of either so the two routes never drift on how a scoring model is
 * named.
 */

// Scoring-model code → label key. A code with no entry falls back to the code itself.
export const MODEL_LABEL_KEY = {
  weighted: 'modelWeighted',
  wsjf: 'modelWsjf',
  rice: 'modelRice',
  ice: 'modelIce',
  'value-effort': 'modelValueEffort',
} as const;
