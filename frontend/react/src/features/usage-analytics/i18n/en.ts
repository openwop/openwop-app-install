/** `usage-analytics` namespace (ADR 0118) — the LLM usage/cost admin dashboard. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Model usage belongs to an organization',
  orgsFailedClause: 'The usage rollup was never requested',
  eyebrow: 'Workspace',
  title: 'LLM usage',
  lede: 'Per-model token usage across this workspace. Read-only; token counts only.',
  colProvider: 'Provider',
  colModel: 'Model',
  colInput: 'Input tokens',
  colOutput: 'Output tokens',
  colCalls: 'Calls',
  empty: 'No usage recorded yet.',
  emptyHint: 'Usage appears here once conversations run on a configured provider.',
  loadError: 'Could not load usage.',
  // UA-R2-1 — the failed-read state. The title says the read did not happen; the
  // body carries `loadError`. Deliberately NOT phrased as "no usage": the whole
  // defect was a failed read presenting as an empty result.
  loadFailedTitle: 'Usage could not be loaded',
  loadRetry: 'Try again',
  disabled: 'Usage analytics is off for this workspace.',
  colCost: 'Est. cost',

  // §4.5 collection kit — usage filter
  filterGroup: 'Filters',
  filterPlaceholder: 'Search usage…',
  filterAria: 'Search usage by provider or model',
  filterProviderLabel: 'Filter by provider',
  allProviders: 'All providers',
  noMatchTitle: 'No matches',
  noMatchBody: 'Nothing matches the current filters.',
  clearFilters: 'Clear filters',
  costUnpriced: "—",
  costUnpricedHint: "No rate on file for this model, so its cost is unknown — not zero.",
  costIncomplete: "{{count}} model(s) have no rate on file, so their cost is unknown and the totals here are incomplete.",
} as const;
