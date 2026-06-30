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
  firedWithRun: 'Fired — ',
  firedNoWorkflow: 'Fired (no workflow bound).',
} as const;
