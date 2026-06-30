/**
 * `schedules` namespace — user-facing strings for the subject schedule-curation
 * UI (`src/schedules/`). FLAT camelCase keys, one per line (ADR 0065). Plural
 * keys use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Empty / state
  noSchedulesTitle: 'Nenhum agendamento ainda',
  notRunYet: 'Ainda não executado',
  noWorkflow: 'Sem workflow',

  // Status chips
  statusActive: 'Ativo',
  statusPaused: 'Pausado',

  // Row meta
  runsCadence: 'Executa {{cadence}}',
  runsCadenceWithTz: 'Executa {{cadence}} · {{timezone}}',
  lastRun: 'Última execução {{when}}',
  viewRun: 'ver execução',

  // Cadence preset labels (mirrors CADENCE_PRESETS by key)
  cadenceHourly: 'A cada hora',
  cadenceDaily: 'Diariamente (9:00)',
  cadenceWeekdays: 'Dias úteis (9:00)',
  cadenceWeekly: 'Semanalmente (seg 9:00)',

  // Row actions
  pause: 'Pausar',
  resume: 'Retomar',
  runNow: 'Executar agora',
  saveChanges: 'Salvar alterações',

  // Form fields / selects
  workflowLabel: 'Workflow',
  cadenceLabel: 'Cadência',
  assignWorkflowFirst: 'Atribua um workflow primeiro',

  // Create form
  createHeading: 'Criar um agendamento',
  createButton: 'Criar agendamento',

  // Confirms
  deleteConfirm: 'Excluir o agendamento “{{label}}”? Isso não pode ser desfeito.',

  // Run-now notices
  firedWithRun: 'Disparado — ',
  firedNoWorkflow: 'Disparado (nenhum workflow vinculado).',
} as const;
