/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Les liens CRM appartiennent à une organisation',
  orgsFailedClause: 'La liste des entreprises n’a jamais été demandée',
  // Page chrome
  eyebrow: 'Activité',
  title: 'CSM',
  lede: 'Comptes de réussite client, état de santé le plus faible en premier.',
  askHealthInsights: 'Demander des insights de santé',
  healthInsightsSeed: 'Examinez mes comptes de réussite client et indiquez lesquels sont à risque et pourquoi. Lisez d’abord le registre des comptes, puis résumez les facteurs de santé et proposez les prochaines étapes.',

  // Gating / empty states
  notEnabledTitle: 'Le CSM n’est pas activé',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité CSM dans Admin → Bascules de fonctionnalités.',
  noAccountsTitle: 'Aucun compte pour l’instant',
  noAccountsBody: 'Ajoutez votre premier compte client avec le formulaire ci-dessus — l’état de santé le plus faible est trié en haut.',

  // Table
  captionAccounts: 'Comptes',
  colAccount: 'Compte',
  colHealth: 'État de santé',
  colArr: 'ARR',
  colOwner: 'Responsable',
  companiesLoadFailed: 'Les noms d’entreprise n’ont pas chargé',
  retryCompaniesLabel: 'Réessayer le chargement des noms d’entreprise',
  companyNameUnavailable: 'nom indisponible',
  fieldArrCurrency: 'Devise',
  arrCurrencyPlaceholder: 'USD',
  filterRenewalLabel: 'Filtrer par renouvellement',
  allRenewals: 'Tous les renouvellements',
  renewalFacetSoon: 'Renouvellement sous 90 jours',
  renewalFacetPast: 'En retard',
  scoreOutOfRange: 'Le score de santé doit être un nombre entre 0 et 100.',
  portfolioBandLabel: 'Synthèse du portefeuille',
  portfolioTotalArr: 'ARR total',
  portfolioArrAtRisk: 'ARR à risque',
  portfolioRenewals90: 'Renouvellements sous 90 jours',
  colRenewal: 'Renouvellement',
  renewalSoon: 'dans {{count}} j',
  renewalPast: 'Échue',
  colLinkedCompany: 'Entreprise liée',
  colFactors: 'Facteurs',
  notLinked: 'Non lié',
  factorsCount_one: '{{count}} facteur',
  factorsCount_other: '{{count}} facteurs',
  factorHeaderFactor: 'Facteur',
  factorHeaderWeight: 'Poids',
  factorHeaderValue: 'Valeur',
  computedStamp: 'calculé {{time}}',

  // aria-labels
  deleteRowLabel: 'Supprimer {{name}}',
  linkLabel: 'Lier {{name}} à une entreprise CRM',
  editLinkLabel: 'Modifier le lien CRM de {{name}}',

  // Panneau de liaison CRM
  linkCompany: 'Lier une entreprise',
  editLink: 'Modifier le lien',
  clearLink: 'Retirer le lien',
  linkPanelTitle: 'Lier « {{name}} » à une entreprise CRM',
  fieldCompany: 'Entreprise',
  selectOrgPlaceholder: 'Sélectionnez une organisation…',
  selectCompanyPlaceholder: 'Sélectionnez une entreprise…',
  linkSaved: 'Entreprise liée.',
  linkCleared: 'Lien retiré.',
  linkFailed: 'Échec de la mise à jour du lien CRM.',

  // Form field labels / placeholders
  fieldAccount: 'Compte',
  fieldHealth: 'État de santé (0–100)',
  fieldArr: 'ARR',
  fieldRenewal: 'Date de renouvellement',
  fieldOwner: 'Responsable',
  arrPlaceholder: 'Revenu récurrent annuel',
  accountNamePlaceholder: 'Nom du compte client',

  // Buttons
  addAccount: 'Ajouter un compte',

  // Toasts — success
  accountAdded: 'Compte ajouté.',

  // Toasts / errors
  loadAccountsFailed: 'Échec du chargement des comptes.',
  addFailed: 'Échec de l’ajout.',
  deleteFailed: 'Échec de la suppression.',
  updateFailed: 'Échec de la mise à jour.',
  arrInvalid: 'L’ARR doit être un nombre supérieur ou égal à 0.',
  deleteAccountConfirm: 'Supprimer le compte « {{name}} » ?',

  // ADR 0582 §6 — messages d’échec localisés (auparavant inatteignables).
  failureForbidden: 'Vous n’avez pas l’autorisation de faire cela ici.',
  failureNotFound: 'Ce compte n’est plus là.',
  failureRejected: 'Le portefeuille de comptes a refusé cette modification.',
  failureRateLimited: 'Trop de requêtes — patientez un instant puis réessayez.',
  failureServer: 'Le portefeuille de comptes est indisponible pour le moment.',
  failureOffline: 'Impossible de joindre le portefeuille de comptes.',
  loadFailedConsequence: 'Ce n’est pas un portefeuille vide : les comptes n’ont pas pu être lus.',
  staleClause: 'Ces chiffres sont les derniers chargés, pas les chiffres actuels.',

  // ADR 0582 §4/§6 — états de mesure
  healthUnscored: 'Non évalué',
  healthUnscoredHint: 'Aucune santé n’a encore été mesurée',
  companyGone: 'Entreprise absente du CRM',
  companyGoneHint: 'Elle a été fusionnée ou supprimée — reliez à nouveau ce compte pour continuer à mesurer.',
  healthFailedSince: 'En échec depuis le {{date}}',
  healthFailedRelink: 'Relier l’entreprise',
  healthMeasureFailed: 'Échec de la mesure',
  healthStalePrevious: 'dernière valeur connue {{score}}',
  healthOptionalPlaceholder: 'facultatif',
  fieldHealthHint: 'Laissez vide pour ajouter le compte sans évaluation.',
  fieldHealthEditHint: 'Videz le champ pour retirer le score et son détail.',
  portfolioUnmeasured: 'Santé non mesurée',
  portfolioUnmeasuredCount_one: '{{count}} compte',
  portfolioUnmeasuredCount_other: '{{count}} comptes',
  portfolioUnmeasuredArr: '{{arr}} exclus de l’ARR à risque',

  // ADR 0582 §5 — les deux formules, énoncées pour rendre le détail lisible
  'formula_penalty-sum': 'Score = 100 − somme de (poids × nombre). Plus le nombre est élevé, plus le score baisse.',
  'formula_weighted-mean': 'Score = somme de (poids × valeur) ÷ poids total. Plus la valeur est élevée, plus le score monte.',
  formulaUnstated: 'Ce détail a été enregistré sans formule indiquée.',
  // ADR 0582 §16 — les lignes de poids 0 sont des dénominateurs de couverture, pas des entrées.
  contextRowsNote: 'Les lignes dont le poids est 0 sont contextuelles et non comptabilisées : elles indiquent quelle part des données source a pu être rattachée à ce compte.',
  factorHeaderCount: 'Nombre',
  noBreakdown: 'Aucun détail',

  // Panneau d’édition (CSM-UX-5)
  editPanelTitle: 'Modifier « {{name}} »',
  editRowLabel: 'Modifier {{name}}',
  accountUpdated: 'Compte mis à jour.',
  accountDeleted: '« {{name}} » supprimé.',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtres',
  filterAccountsPlaceholder: 'Rechercher des comptes…',
  filterAccountsAria: 'Rechercher des comptes par nom ou responsable',
  filterHealthLabel: 'Filtrer par santé',
  allHealth: 'Tous les niveaux de santé',
  health_healthy: 'Sain (70+)',
  health_at_risk: 'À risque (40–69)',
  health_critical: 'Critique (moins de 40)',
  health_unscored: 'Non évalué',
  noMatchTitle: 'Aucun compte correspondant',
  noMatchBody: 'Aucun compte ne correspond aux filtres actuels.',
  clearFilters: 'Effacer les filtres',
  viewTable: 'Tableau',
  // ADR 0882 D3 (the owner is a workspace member) + D7 (plays).
  ownerYou: 'Vous',
  ownerYouNamed: '{{name}} (vous)',
  ownerUnknown: 'Ancien membre',
  ownerUnassigned: 'Non attribué',
  ownerLegacy: 'Nom saisi',
  ownersLoadFailed: 'Impossible de charger la liste des personnes',
  legacyOwnerLabel: 'Ancien responsable (nom saisi)',
  legacyOwnerClear: 'Effacer à l’enregistrement',
  legacyOwnerKeep: 'Conserver',
  legacyOwnerHint: 'Un nom saisi n’est pris en compte ni par « Les miens », ni par une réattribution, ni par une demande d’effacement. Choisissez un membre ci-dessus, puis effacez-le.',
  filterOwnerLabel: 'Filtrer par responsable',
  allOwners: 'Tous les responsables',
  ownerFacetMine: 'Les miens',
  ownerFacetUnassigned: 'Non attribués',
  playsTitle: 'Actions',
  playsLede: 'Les actions créent des tâches CRM quand un compte demande de l’attention. Chaque tâche est liée à l’entreprise du compte et attribuée à son responsable. Configurez une action dans l’éditeur de workflows, où vous pouvez modifier ses étapes.',
  playRescueName: 'Sauvetage de compte en rouge',
  playRescueWhen: 'Quand la santé d’un compte passe sous 70 : analyser les causes, planifier un point, convenir d’un plan de redressement.',
  playRunwayName: 'Préparation du renouvellement',
  playRunwayWhen: 'Avant chaque renouvellement : une tâche à 90, 60 et 30 jours. À lancer à la demande ou chaque semaine.',
  playSetUp: 'Configurer dans l’éditeur',
  ownerUnavailable: 'Responsable indisponible',
  ownerLoading: 'Chargement…',
  ownerErased: 'Effacé',
  retryOwnersLabel: 'Recharger la liste des personnes',
  failureOwnerNotMember: 'Cette personne n’est plus membre de cet espace de travail. Choisissez quelqu’un d’autre.',
  ownerInline: 'Responsable : {{owner}}',
  playRescueHowRuns: 'Démarre quand son événement est associé au workflow que vous créez.',
  playBindEvent: 'Associer l’événement',
  playRunwayHowRuns: 'Démarre quand vous la lancez, ou selon une planification ajoutée dans l’éditeur.',
  readOnlyNote: 'Vous pouvez consulter les comptes ici. Pour en ajouter ou les modifier, il faut un accès en modification à cet espace de travail.',
  playSetUpLabel: 'Configurer {{play}} dans l’éditeur',
} as const;
