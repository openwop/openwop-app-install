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
  runsCadence: 'S’exécute {{cadence}}',
  runsCadenceWithTz: 'S’exécute {{cadence}} · {{timezone}}',
  lastRun: 'Dernière exécution {{when}}',
  nextRun: 'Prochaine exécution {{when}}',
  viewRun: 'voir l’exécution',

  // Cadence preset labels (mirrors CADENCE_PRESETS by key)
  cadenceHourly: 'Toutes les heures',
  cadenceDaily: 'Quotidienne (9:00)',
  cadenceWeekdays: 'En semaine (9:00)',
  cadenceWeekly: 'Hebdomadaire (lun. 9:00)',

  // Row actions
  pause: 'Mettre en pause',
  resume: 'Reprendre',
  runNow: 'Exécuter maintenant',
  keepCadence: 'Conserver l\u2019actuelle ({{cadence}})',
  saveChanges: 'Enregistrer les modifications',

  // Form fields / selects
  workflowLabel: 'Workflow',
  cadenceLabel: 'Cadence',
  assignWorkflowFirst: 'Assignez d’abord un workflow',

  // Create form
  createHeading: 'Créer une planification',
  createButton: 'Créer la planification',

  // Confirms
  deleteConfirm: 'Supprimer la planification « {{label}} » ? Cette action est irréversible.',

  // Run-now notices
  firedWithRunLink: 'Déclenchée.',
  runNowSkipped: 'Non exécutée — {{reason}}.',
  firedNoWorkflow: 'Déclenchée (aucun workflow associé).',

  // ADR 0313 D3 — pastilles de planification silencieuse
  wontFire: 'Ne se déclenchera pas — cadence illisible',
  cadenceExhausted: 'Ne se déclenchera plus — aucune date future ne correspond à cette cadence',
  oneShotDone: 'Terminée (ponctuelle)',
  // ADR 0815 D4 — a job paused because the member it ran as left the workspace
  pausedOwnerLeft: 'En pause — la personne au nom de laquelle elle s’exécutait est partie',
  statusPlanLapsed: 'En pause — forfait expiré',
  planLapsedHint: 'Votre forfait n’inclut plus cette fonctionnalité, ces exécutions sont donc ignorées. Elle reprend d’elle-même quand la fonctionnalité revient dans votre forfait.',
  planLapsedLink: 'Voir les forfaits',
  pausedReownNeeded: 'Cette planification a été mise en pause car la personne au nom de laquelle elle s’exécutait a quitté l’espace de travail. Reprenez-la ici pour qu’elle s’exécute en votre nom.',
  pausedRecreate: 'Cette planification a été mise en pause car la personne au nom de laquelle elle s’exécutait a quitté l’espace de travail. Recréez-la depuis sa fonctionnalité pour qu’elle s’exécute en votre nom.',
  resumeReownTitle: 'Reprendre et en devenir propriétaire ?',
  resumeReownBody: 'La personne au nom de laquelle cette planification s’exécutait a été retirée de l’espace de travail. Si vous la reprenez, elle s’exécutera désormais en votre nom.',
  resumeReownConfirm: 'Reprendre en mon nom',
  pausedOwnerLeftRunNow: 'Reprenez-la d’abord — la personne au nom de laquelle elle s’exécutait a quitté l’espace de travail',
} as const;
