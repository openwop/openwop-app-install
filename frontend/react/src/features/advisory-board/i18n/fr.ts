/**
 * `advisory-board` namespace — user-facing copy for the Board of Advisors feature
 * (ADR 0040). Feature-self-contained: every advisory-board string lives here.
 * Generic actions/states are reused from the `common` namespace via `t('common:…')`
 * and are NOT duplicated.
 */
export const messages = {
  // Gating
  notEnabledTitle: 'Le comité consultatif n\'est pas activé',
  notEnabledBody: 'Activez la fonctionnalité Comité consultatif pour cet espace de travail afin de réunir des conseils de conseillers.',

  // Page chrome
  eyebrow: 'Agents',
  title: 'Comité consultatif',
  lede: 'Réunissez un conseil de conseillers — puis convoquez-le dans le chat IA en saisissant son @@identifiant.',

  // Convene hint (rich)
  conveneHint: 'Pour convoquer un comité, ouvrez le chat IA et saisissez son <1>@@identifiant</1> (par ex. <3>@@timeless que devrions-nous prioriser ?</3>). Chaque conseiller rejoint les Agents actifs du chat et le conseil y donne son avis.',

  // Board list
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
  planningContextHint: 'Donnez aux conseillers vos stratégies et projets comme contexte de planification — leurs objectifs, statut et jalons. Pour une recherche documentaire approfondie, utilisez les bascules « Connaissances partagées » sur une carte de conseil.',
  projectContextLabel: 'Contexte de projet',
  projectContextCount_one: '{{count}} projet',
  projectContextCount_other: '{{count}} projets',

  // Create form — no roster
  noAdvisorsTitle: 'Aucun conseiller pour le moment',
  noAdvisorsBody: 'Ajoutez d\'abord des agents à votre liste — les conseillers sont des agents de la liste dotés de leur propre persona et de leurs propres connaissances.',

  // Create form
  newBoard: 'Nouveau comité',
  boardNameLabel: 'Nom du comité',
  boardNamePlaceholder: 'Comité des fondateurs',
  organizationLabel: 'Organisation',
  visibilityLabel: 'Visibilité',
  visibilityPrivate: 'Privé (seulement moi)',
  visibilityShared: 'Partagé (espace de travail)',
  personaKindLabel: 'Type de persona',
  advisorsLabel: 'Conseillers',
  livingPersonaAck: 'Je reconnais qu\'il s\'agit de personas simulés de personnes vivantes, à des fins d\'idéation uniquement — ce ne sont pas les vraies personnes, et elles ne sont pas approuvées par elles.',
  createBoard: 'Créer le comité',
  editBoard: 'Modifier le comité',
  saveChanges: 'Enregistrer les modifications',
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
  sharedKnowledgeLabel: 'Connaissances partagées :',
  sharedKnowledgeOnTitle: 'Tous les conseillers peuvent récupérer {{kind}} — cliquez pour arrêter le partage',
  sharedKnowledgeOffTitle: 'Donner à tous les conseillers l\'accès à {{kind}}',
  sharedKnowledgeEmptyTitle: 'Aucune {{kind}} à partager pour l\'instant — ajoutez des connaissances à un projet pour les partager avec ce conseil',
  sharedKind_strategy: 'KB Stratégie',
  'sharedKind_priority-matrix': 'KB Matrice de priorités',
  sharedKind_project: 'KB de projets',
} as const;
