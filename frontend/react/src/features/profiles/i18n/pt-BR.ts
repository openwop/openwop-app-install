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
  title: 'Meu perfil',
  lede: 'Seu perfil de autoatendimento. Visível para sua equipe no diretório.',
  loadProfileFailed: 'Falha ao carregar seu perfil.',
  loadBoardFailed: 'Falha ao carregar seu quadro.',

  // Tabs
  tabProfile: 'Perfil',
  tabBoard: 'Meu quadro',
  tabWorkflows: 'Workflows atribuídos',
  tabSchedules: 'Agendamentos',
  tabActivity: 'Atividade',
  tabConnections: 'Conexões',
  tabMemory: 'Memória',
  tabKnowledge: 'Conhecimento',
  tabTwin: 'Quem pode recordar minha memória',

  // Identity card
  avatarAlt: 'avatar',
  youFallback: 'Você',
  verified: 'Verificado',
  emailUnverified: 'E-mail não verificado',
  completenessLabel: 'Completude do perfil: {{percent}}',
  upload: 'Enviar',

  // Details fields
  details: 'Detalhes',
  yourName: 'Seu nome',
  yourNamePlaceholder: 'ex.: Jordan Rivera',
  jobTitleLabel: 'Cargo',
  jobTitlePlaceholder: 'Engenheiro(a) Sênior',
  departmentLabel: 'Departamento',
  departmentPlaceholder: 'Plataforma',
  bioLabel: 'Bio',
  bioPlaceholder: 'Uma bio curta…',
  equipmentLabel: 'Equipamentos (separados por vírgula)',
  equipmentPlaceholder: 'notebook, câmera',
  interestsLabel: 'Interesses (separados por vírgula)',
  interestsPlaceholder: 'protocolos, sistemas distribuídos',
  timezoneLabel: 'Fuso horário',
  timezonePlaceholder: 'America/New_York',
  hoursLabel: 'Horas / semana',
  hoursPlaceholder: '40',
  availabilityLabel: 'Disponibilidade',
  availabilityNone: '—',
  saveDetails: 'Salvar detalhes',

  // Skills card
  skills: 'Habilidades',
  skillsHint: 'As recomendações de colegas são preservadas quando você edita uma habilidade que mantém.',
  skillPlaceholder: 'Habilidade',
  removeSkillLabel: 'Remover habilidade {{name}}',
  endorsedCount: '{{count}} recomendações',
  addSkill: 'Adicionar habilidade',
  saveSkills: 'Salvar habilidades',

  // Board intro (rich — numbered <0><1><2> are <strong> spans)
  boardIntro: '<0>Seu quadro.</0> Novos trabalhos chegam em <1>A fazer</1>. <2>Arraste um card</2> entre as raias para movê-lo adiante — soltar um card em uma raia de gatilho executa o workflow dele em seu nome.',
  loadingBoard: 'Carregando seu quadro…',

  // ── Toasts (My Profile) ───────────────────────────────────────────────
  hoursRangeError: 'Horas / semana deve ser um número entre 0 e 168.',
  profileSaved: 'Perfil salvo.',
  saveFailed: 'Falha ao salvar.',
  skillsSaved: 'Habilidades salvas.',
  saveSkillsFailed: 'Falha ao salvar as habilidades.',
  avatarMustBeImage: 'O avatar deve ser uma imagem.',
  avatarUpdated: 'Avatar atualizado.',
  avatarUploadFailed: 'Falha ao enviar o avatar.',
  avatarRemoved: 'Avatar removido.',
  avatarRemoveFailed: 'Não foi possível remover o avatar.',

  // ── Activity tab ──────────────────────────────────────────────────────
  loadingActivity: 'Carregando atividade…',
  noActivityTitle: 'Nenhuma atividade ainda',
  noActivityBody: 'Execute um workflow a partir de Meu quadro ou de um agendamento, e sua atividade — com resultados e marcações de tempo — aparecerá aqui.',
  sourceHeartbeat: 'assumiu uma tarefa',
  sourceSchedule: 'executou em um agendamento',
  sourceKanban: 'iniciou um workflow a partir de um card',
  sourceApproval: 'executou uma proposta aprovada',
  activityLine: 'Você {{source}} · ',
  ranIn: ' · executado em {{duration}}',
  chained: 'encadeado',
  chainedTitle: 'Causado por um gatilho anterior',
  viewRun: 'ver execução',
  runStatusTitle: 'Execução {{status}}',
  truncatedNote: 'Mostrando sua atividade mais recente. Execuções mais antigas podem existir além desta janela.',

  // Status chips
  statusCompleted: 'Concluída',
  statusFailed: 'Falhou',
  statusRunning: 'Em execução',
  statusSuspended: 'Suspensa',

  // ── Workflows tab ─────────────────────────────────────────────────────
  workflowStarted: 'Iniciado {{name}} · ',
  viewRunAction: 'Ver execução',
  noWorkflowsTitle: 'Nenhum workflow atribuído ainda',
  noWorkflowsBody: 'Atribua um da biblioteca abaixo para montar seu portfólio — o trabalho que você (ou seu assistente) executa.',
  workflowsPortfolioLead: 'Seu portfólio de workflows — o trabalho que você possui. Cada card explica o que ele faz; execute-o agora ou solte um card em uma raia de gatilho em <0>Meu quadro</0> para dispará-lo.',
  localWorkflowPurpose: 'Workflow local — atribuído a você.',
  localOnlyWarning: 'Somente local — registre no host antes que ele possa ser executado por um quadro ou agendamento.',
  running: 'Executando…',
  runNow: 'Executar agora',
  unassign: 'Desatribuir',
  assignAWorkflow: 'Atribuir um workflow',
  workflowToAssignLabel: 'Workflow a atribuir',
  chooseWorkflow: 'Escolha um workflow da biblioteca…',
  assignWorkflow: 'Atribuir workflow',
  createFromTemplate: 'Criar a partir de modelo',

  // ── Schedules tab ─────────────────────────────────────────────────────
  schedulesEmptyBody: 'Crie um abaixo para executar um workflow do seu portfólio em uma cadência.',
  schedulesHelper: 'Cadência exibida em {{tz}}. Os agendamentos disparam automaticamente nesta cadência (um daemon em segundo plano) ou imediatamente com “Executar agora”.',
  schedulesNoWorkflowsHint: 'Atribua um workflow na aba <0>Workflows atribuídos</0> primeiro e depois agende-o aqui.',

  // ── Team directory page ───────────────────────────────────────────────
  teamEyebrow: 'Plataforma',
  teamTitle: 'Diretório da equipe',
  teamLede: 'O perfil de todos neste tenant. Recomende a habilidade de um colega.',
  loadDirectoryFailed: 'Falha ao carregar o diretório.',
  endorsementFailed: 'Falha na recomendação.',
  unnamedTeammate: 'Colega sem nome',

  // Toolbar
  searchPlaceholder: 'Pesquisar por nome, função, habilidade…',
  searchAriaLabel: 'Pesquisar no diretório da equipe',
  countFiltered: '{{shown}} de {{total}}',
  countPeople_one: 'pessoa',
  countPeople_other: 'pessoas',

  // States
  noProfilesTitle: 'Nenhum perfil ainda',
  noProfilesBody: 'Os perfis aparecem aqui à medida que os colegas os preenchem.',
  noMatchesTitle: 'Nenhuma correspondência',
  noMatchesBody: 'Ninguém corresponde a "{{query}}". Tente um nome, função ou habilidade diferente.',

  // Availability labels
  availabilityAvailable: 'Disponível',
  availabilityBusy: 'Ocupado',
  availabilityAway: 'Ausente',

  // Card chips & meta
  emailVerifiedTitle: 'E-mail verificado',
  youChip: 'Você',
  hoursPerWeek: ' · {{hours}}h/sem',
  emptyProfileSelf: 'Você ainda não preencheu seu perfil.',
  emptyProfileOther: 'Ainda não preencheu o perfil.',
  interestsPrefix: 'Interesses: {{list}}',

  // Skill endorse affordance
  cannotEndorseOwn: 'Você não pode recomendar sua própria habilidade',
  removeEndorsement: 'Remover sua recomendação',
  endorseSkill: 'Recomendar esta habilidade',

  // Self footer
  completenessAria: 'Completude do seu perfil',
  editProfile: 'Editar perfil',
} as const;
