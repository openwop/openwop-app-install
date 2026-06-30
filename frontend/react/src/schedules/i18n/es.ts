/**
 * `schedules` namespace — user-facing strings for the subject schedule-curation
 * UI (`src/schedules/`). FLAT camelCase keys, one per line (ADR 0065). Plural
 * keys use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Empty / state
  noSchedulesTitle: 'Aún no hay programaciones',
  notRunYet: 'Aún no se ha ejecutado',
  noWorkflow: 'Sin flujo de trabajo',

  // Status chips
  statusActive: 'Activa',
  statusPaused: 'En pausa',

  // Row meta
  runsCadence: 'Se ejecuta {{cadence}}',
  runsCadenceWithTz: 'Se ejecuta {{cadence}} · {{timezone}}',
  lastRun: 'Última ejecución {{when}}',
  viewRun: 'ver ejecución',

  // Cadence preset labels (mirrors CADENCE_PRESETS by key)
  cadenceHourly: 'Cada hora',
  cadenceDaily: 'Diaria (9:00)',
  cadenceWeekdays: 'Días laborables (9:00)',
  cadenceWeekly: 'Semanal (lun 9:00)',

  // Row actions
  pause: 'Pausar',
  resume: 'Reanudar',
  runNow: 'Ejecutar ahora',
  saveChanges: 'Guardar cambios',

  // Form fields / selects
  workflowLabel: 'Flujo de trabajo',
  cadenceLabel: 'Cadencia',
  assignWorkflowFirst: 'Asigne primero un flujo de trabajo',

  // Create form
  createHeading: 'Crear una programación',
  createButton: 'Crear programación',

  // Confirms
  deleteConfirm: '¿Eliminar la programación «{{label}}»? Esto no se puede deshacer.',

  // Run-now notices
  firedWithRun: 'Disparada — ',
  firedNoWorkflow: 'Disparada (sin flujo de trabajo asociado).',
} as const;
