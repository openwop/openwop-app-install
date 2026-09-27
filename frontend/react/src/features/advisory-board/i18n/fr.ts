/**
 * `advisory-board` namespace — user-facing copy for the Board of Advisors feature
 * (ADR 0040). Feature-self-contained: every advisory-board string lives here.
 * Generic actions/states are reused from the `common` namespace via `t('common:…')`
 * and are NOT duplicated.
 */
export const messages = {
  // Gating
  notEnabledTitle: 'Le comité consultatif n’est pas activé',
  notEnabledBody: 'Activez la fonctionnalité Comité consultatif pour cet espace de travail afin de réunir des conseils de conseillers.',

  // Page chrome
  eyebrow: 'Agents',
  title: 'Comité consultatif',
  lede: 'Réunissez un conseil de conseillers — puis convoquez-le dans le chat IA en saisissant son @@identifiant.',

  // Convene hint (rich)
  boardsEmptyTitle: 'Aucun comité pour le moment',
  boardsEmptyBody: 'Créez votre premier comité consultatif ci-dessus.',

  // Collection-view filterbar (§4.5 rule 11)
  filterGroup: 'Filtrer les comités',
  filterPlaceholder: 'Filtrer les comités…',
  filterAria: 'Filtrer les comités par nom ou identifiant',
  noMatchTitle: 'Aucun comité correspondant',
  noMatchBody: 'Aucun comité ne correspond à votre recherche. Essayez un autre terme.',
  clearSearch: 'Effacer la recherche',
  advisorsCount_one: '{{count}} conseiller',
  advisorsCount_other: '{{count}} conseillers',
  strategyContextCount_one: '{{count}} stratégie',
  strategyContextCount_other: '{{count}} stratégies',
  deleteBoardLabel: 'Supprimer {{name}}',
  confirmDeleteTitle: 'Supprimer {{name}} ?',
  confirmDeleteBody: 'Cela supprime le comité et libère son @@handle. Les agents conseillers restent dans votre liste — seul ce regroupement est supprimé. Cette action est irréversible.',

  // Strategy context picker (ADR 0076 Phase 5)
  strategyContextLabel: 'Contexte stratégique',
  planningContextLabel: 'Contexte de planification',
  planningContextHint: 'Donnez aux conseillers vos stratégies et projets comme contexte de planification — un instantané des objectifs, statuts et jalons pris à l’ouverture ou à la convocation du chat du conseil. Pour une recherche documentaire en direct à chaque tour, utilisez la section « Connaissances partagées » lors de la modification d’un conseil.',
  projectContextLabel: 'Contexte de projet',
  projectContextCount_one: '{{count}} projet',
  projectContextCount_other: '{{count}} projets',

  // Create form — no roster
  noAdvisorsTitle: 'Aucun conseiller pour le moment',
  noAdvisorsBody: 'Ajoutez d’abord des agents à votre liste — les conseillers sont des agents de la liste dotés de leur propre persona et de leurs propres connaissances.',

  // Create form
  newBoard: 'Nouveau comité',
  boardNameLabel: 'Nom du comité',
  boardNamePlaceholder: 'Comité des fondateurs',
  organizationLabel: 'Organisation',
  visibilityLabel: 'Visibilité',
  // ADR 0665 D3 — was "Private (only me)", which the access rule does not deliver:
  // `resolveBoardAccess` grants an org `workspace:write` holder authority over the
  // board SUBJECT regardless of visibility — the documented cross-feature
  // "visibility is not authority" rule (ADR 0054 D5), which projects implement
  // identically. The rule is unchanged; the promise now matches it, in the wording
  // `features/projects/i18n` already ships for the same rule.
  visibilityPrivate: 'Privé',
  visibilityPrivateHelp: "Vous seul et les personnes disposant d'un accès en écriture à l'espace de travail pouvez voir ce conseil : ses conseillers et la transcription de la salle.",
  visibilityShared: 'Partagé (espace de travail)',
  personaKindLabel: 'Type de persona',
  advisorsLabel: 'Conseillers',
  livingPersonaAck: 'Je reconnais qu’il s’agit de personas simulés de personnes vivantes, à des fins d’idéation uniquement — ce ne sont pas les vraies personnes, et elles ne sont pas approuvées par elles.',
  createBoard: 'Créer le comité',
  editBoard: 'Modifier le comité',
  saveChanges: 'Enregistrer les modifications',
  openingChatAction: 'Ouverture…',
  openChatAction: 'Ouvrir le chat',
  openBoardChatLabel: 'Ouvrir le chat du conseil {{name}}',
  openChatError: 'Impossible d’ouvrir le chat du conseil.',
  editAction: 'Modifier',
  cloneAction: 'Cloner',
  editBoardLabel: 'Modifier {{name}}',
  cloneBoardLabel: 'Cloner {{name}}',
  cloneNameSuffix: '{{name}} (copie)',

  // Persona kinds
  personaHistorical: 'Figures historiques / du domaine public',
  personaFictional: 'Personnages fictifs',
  personaOriginal: 'Personas originaux',
  personaLiving: 'Personnes vivantes (nécessite une reconnaissance)',
  sharedKnowledgeLabel: 'Connaissances partagées',
  sharedKnowledgeHint: 'Donnez à chaque conseiller de ce conseil un accès en récupération à ces bases de connaissances — interrogées en direct à chaque tour, pour des réponses toujours à jour.',
  sharedKnowledgeLoadFailed: 'Impossible de charger les paramètres de connaissances partagées. Rouvrez le conseil pour réessayer.',
  sharedKnowledgeOnTitle: 'Tous les conseillers peuvent récupérer {{kind}} — cliquez pour arrêter le partage',
  sharedKnowledgeOffTitle: 'Donner à tous les conseillers l’accès à {{kind}}',
  sharedKnowledgeEmptyTitle: 'Aucune {{kind}} à partager pour l’instant — ajoutez des connaissances à un projet pour les partager avec ce conseil',
  sharedKind_strategy: 'KB Stratégie',
  'sharedKind_priority-matrix': 'KB Matrice de priorités',
  sharedKind_project: 'KB de projets',
  'sharedKind_team-portfolio': 'KB portfolio d’équipe',
  contextLoadFailed: "Les stratégies et les projets n'ont pas pu être chargés : aucun contexte de planification ne peut être rattaché à ce comité pour l'instant. Le contexte déjà enregistré reste inchangé.",
  dialogErrorAnnounce: "L’enregistrement a échoué. La raison est affichée dans la boîte de dialogue.",
  deleteErrorAnnounce: "La suppression a échoué. La raison est affichée dans la boîte de dialogue.",
  moderatorLabel: "Président (fait la synthèse)",
  moderatorHint: "Le président conclut. Sans président, le premier conseiller à parler rédige aussi la recommandation — une partie qui juge le différend.",
  moderatorNone: "Aucun président — le premier conseiller fait la synthèse",
  moderatorOutOfCohort: "{{persona}} — préside, hors de ce collège",
  boardContextStaleBody: "Nous n’avons pas pu actualiser l’enregistrement des plans transmis à ce conseil : il est donc périmé. Vos conseillers restent ancrés dans les plans que vous pouvez lire, vérifiés à chaque tour.",
  boardContextStaleOpen: "Ouvrir le conseil quand même",
} as const;
