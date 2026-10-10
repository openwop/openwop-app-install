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
  nextRun: 'Próxima execução {{when}}',
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
  keepCadence: 'Manter a atual ({{cadence}})',
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
  firedWithRunLink: 'Disparado.',
  runNowSkipped: 'Não foi executado — {{reason}}.',
  firedNoWorkflow: 'Disparado (nenhum workflow vinculado).',

  // ADR 0313 D3 — chips de agendamento silencioso
  wontFire: 'Não vai disparar — a cadência não pôde ser interpretada',
  cadenceExhausted: 'Não vai disparar de novo — nenhum horário futuro corresponde a esta cadência',
  oneShotDone: 'Concluído (execução única)',
  // ADR 0815 D4 — a job paused because the member it ran as left the workspace
  pausedOwnerLeft: 'Pausado — a pessoa em nome de quem era executado saiu',
  statusPlanLapsed: 'Pausado — plano expirado',
  planLapsedHint: 'Seu plano não inclui mais este recurso, então estas execuções são ignoradas. Ele retoma sozinho quando o recurso voltar ao seu plano.',
  planLapsedLink: 'Ver planos',
  pausedReownNeeded: 'Este agendamento foi pausado porque a pessoa em nome de quem era executado saiu do espaço de trabalho. Retome-o aqui para executá-lo em seu nome.',
  pausedRecreate: 'Este agendamento foi pausado porque a pessoa em nome de quem era executado saiu do espaço de trabalho. Crie-o de novo a partir do recurso para executá-lo em seu nome.',
  resumeReownTitle: 'Retomar e assumir como proprietário?',
  resumeReownBody: 'A pessoa em nome de quem este agendamento era executado foi removida do espaço de trabalho. Se você retomá-lo, ele passará a ser executado em seu nome.',
  resumeReownConfirm: 'Retomar como eu',
  pausedOwnerLeftRunNow: 'Retome-o primeiro — a pessoa em nome de quem ele era executado saiu do espaço de trabalho',
} as const;
