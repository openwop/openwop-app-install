/**
 * `schedules` namespace — user-facing strings for the subject schedule-curation
 * UI (`src/schedules/`). FLAT camelCase keys, one per line (ADR 0065). Plural
 * keys use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Empty / state
  noSchedulesTitle: 'Aucune planification pour le moment',
  notRunYet: 'Pas encore exécutée',
  noWorkflow: 'Aucun workflow',

  // Status chips
  statusActive: 'Active',
  statusPaused: 'En pause',

  // Row meta
  runsCadence: 'S\'exécute {{cadence}}',
  runsCadenceWithTz: 'S\'exécute {{cadence}} · {{timezone}}',
  lastRun: 'Dernière exécution {{when}}',
  viewRun: 'voir l\'exécution',

  // Cadence preset labels (mirrors CADENCE_PRESETS by key)
  cadenceHourly: 'Toutes les heures',
  cadenceDaily: 'Quotidienne (9:00)',
  cadenceWeekdays: 'En semaine (9:00)',
  cadenceWeekly: 'Hebdomadaire (lun. 9:00)',

  // Row actions
  pause: 'Mettre en pause',
  resume: 'Reprendre',
  runNow: 'Exécuter maintenant',
  saveChanges: 'Enregistrer les modifications',

  // Form fields / selects
  workflowLabel: 'Workflow',
  cadenceLabel: 'Cadence',
  assignWorkflowFirst: 'Assignez d\'abord un workflow',

  // Create form
  createHeading: 'Créer une planification',
  createButton: 'Créer la planification',

  // Confirms
  deleteConfirm: 'Supprimer la planification « {{label}} » ? Cette action est irréversible.',

  // Run-now notices
  firedWithRun: 'Déclenchée — ',
  firedNoWorkflow: 'Déclenchée (aucun workflow associé).',
} as const;
