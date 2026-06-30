/**
 * `discovery` namespace — user-facing copy for the Host capabilities page
 * (CapabilitiesPanel): coverage, host surfaces, envelope discipline, model
 * capabilities, input modalities, conformance & profiles.
 */
export const messages = {
  eyebrow: 'Découverte',
  title: 'Capacités de l\'hôte',
  lede: 'Ce que cet hôte peut et ne peut pas exécuter — pour savoir quels flux de travail fonctionneront ici, et pourquoi certains sont bloqués.',
  explainTitle: 'Comment lire cette page',
  explainBody: 'Commencez par le haut : « Couverture des packs » indique combien de blocs installés cet hôte peut exécuter, et lesquels sont bloqués et pourquoi. Tout le reste — surfaces d’hôte, enveloppes, capacités des modèles — est l’annonce de protocole détaillée de l’hôte, utile pour diagnostiquer la conformité.',

  // Pack coverage
  packCoverage: 'Couverture des packs',
  packCoverageHelpPrefix: 'Le chiffre unique qui répond à « cet hôte peut-il exécuter mon flux de travail ? » — les nœuds exécutables sur l\'ensemble du catalogue installé. Activez ',
  packCoverageHelpBlocked: 'Bloqué',
  packCoverageHelpSuffix: ' pour limiter le tableau aux seules surfaces qui bloquent l\'exécution.',
  coverageAriaLabel: 'Couverture des packs',
  figureRunnable: 'Exécutables',
  figureTotalNodes: 'Total des nœuds',
  figureBlocked: 'Bloqués',
  blockedTableCaption: 'Nœuds bloqués par surface',
  colBlockedBySurface: 'Bloqués par surface',
  colNodes: 'Nœuds',
  allRunnableClearPrefix: 'Les {{count}} nœuds exécutables passent toutes les surfaces requises. Sélectionnez ',
  allRunnableClearBlocked: 'Bloqué',
  allRunnableClearSuffix: ' pour voir les {{blocked}} qui ne le font pas.',
  everyNodeRunnableTitle: 'Chaque nœud installé est exécutable ici',
  everyNodeRunnableBody:
    'Aucun nœud du catalogue ne manque d\'une surface d\'hôte — cet hôte peut exécuter l\'ensemble complet des packs.',

  // Host surfaces
  hostSurfaces: 'Surfaces de l\'hôte',
  hostSurfacesHelpPrefix: 'Rendu en direct de ',
  hostSurfacesHelpImplLead: '. La colonne',
  hostSurfacesHelpImplEm: 'implémentation',
  hostSurfacesHelpImplMid: ' vous indique ce qui sous-tend chaque surface — des valeurs comme ',
  hostSurfacesHelpImplOr: ' ou ',
  hostSurfacesHelpImplTail: ' signifient que la surface n\'est pas durable. La phase 6 les remplace par de véritables adaptateurs backend issus de ',
  hostSurfacesHelpEnd: '.',
  surfacesTableCaption: 'Surfaces de l\'hôte',
  noSurfacesTitle: 'Aucune surface d\'hôte annoncée',
  noSurfacesBodyPrefix: "Le ",
  noSurfacesBodySuffix: ' de cet hôte est vide.',
  colSurface: 'Surface',
  colSupported: 'Pris en charge',
  colImplementation: 'Implémentation',
  colNote: 'Note',

  // Envelope discipline
  envelopeDiscipline: 'Discipline d\'enveloppe',
  envelopeHelp:
    "Ce que cet hôte promet concernant les enveloppes d\'émission LLM — la forme de la charge utile entrante que chaque nœud IA fournit dans l\'exécution. Lorsqu\'une ligne affiche —, l\'hôte n\'a pas encore annoncé cette surface.",
  envelopeHelp2:
    'Lorsque les événements de fiabilité ci-dessous se déclenchent lors d\'une exécution, ils apparaissent en direct dans le chat IA sous forme de puces en ligne dans la bulle de l\'assistant (nouvelles tentatives, refus, troncatures, substitutions de modèle, coercitions de prose vers JSON, récupérations de charge utile partielle).',
  envelopeTableCaption: 'Discipline d\'enveloppe',
  colValue: 'Valeur',
  envReasoningSupportedNoteLead: 'facultatif',
  envReasoningSupportedNoteTail: 'chaîne sur les charges utiles d\'enveloppe',
  envReasoningDirectiveNote: 'avec quelle insistance l\'hôte invite le modèle à la renseigner',
  envTierOneNote: "posture de l\'hôte sur le sous-ensemble de schéma OpenAI ∩ Anthropic ∩ Gemini",
  envReliabilitySupportedNote: 'l\'hôte émet des événements de nouvelle tentative / refus / troncature',
  envReliabilityEventsNote: 'quels types d\'événements de fiabilité cet hôte émet réellement',
  envTruncationNote: 'l\'hôte adapte sa stratégie de nouvelle tentative selon une troncature ou une violation de schéma',
  envTruncationBudgetNote: 'combien de budget de sortie supplémentaire l\'hôte accorde lors d\'une nouvelle tentative après troncature',

  // Model capabilities
  modelCapabilities: 'Capacités du modèle',
  modelCapabilitiesHelpPrefix:
    'Ce que chaque fournisseur/modèle installé peut faire (appel de fonctions, vision, streaming, etc.), et si cet hôte substituera silencieusement un modèle de repli lorsque le flux de travail demande une capacité que le modèle configuré n\'a pas. La substitution est observable via l\'événement ',
  modelCapabilitiesHelpSuffix: '.',
  advertised: 'Annoncé',
  notAdvertised: 'Non annoncé',
  substitutionOn: 'Substitution activée',
  substitutionOff: 'Substitution désactivée',
  declaredCount: '{{count}} déclaré(s)',
  modelCapsNotAdvertisedTitle: 'Capacités du modèle non annoncées',
  modelCapsNotAdvertisedBodyPrefix: "Cet hôte ne déclare pas encore ",
  modelCapsNotAdvertisedBodySuffix: ', donc le comportement de substitution de capacité est inconnu.',

  // Input modalities
  inputModalities: 'Modalités d\'entrée',
  inputModalitiesHelpPrefix: 'Les modalités de perception que cet hôte accepte comme ',
  inputModalitiesHelpMid: ' ContentParts. ',
  inputModalitiesHelpTextEm: 'texte',
  inputModalitiesHelpAfterText: ' est toujours valide ; une modalité non textuelle n\'est acceptée que lorsqu\'elle est annoncée ici, sinon l\'appel est rejeté avec ',
  inputModalitiesHelpSuffix: '.',
  noModalitiesTitle: 'Aucune modalité non textuelle annoncée',
  noModalitiesBodyPrefix: "Cet hôte ne déclare pas encore ",
  noModalitiesBodyMid: ' — seules les ',
  noModalitiesBodySuffix: ' ContentParts sont acceptées.',

  // Raw advertisement
  rawAdvertisement: 'Annonce brute',
  rawAdvertisementHelpPrefix: 'Charge utile ',
  rawAdvertisementHelpSuffix: ' complète.',
  rawCapsAriaLabel: 'JSON des capacités brutes',

  // Conformance & profiles
  conformanceAndProfiles: 'Conformité et profils',
  conformanceHelpPrefix: "L\'identité de l\'hôte connecté + chaque profil qu\'il annonce via ",
  conformanceHelpAnd: ' et ',
  conformanceHelpMid: ' — les surfaces sur lesquelles un implémenteur externe peut s\'appuyer. Consultez le ',
  conformanceLeaderboardLink: 'classement de conformité',
  conformanceHelpSuffix: ' pour la matrice des taux de réussite inter-hôtes.',
  implementationLabel: 'Implémentation',
  versionPrefix: 'v{{version}}',
  vendorPrefix: '· {{vendor}}',
  profilesClaimed: 'Profils revendiqués ({{count}})',
  noneAdvertised: 'aucun annoncé',
  referenceHostBadge: 'Badge d\'hôte de référence',
  badgeAlt: 'Badge de conformité {{label}}',
  noBadgePrefix:
    'Aucun badge publié pour cette implémentation. Les hôtes qui correspondent à une référence (in-memory, sqlite, postgres, python) en obtiennent un en ligne ; consultez le ',
  leaderboard: 'classement',
  noBadgeSuffix: ' pour tous les hôtes publiés.',
  emDash: '—',

  // Badge host labels
  badgePostgres: 'Hôte de référence Postgres',
  badgeSqlite: 'Hôte de référence SQLite',
  badgePython: 'Hôte de référence Python en mémoire',
  badgeInMemory: 'Hôte de référence en mémoire',
} as const;
