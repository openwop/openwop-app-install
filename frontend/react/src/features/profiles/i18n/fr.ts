/**
 * `profiles` namespace — French (fr) user-facing copy for the Profiles feature
 * (My Profile, Team directory, and the profile tabs — ADR 0005 / ADR 0025).
 * Feature-self-contained: every profiles string lives here. Generic actions/
 * states are reused from the `common` namespace via `t('common:…')` and are NOT
 * duplicated. Plural keys use i18next `_one`/`_other` suffixes.
 */
export const messages = {
  directoryFailedTitle: "Impossible de charger l'annuaire de l'équipe",
  directoryFailedBody: "Il s'agit d'une lecture en échec, pas d'un annuaire vide : cela ne signifie pas que vos collègues n'ont pas de profil.",
  directoryRetry: 'Réessayer',
  // ── My Profile page chrome ────────────────────────────────────────────
  eyebrow: 'Plateforme',
  title: 'Mon profil',
  lede: 'Votre profil en libre-service. Visible par votre équipe dans l’annuaire.',
  profileFailedTitle: 'Impossible de charger votre profil',
  profileFailedBody: "Il s'agit d'une lecture en échec : votre profil est intact sur le serveur.",
  boardFailedTitle: 'Impossible de charger votre tableau',
  boardFailedBody: "Il s'agit d'une lecture en échec, pas d'un tableau vide.",
  activityFailedTitle: 'Impossible de charger votre activité',
  activityFailedBody: "Il s'agit d'une lecture en échec, pas d'un flux vide : cela ne signifie pas que vous n'avez aucune activité.",
  retry: 'Réessayer',

  // Tabs
  tabProfile: 'Profil',
  tabBoard: 'Mon tableau',
  tabWorkflows: 'Workflows assignés',
  tabSchedules: 'Planifications',
  tabActivity: 'Activité',
  tabConnections: 'Connexions',
  tabMemory: 'Mémoire',
  tabKnowledge: 'Connaissances',
  tabTwin: 'Qui peut consulter ma mémoire',

  // Identity card
  avatarAlt: 'avatar',
  youFallback: 'Vous',
  verified: 'Vérifié',
  emailUnverified: 'E-mail non vérifié',
  completenessLabel: 'Complétude du profil : {{percent}}',
  upload: 'Téléverser',
  uploading: 'Téléversement…',

  // Portfolio (PROF-UX-4)
  portfolioTitle: 'Portfolio',
  portfolioHint: 'Images de vos travaux affichées sur votre carte dans l’annuaire de l’équipe.',
  portfolioEmpty: 'Aucune image dans le portfolio pour le moment. Ajoutez-en une pour montrer votre travail.',
  addPortfolioImage: 'Ajouter une image',
  removePortfolioImageN: 'Supprimer l’image {{index}} du portfolio',
  portfolioImageAlt: 'Image du portfolio',
  portfolioImageUnavailable: 'Image indisponible',
  portfolioAdded: 'Image ajoutée au portfolio.',
  portfolioAddFailed: 'Impossible d’ajouter l’image au portfolio.',
  portfolioRemoved: 'Image supprimée du portfolio.',
  portfolioRemoveFailed: 'Impossible de supprimer l’image du portfolio.',

  // Details fields
  details: 'Détails',
  yourName: 'Votre nom',
  yourNamePlaceholder: 'p. ex. Jordan Rivera',
  preferredNameLabel: 'Nom préféré',
  preferredNamePlaceholder: 'p. ex. David',
  preferredNameHint: 'Le nom que les agents doivent utiliser. Par défaut, votre prénom.',
  jobTitleLabel: 'Intitulé de poste',
  jobTitlePlaceholder: 'Ingénieur principal',
  departmentLabel: 'Service',
  departmentPlaceholder: 'Plateforme',
  bioLabel: 'Biographie',
  bioPlaceholder: 'Une courte biographie…',
  equipmentLabel: 'Équipement (séparé par des virgules)',
  equipmentPlaceholder: 'ordinateur portable, caméra',
  interestsLabel: 'Centres d’intérêt (séparés par des virgules)',
  interestsPlaceholder: 'protocoles, systèmes distribués',
  timezoneLabel: 'Fuseau horaire',
  timezonePlaceholder: 'America/New_York',
  hoursLabel: 'Heures / semaine',
  hoursPlaceholder: '40',
  availabilityLabel: 'Disponibilité',
  availabilityNone: '—',
  saveDetails: 'Enregistrer les détails',

  // Skills card
  skills: 'Compétences',
  skillsHint: 'Les recommandations de vos collègues sont conservées lorsque vous modifiez une compétence que vous gardez.',
  skillPlaceholder: 'Compétence',
  skillNameAria: 'Nom de la compétence',
  proficiencyAria: 'Niveau de maîtrise (1–5)',
  proficiencyLevel1: '1 — Débutant',
  proficiencyLevel2: '2 — En progression',
  proficiencyLevel3: '3 — Compétent',
  proficiencyLevel4: '4 — Avancé',
  proficiencyLevel5: '5 — Expert',
  removeSkillLabel: 'Supprimer la compétence {{name}}',
  endorsedCount: '{{count}} recommandation(s)',
  addSkill: 'Ajouter une compétence',
  saveSkills: 'Enregistrer les compétences',

  // Board intro (rich — numbered <0><1><2> are <strong> spans)
  boardIntro: '<0>Votre tableau.</0> Les nouvelles tâches arrivent dans <1>À faire</1>. <2>Faites glisser une carte</2> entre les voies pour la faire avancer — déposer une carte dans une voie de déclenchement exécute son workflow en votre nom.',

  // ── Toasts (My Profile) ───────────────────────────────────────────────
  hoursRangeError: 'Heures / semaine doit être un nombre compris entre 0 et 168.',
  profileSaved: 'Profil enregistré.',
  saveFailed: 'L’enregistrement a échoué.',
  skillsSaved: 'Compétences enregistrées.',
  saveSkillsFailed: 'L’enregistrement des compétences a échoué.',
  avatarMustBeImage: 'L’avatar doit être une image.',
  avatarUpdated: 'Avatar mis à jour.',
  avatarUploadFailed: 'Le téléversement de l’avatar a échoué.',
  avatarRemoved: 'Avatar supprimé.',
  avatarRemoveFailed: 'Impossible de supprimer l’avatar.',

  // ── Activity tab ──────────────────────────────────────────────────────
  noActivityTitle: 'Aucune activité pour le moment',
  noActivityBody: 'Exécutez un workflow depuis Mon tableau ou une planification, et votre activité — avec les résultats et les horodatages — apparaîtra ici.',
  sourceHeartbeat: 'a pris en charge une tâche',
  sourceSchedule: 'a exécuté selon une planification',
  sourceKanban: 'a démarré un workflow depuis une carte',
  sourceApproval: 'a exécuté une proposition approuvée',
  activityLine: 'Vous {{source}} · ',
  ranIn: ' · exécuté en {{duration}}',
  chained: 'enchaîné',
  chainedTitle: 'Provoqué par un déclencheur en amont',
  viewRun: 'voir l’exécution',
  runStatusTitle: 'Exécution {{status}}',
  truncatedNote: 'Affichage de votre activité la plus récente. Des exécutions plus anciennes peuvent exister au-delà de cette fenêtre.',

  // Status chips
  statusCompleted: 'Terminé',
  statusFailed: 'Échoué',
  statusRunning: 'En cours',
  statusSuspended: 'Suspendu',

  // ── Workflows tab ─────────────────────────────────────────────────────
  workflowStarted: '{{name}} démarré · ',
  viewRunAction: 'Voir l’exécution',
  noWorkflowsTitle: 'Aucun workflow assigné pour le moment',
  noWorkflowsBody: 'Assignez-en un depuis la bibliothèque ci-dessous pour constituer votre portefeuille — le travail que vous (ou votre assistant) exécutez.',
  workflowsPortfolioLead: 'Votre portefeuille de workflows — le travail dont vous êtes responsable. Chaque carte explique ce qu’elle fait ; exécutez-la maintenant ou déposez une carte dans une voie de déclenchement de <0>Mon tableau</0> pour la lancer.',
  localWorkflowPurpose: 'Workflow local — assigné à vous.',
  localOnlyWarning: 'Local uniquement — enregistrez-le sur l’hôte avant qu’il puisse être exécuté depuis un tableau ou une planification.',
  running: 'Exécution…',
  runNow: 'Exécuter maintenant',
  unassign: 'Désassigner',
  assignAWorkflow: 'Assigner un workflow',
  workflowToAssignLabel: 'Workflow à assigner',
  chooseWorkflow: 'Choisissez un workflow dans la bibliothèque…',
  assignWorkflow: 'Assigner le workflow',
  createFromTemplate: 'Créer à partir d’un modèle',

  // ── Schedules tab ─────────────────────────────────────────────────────
  schedulesEmptyBody: 'Créez-en une ci-dessous pour exécuter un workflow de votre portefeuille selon une cadence.',
  schedulesHelper: 'Cadence affichée en {{tz}}. Les planifications se déclenchent automatiquement selon cette cadence (un démon en arrière-plan), ou immédiatement avec « Exécuter maintenant ».',
  schedulesNoWorkflowsHint: 'Assignez d’abord un workflow dans l’onglet <0>Workflows assignés</0>, puis planifiez-le ici.',

  // ── Team directory page ───────────────────────────────────────────────
  teamEyebrow: 'Plateforme',
  teamTitle: 'Annuaire de l’équipe',
  teamLede: 'Le profil de chacun dans ce locataire. Recommandez la compétence d’un collègue.',
  loadDirectoryFailed: 'Échec du chargement de l’annuaire.',
  endorsementFailed: 'La recommandation a échoué.',
  unnamedTeammate: 'Collègue sans nom',

  // Toolbar
  searchPlaceholder: 'Rechercher par nom, rôle, compétence…',
  searchAriaLabel: 'Rechercher dans l’annuaire de l’équipe',
  filterGroup: 'Filtrer l’annuaire de l’équipe',
  filterDepartmentAria: 'Filtrer par département',
  allDepartments: 'Tous les départements',
  clearFilters: 'Effacer les filtres',
  countFiltered: '{{shown}} sur {{total}}',
  countPeople_one: 'personne',
  countPeople_other: 'personnes',

  // States
  noProfilesTitle: 'Aucun profil pour le moment',
  noProfilesBody: 'Les profils apparaissent ici à mesure que vos collègues les remplissent.',
  noMatchesTitle: 'Aucun résultat',
  noMatchesBody: 'Personne ne correspond à « {{query}} ». Essayez un autre nom, rôle ou compétence.',
  noMatchesBodyGeneric: 'Personne ne correspond aux filtres actuels.',

  // Availability labels
  availabilityAvailable: 'Disponible',
  availabilityBusy: 'Occupé',
  availabilityAway: 'Absent',

  // Card chips & meta
  emailVerifiedTitle: 'E-mail vérifié',
  youChip: 'Vous',
  hoursPerWeek: ' · {{hours}} h/sem',
  emptyProfileSelf: 'Vous n’avez pas encore rempli votre profil.',
  emptyProfileOther: 'N’a pas encore rempli son profil.',
  interestsPrefix: 'Centres d’intérêt : {{list}}',

  // Skill endorse affordance
  cannotEndorseOwn: 'Vous ne pouvez pas recommander votre propre compétence',
  endorseIdentityUnknown: 'Recommander est indisponible — impossible de confirmer quel profil est le vôtre',
  removeEndorsement: 'Retirer votre recommandation',
  endorseSkill: 'Recommander cette compétence',

  // Self footer
  completenessAria: 'Complétude de votre profil',
  editProfile: 'Modifier le profil',
  actionFailed: 'Une erreur est survenue. Réessayez.',

  // ── Feature loop 2026-09 it.3 (PROF-UX-8 / 13 / 14 / 15) ─────────────
  profileTabsAria: 'Sections du profil',
  portfolioMustBeImage: 'L’image du portfolio doit être une image.',
  imageTooLarge: 'Cette image est trop volumineuse (max {{mib}} Mio).',
  workflowAssigned: 'Workflow assigné.',
  workflowUnassigned: 'Workflow désassigné.',
  completenessNext: 'Ensuite : ajoutez {{items}}',
  fieldAvatar: 'Avatar',
  fieldEquipment: 'Équipement',
  fieldInterests: 'Centres d’intérêt',
} as const;
