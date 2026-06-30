/**
 * `profiles` namespace — user-facing copy for the Profiles feature (My Profile,
 * Team directory, and the profile tabs — ADR 0005 / ADR 0025).
 * Feature-self-contained: every profiles string lives here. Generic actions/
 * states are reused from the `common` namespace via `t('common:…')` and are NOT
 * duplicated. Plural keys use i18next `_one`/`_other` suffixes.
 */
export const messages = {
  // ── My Profile page chrome ────────────────────────────────────────────
  eyebrow: 'Plataforma',
  title: 'Mi perfil',
  lede: 'Tu perfil de autoservicio. Visible para tu equipo en el directorio.',
  loadProfileFailed: 'No se pudo cargar tu perfil.',
  loadBoardFailed: 'No se pudo cargar tu tablero.',

  // Tabs
  tabProfile: 'Perfil',
  tabBoard: 'Mi tablero',
  tabWorkflows: 'Flujos de trabajo asignados',
  tabSchedules: 'Programaciones',
  tabActivity: 'Actividad',
  tabConnections: 'Conexiones',
  tabMemory: 'Memoria',
  tabKnowledge: 'Conocimiento',
  tabTwin: 'Quién puede recordar mi memoria',

  // Identity card
  avatarAlt: 'avatar',
  youFallback: 'Tú',
  verified: 'Verificado',
  emailUnverified: 'Correo electrónico sin verificar',
  completenessLabel: 'Completitud del perfil: {{percent}}',
  upload: 'Subir',

  // Details fields
  details: 'Detalles',
  yourName: 'Tu nombre',
  yourNamePlaceholder: 'p. ej. Jordan Rivera',
  jobTitleLabel: 'Puesto',
  jobTitlePlaceholder: 'Ingeniero de plantilla',
  departmentLabel: 'Departamento',
  departmentPlaceholder: 'Plataforma',
  bioLabel: 'Biografía',
  bioPlaceholder: 'Una breve biografía…',
  equipmentLabel: 'Equipo (separado por comas)',
  equipmentPlaceholder: 'portátil, cámara',
  interestsLabel: 'Intereses (separados por comas)',
  interestsPlaceholder: 'protocolos, sistemas distribuidos',
  timezoneLabel: 'Zona horaria',
  timezonePlaceholder: 'America/New_York',
  hoursLabel: 'Horas / semana',
  hoursPlaceholder: '40',
  availabilityLabel: 'Disponibilidad',
  availabilityNone: '—',
  saveDetails: 'Guardar detalles',

  // Skills card
  skills: 'Aptitudes',
  skillsHint: 'Las recomendaciones de tus compañeros se conservan cuando editas una aptitud que mantienes.',
  skillPlaceholder: 'Aptitud',
  removeSkillLabel: 'Eliminar la aptitud {{name}}',
  endorsedCount: '{{count}} recomendaciones',
  addSkill: 'Añadir aptitud',
  saveSkills: 'Guardar aptitudes',

  // Board intro (rich — numbered <0><1><2> are <strong> spans)
  boardIntro: '<0>Tu tablero.</0> El trabajo nuevo llega a <1>Por hacer</1>. <2>Arrastra una tarjeta</2> entre carriles para hacerla avanzar; soltar una tarjeta en un carril de disparo ejecuta su flujo de trabajo en tu nombre.',
  loadingBoard: 'Cargando tu tablero…',

  // ── Toasts (My Profile) ───────────────────────────────────────────────
  hoursRangeError: 'Horas / semana debe ser un número entre 0 y 168.',
  profileSaved: 'Perfil guardado.',
  saveFailed: 'Error al guardar.',
  skillsSaved: 'Aptitudes guardadas.',
  saveSkillsFailed: 'Error al guardar las aptitudes.',
  avatarMustBeImage: 'El avatar debe ser una imagen.',
  avatarUpdated: 'Avatar actualizado.',
  avatarUploadFailed: 'Error al subir el avatar.',
  avatarRemoved: 'Avatar eliminado.',
  avatarRemoveFailed: 'No se pudo eliminar el avatar.',

  // ── Activity tab ──────────────────────────────────────────────────────
  loadingActivity: 'Cargando actividad…',
  noActivityTitle: 'Aún no hay actividad',
  noActivityBody: 'Ejecuta un flujo de trabajo desde Mi tablero o una programación, y tu actividad —con resultados y marcas de tiempo— aparecerá aquí.',
  sourceHeartbeat: 'recogió una tarea',
  sourceSchedule: 'se ejecutó según una programación',
  sourceKanban: 'inició un flujo de trabajo desde una tarjeta',
  sourceApproval: 'ejecutó una propuesta aprobada',
  activityLine: 'Tú {{source}} · ',
  ranIn: ' · se ejecutó en {{duration}}',
  chained: 'encadenado',
  chainedTitle: 'Causado por un disparador anterior',
  viewRun: 'ver ejecución',
  runStatusTitle: 'Ejecución {{status}}',
  truncatedNote: 'Mostrando tu actividad más reciente. Puede que existan ejecuciones más antiguas más allá de este intervalo.',

  // Status chips
  statusCompleted: 'Completado',
  statusFailed: 'Fallido',
  statusRunning: 'En ejecución',
  statusSuspended: 'Suspendido',

  // ── Workflows tab ─────────────────────────────────────────────────────
  workflowStarted: 'Iniciado {{name}} · ',
  viewRunAction: 'Ver ejecución',
  noWorkflowsTitle: 'Aún no hay flujos de trabajo asignados',
  noWorkflowsBody: 'Asigna uno desde la biblioteca de abajo para crear tu cartera: el trabajo que tú (o tu asistente) ejecutáis.',
  workflowsPortfolioLead: 'Tu cartera de flujos de trabajo: el trabajo que posees. Cada tarjeta explica qué hace; ejecútalo ahora o suelta una tarjeta en un carril de disparo de <0>Mi tablero</0> para activarlo.',
  localWorkflowPurpose: 'Flujo de trabajo local: asignado a ti.',
  localOnlyWarning: 'Solo local: regístralo en el host antes de que pueda ejecutarse desde un tablero o una programación.',
  running: 'Ejecutando…',
  runNow: 'Ejecutar ahora',
  unassign: 'Desasignar',
  assignAWorkflow: 'Asignar un flujo de trabajo',
  workflowToAssignLabel: 'Flujo de trabajo a asignar',
  chooseWorkflow: 'Elige un flujo de trabajo de la biblioteca…',
  assignWorkflow: 'Asignar flujo de trabajo',
  createFromTemplate: 'Crear desde plantilla',

  // ── Schedules tab ─────────────────────────────────────────────────────
  schedulesEmptyBody: 'Crea una abajo para ejecutar un flujo de trabajo de tu cartera con una cadencia.',
  schedulesHelper: 'Cadencia mostrada en {{tz}}. Las programaciones se disparan automáticamente con esta cadencia (un demonio en segundo plano), o de inmediato con «Ejecutar ahora».',
  schedulesNoWorkflowsHint: 'Primero asigna un flujo de trabajo en la pestaña <0>Flujos de trabajo asignados</0> y luego prográmalo aquí.',

  // ── Team directory page ───────────────────────────────────────────────
  teamEyebrow: 'Plataforma',
  teamTitle: 'Directorio del equipo',
  teamLede: 'El perfil de todos en este inquilino. Recomienda la aptitud de un compañero.',
  loadDirectoryFailed: 'No se pudo cargar el directorio.',
  endorsementFailed: 'La recomendación falló.',
  unnamedTeammate: 'Compañero sin nombre',

  // Toolbar
  searchPlaceholder: 'Buscar por nombre, rol, aptitud…',
  searchAriaLabel: 'Buscar en el directorio del equipo',
  countFiltered: '{{shown}} de {{total}}',
  countPeople_one: 'persona',
  countPeople_other: 'personas',

  // States
  noProfilesTitle: 'Aún no hay perfiles',
  noProfilesBody: 'Los perfiles aparecen aquí a medida que tus compañeros los completan.',
  noMatchesTitle: 'Sin coincidencias',
  noMatchesBody: 'Nadie coincide con «{{query}}». Prueba con otro nombre, rol o aptitud.',

  // Availability labels
  availabilityAvailable: 'Disponible',
  availabilityBusy: 'Ocupado',
  availabilityAway: 'Ausente',

  // Card chips & meta
  emailVerifiedTitle: 'Correo electrónico verificado',
  youChip: 'Tú',
  hoursPerWeek: ' · {{hours}} h/sem',
  emptyProfileSelf: 'Aún no has completado tu perfil.',
  emptyProfileOther: 'Aún no ha completado su perfil.',
  interestsPrefix: 'Intereses: {{list}}',

  // Skill endorse affordance
  cannotEndorseOwn: 'No puedes recomendar tu propia aptitud',
  removeEndorsement: 'Eliminar tu recomendación',
  endorseSkill: 'Recomendar esta aptitud',

  // Self footer
  completenessAria: 'Completitud de tu perfil',
  editProfile: 'Editar perfil',
} as const;
