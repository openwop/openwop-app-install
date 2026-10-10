/**
 * `schedules` namespace — user-facing strings for the subject schedule-curation
 * UI (`src/schedules/`). FLAT camelCase keys, one per line (ADR 0065). Plural
 * keys use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Empty / state
  noSchedulesTitle: 'No schedules yet',
  notRunYet: 'Not run yet',
  noWorkflow: 'No workflow',

  // Status chips
  statusActive: 'Active',
  statusPaused: 'Paused',

  // Row meta
  runsCadence: 'Runs {{cadence}}',
  runsCadenceWithTz: 'Runs {{cadence}} · {{timezone}}',
  lastRun: 'Last run {{when}}',
  nextRun: 'Next run {{when}}',
  viewRun: 'view run',

  // Cadence preset labels (mirrors CADENCE_PRESETS by key)
  cadenceHourly: 'Hourly',
  cadenceDaily: 'Daily (9:00 AM)',
  cadenceWeekdays: 'Weekdays (9:00 AM)',
  cadenceWeekly: 'Weekly (Mon 9:00 AM)',

  // Row actions
  pause: 'Pause',
  resume: 'Resume',
  runNow: 'Run now',
  keepCadence: 'Keep current ({{cadence}})',
  saveChanges: 'Save changes',

  // Form fields / selects
  workflowLabel: 'Workflow',
  cadenceLabel: 'Cadence',
  assignWorkflowFirst: 'Assign a workflow first',

  // Create form
  createHeading: 'Create a schedule',
  createButton: 'Create schedule',

  // Confirms
  deleteConfirm: 'Delete the schedule “{{label}}”? This can\'t be undone.',

  // Run-now notices
  firedWithRunLink: 'Fired.',
  runNowSkipped: 'Did not run — {{reason}}.',
  firedNoWorkflow: 'Fired (no workflow bound).',

  // ADR 0313 D3 — silent-schedule chips
  wontFire: 'Won\u2019t fire — cadence didn\u2019t parse',
  cadenceExhausted: 'Won\u2019t fire again — no future time matches this cadence',
  oneShotDone: 'Completed (one-shot)',
  // ADR 0815 D4 — a job paused because the member it ran as left the workspace
  pausedOwnerLeft: 'Paused — the person it ran as left',
  statusPlanLapsed: 'Paused — plan lapsed',
  planLapsedHint: 'Your plan no longer includes this feature, so these runs are skipped. It resumes by itself when the feature is back on your plan.',
  planLapsedLink: 'See plans',
  pausedReownNeeded: 'This schedule was paused because the person it ran as left the workspace. Resume it from here to run it as you.',
  pausedRecreate: 'This schedule was paused because the person it ran as left the workspace. Create it again from its feature to run it as you.',
  resumeReownTitle: 'Resume and take ownership?',
  resumeReownBody: 'The person this schedule ran as was removed from the workspace. If you resume it, it runs as you from now on.',
  resumeReownConfirm: 'Resume as me',
  pausedOwnerLeftRunNow: 'Resume it first — the person it ran as left the workspace',
} as const;
