/** `evals` namespace (ADR 0123) — the model quality leaderboard. */
export const messages = {
  eyebrow: 'Platform',
  title: 'Model leaderboard',
  lede: 'See which model your team prefers, ranked by thumbs-up and thumbs-down on real chat replies.',
  org: 'Workspace',
  colModel: 'Model',
  colUp: 'Up',
  colDown: 'Down',
  colWinRate: 'Win rate',
  colElo: 'Elo',
  empty: 'No rated turns yet.',
  emptyHint: 'Thumbs-up / thumbs-down on chat replies build this ranking.',
  loadError: 'Could not load the leaderboard.',
  disabled: 'The eval leaderboard is off for this workspace.',
} as const;
