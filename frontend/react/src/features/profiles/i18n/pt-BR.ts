/**
 * `profiles` namespace — user-facing copy for the Profiles feature (My Profile,
 * Team directory, and the profile tabs — ADR 0005 / ADR 0025).
 * Feature-self-contained: every profiles string lives here. Generic actions/
 * states are reused from the `common` namespace via `t('common:…')` and are NOT
 * duplicated. Plural keys use i18next `_one`/`_other` suffixes.
 */
export const messages = {
  directoryFailedTitle: 'Não foi possível carregar o diretório da equipe',
  directoryFailedBody: 'É uma leitura com falha, não um diretório vazio: não significa que seus colegas não tenham perfis.',
  directoryRetry: 'Tentar novamente',
  // ── My Profile page chrome ────────────────────────────────────────────
  eyebrow: 'Plataforma',
  title: 'Meu perfil',
  lede: 'Seu perfil de autoatendimento. Visível para sua equipe no diretório.',
  profileFailedTitle: 'Não foi possível carregar seu perfil',
  profileFailedBody: 'É uma leitura com falha: seu perfil continua intacto no servidor.',
  boardFailedTitle: 'Não foi possível carregar seu quadro',
  boardFailedBody: 'É uma leitura com falha, não um quadro vazio.',
  activityFailedTitle: 'Não foi possível carregar sua atividade',
  activityFailedBody: 'É uma leitura com falha, não um histórico vazio: não significa que você não tenha atividade.',
  retry: 'Tentar novamente',

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
  uploading: 'Enviando…',

  // Portfolio (PROF-UX-4)
  portfolioTitle: 'Portfólio',
  portfolioHint: 'Imagens do seu trabalho exibidas no seu card do diretório da equipe.',
  portfolioEmpty: 'Nenhuma imagem no portfólio ainda. Adicione uma para mostrar seu trabalho.',
  addPortfolioImage: 'Adicionar imagem',
  removePortfolioImageN: 'Remover a imagem {{index}} do portfólio',
  portfolioImageAlt: 'Imagem do portfólio',
  portfolioImageUnavailable: 'Imagem indisponível',
  portfolioAdded: 'Imagem adicionada ao portfólio.',
  portfolioAddFailed: 'Não foi possível adicionar a imagem ao portfólio.',
  portfolioRemoved: 'Imagem removida do portfólio.',
  portfolioRemoveFailed: 'Não foi possível remover a imagem do portfólio.',

  // Details fields
  details: 'Detalhes',
  yourName: 'Seu nome',
  yourNamePlaceholder: 'ex.: Jordan Rivera',
  preferredNameLabel: 'Nome preferido',
  preferredNamePlaceholder: 'ex.: David',
  preferredNameHint: 'Como os agentes devem chamar você. Padrão: seu primeiro nome.',
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
  skillNameAria: 'Nome da habilidade',
  proficiencyAria: 'Nível de proficiência (1–5)',
  proficiencyLevel1: '1 — Iniciante',
  proficiencyLevel2: '2 — Em desenvolvimento',
  proficiencyLevel3: '3 — Proficiente',
  proficiencyLevel4: '4 — Avançado',
  proficiencyLevel5: '5 — Especialista',
  removeSkillLabel: 'Remover habilidade {{name}}',
  endorsedCount: '{{count}} recomendações',
  addSkill: 'Adicionar habilidade',
  saveSkills: 'Salvar habilidades',

  // Board intro (rich — numbered <0><1><2> are <strong> spans)
  boardIntro: '<0>Seu quadro.</0> Novos trabalhos chegam em <1>A fazer</1>. <2>Arraste um card</2> entre as raias para movê-lo adiante — soltar um card em uma raia de gatilho executa o workflow dele em seu nome.',

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
  filterGroup: 'Filtrar o diretório da equipe',
  filterDepartmentAria: 'Filtrar por departamento',
  allDepartments: 'Todos os departamentos',
  clearFilters: 'Limpar filtros',
  countFiltered: '{{shown}} de {{total}}',
  countPeople_one: 'pessoa',
  countPeople_other: 'pessoas',

  // States
  noProfilesTitle: 'Nenhum perfil ainda',
  noProfilesBody: 'Os perfis aparecem aqui à medida que os colegas os preenchem.',
  noMatchesTitle: 'Nenhuma correspondência',
  noMatchesBody: 'Ninguém corresponde a "{{query}}". Tente um nome, função ou habilidade diferente.',
  noMatchesBodyGeneric: 'Ninguém corresponde aos filtros atuais.',

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
  endorseIdentityUnknown: 'Recomendar está indisponível — não foi possível confirmar qual perfil é o seu',
  removeEndorsement: 'Remover sua recomendação',
  endorseSkill: 'Recomendar esta habilidade',

  // Self footer
  completenessAria: 'Completude do seu perfil',
  editProfile: 'Editar perfil',
  actionFailed: 'Algo deu errado. Tente novamente.',

  // ── Feature loop 2026-09 it.3 (PROF-UX-8 / 13 / 14 / 15) ─────────────
  profileTabsAria: 'Seções do perfil',
  portfolioMustBeImage: 'A imagem do portfólio deve ser uma imagem.',
  imageTooLarge: 'Essa imagem é muito grande (máx. {{mib}} MiB).',
  workflowAssigned: 'Workflow atribuído.',
  workflowUnassigned: 'Workflow desatribuído.',
  completenessNext: 'Próximo passo: adicione {{items}}',
  fieldAvatar: 'Avatar',
  fieldEquipment: 'Equipamentos',
  fieldInterests: 'Interesses',
} as const;
