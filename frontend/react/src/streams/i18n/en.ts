/**
 * `streams` namespace — user-facing strings for the event-stream view
 * (`src/streams/`). FLAT camelCase keys, one per line (ADR 0065). The event
 * count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  noEventsYet: 'No events yet.',
  emittedMediaAlt: 'emitted media',
  downloadAsset: 'download asset',
  forkTitle: 'Fork a new run from this event (branch mode)',
  fork: 'fork',
  payload: 'payload',
  copy: 'Copy',
  copied: 'Copied',
  copyTitle: 'Copy events as markdown (paste into Claude Code, Slack, GitHub)',
  exportJson: 'Export JSON',
  exportJsonTitle: 'Download the full event log as JSON',
  eventCount_one: '{{count}} event',
  eventCount_other: '{{count}} events',
} as const;
