/** `usage-analytics` namespace (ADR 0118) — the LLM usage/cost admin dashboard. */
export const messages = {
  eyebrow: 'Workspace',
  title: 'LLM usage',
  lede: 'Per-model token usage across this workspace. Read-only; token counts only.',
  org: 'Workspace',
  colProvider: 'Provider',
  colModel: 'Model',
  colInput: 'Input tokens',
  colOutput: 'Output tokens',
  colCalls: 'Calls',
  empty: 'No usage recorded yet.',
  emptyHint: 'Usage appears here once conversations run on a configured provider.',
  loadError: 'Could not load usage.',
  disabled: 'Usage analytics is off for this workspace.',
  colCost: 'Est. cost',
} as const;
