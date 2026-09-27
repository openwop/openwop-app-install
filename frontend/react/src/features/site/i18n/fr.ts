/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero — the thesis, beside the run ledger (visual: 'run')
  heroHeading: 'Le travail de l’IA se joue pendant l’exécution. Désormais, l’exécution est ouverte.',
  heroSubheading: 'Les agents ne suivent pas de script. Ils décident en travaillant : quel outil appeler, quoi déléguer, quand s’arrêter pour vous demander. OpenWOP est un protocole ouvert pour cette exécution, et c’est ici que vous pouvez en créer une, la suivre et l’emporter avec vous.',
  heroCtaLabel: 'Commencer, sans inscription',
  heroCtaLabel2: 'Lire le protocole',

  // The "workflow" hero visual (HeroSchematic) — kept for CMS pages that pick it
  heroVignetteName: 'OpenWOP / workflow',
  heroVignetteReady: 'prêt à être exécuté',
  heroVignetteContext: '01 · contexte',
  heroVignetteBrief: 'Nouveau brief',
  heroVignetteCapture: 'Cadrer le travail',
  heroVignetteWorkflow: '02 · workflow',
  heroVignetteRoute: 'Router et décider',
  heroVignetteTogether: 'Humains et IA ensemble',
  heroVignetteRecord: '03 · historique',
  heroVignetteReview: 'Examiner l’exécution',
  heroVignetteReplay: 'Rejouable par conception',
  heroVignetteOpen: 'Standard ouvert',
  heroVignetteInfrastructure: 'Votre infrastructure',

  // The hero run ledger (SectionRenderer HeroRunLedger). Event names are wire
  // literals and stay untranslated; these are their plain-language glosses.
  heroRunName: 'exécution r-7f3a',
  heroRunLog: 'journal d’événements',
  heroRunStarted: 'L’exécution démarre avec vos données',
  heroRunDecided: 'L’agent choisit un outil à appeler',
  heroRunToolReturned: 'L’outil répond ; sa sortie est marquée non fiable',
  heroRunBudget: 'La dépense est comparée au plafond',
  heroRunApprovalRequested: 'L’étape suivante est irréversible, donc l’exécution s’arrête',
  heroRunWaiting: 'en pause pour une personne',
  heroRunApprovalGranted: 'Une personne dit oui',
  heroRunCompleted: 'Terminée, et rejouable depuis n’importe quelle étape',
  heroRunFooter: 'Les mêmes événements, sur tout hôte conforme',

  // Default story: why the run matters (richText, markdown emphasis)
  shiftHeading: 'Le logiciel faisait exactement ce qu’on lui disait.',
  shiftText: 'Pendant des décennies, le logiciel a fait ce que quelqu’un avait écrit, ligne par ligne. Les agents sont différents : ils prennent des décisions *pendant l’exécution*. L’exécution est donc désormais l’endroit où la valeur se crée, où les choses tournent mal et où quelqu’un doit répondre du résultat.\n\nAujourd’hui, chaque plateforme construit cette exécution à sa façon, et aucune ne s’accorde avec les autres. Le travail de vos agents appartient au fournisseur qui l’héberge.',

  // Default story: the history lesson (richText)
  historyHeading: 'On sait comment cela se termine.',
  historyText: 'Des standards de workflow comme BPMN et BPEL se sont accordés sur la façon de *dessiner* un processus. Son exécution est restée propriétaire, et les schémas n’ont jamais vraiment voyagé. L’e-mail et le web ont pris le chemin inverse : SMTP et HTTP ont standardisé la *conversation* entre machines, et tout le monde a pu bâtir dessus.\n\nOpenWOP fait le même pari pour le travail de l’IA. Ne standardisez pas le schéma. Standardisez l’exécution.',

  // Default story: what an open run guarantees (columns, layout 'rows')
  openHeading: 'Ce qui change quand l’exécution est ouverte',
  openLeaveTitle: 'Vous pouvez partir.',
  openLeaveText: 'Déplacez vos agents, packs et workflows vers un autre hôte conforme. Les secrets sont réassociés sur le nouvel hôte, jamais copiés.',
  openSeeTitle: 'Vous voyez pourquoi.',
  openSeeText: 'Chaque décision, appel d’outil et passage de relais est un événement dans un vocabulaire commun, lisible par n’importe quel outil, pas seulement celui qui l’a exécuté.',
  openDecideTitle: 'Une personne décide de l’irréversible.',
  openDecideText: 'L’approbation fait partie du protocole, ce n’est pas un plugin. L’exécution s’arrête et attend là où vous l’exigez.',
  openBoundTitle: 'Rien ne tourne sans limite.',
  openBoundText: 'Les plafonds de boucle et les budgets font partie du contrat, et la sortie non fiable d’un outil ne peut pas forcer une approbation.',
  openReplayTitle: 'Tout le monde peut la rejouer.',
  openReplayText: 'Un auditeur peut repartir de n’importe quel point d’une exécution, effets de bord neutralisés, et voir exactement ce qui s’est passé et pourquoi.',

  // Default story: the evidence + one honest caveat (richText). The paper link
  // is a separate paragraph so white-label installs can drop it (ADR 0196).
  proofHeading: 'Un workflow. Deux langages. La même exécution.',
  proofText: 'L’article OpenWOP rapporte qu’une même définition de workflow, exécutée sur un hôte TypeScript et sur un hôte Python, aboutit au même état final avec la même structure de journal d’événements. L’exécution est définie par le protocole, pas par celui qui l’héberge.\n\nC’est encore tôt, et vous n’avez pas à nous croire sur parole. Lancez quelque chose ici, ouvrez son journal d’événements et vérifiez.',
  proofPaperLink: 'La méthode et les résultats complets sont dans [l’article](https://doi.org/10.5281/zenodo.20576239).',

  // Default story: what you can do in this app today (columns, layout 'steps' —
  // a real sequence, so the numbering is earned)
  tryHeading: 'Essayez-le ici, dès aujourd’hui.',
  tryBuildTitle: 'Créer',
  tryBuildText: 'Esquissez un agent ou un workflow sur le canevas visuel, ou décrivez-le dans le chat.',
  tryRunTitle: 'Exécuter',
  tryRunText: 'Lancez-le avec les packs `core.openwop.*` publiés et regardez chaque événement arriver en direct.',
  tryDecideTitle: 'Décider',
  tryDecideText: 'Quand l’exécution s’arrête pour demander, répondez à la carte d’approbation. Elle vous attend.',
  tryReplayTitle: 'Rejouer',
  tryReplayText: 'Ouvrez n’importe quelle exécution terminée, repartez d’une étape et voyez ce qui changerait.',

  // Default closing CTA section
  ctaHeading: 'Créez une exécution que vous pouvez emporter.',
  ctaSubheading: 'Sans inscription. Apportez vos propres clés de modèle quand vous voulez.',
  ctaLabel: 'Commencer',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Trouver une fonctionnalité',
  catalogSearchPlaceholder: 'Rechercher parmi {{count}} fonctionnalités…',
  catalogSearchStatus: 'Affichage de {{count}} sur {{total}}',
  catalogSearchClear: 'Effacer la recherche',
  catalogSearchEmpty: 'Aucune fonctionnalité ne correspond à « {{query}} ».',

  // ADR 0391 (a) — archives publiques du blog + vue d’un article
  blogEyebrow: 'Articles',
  blogTitle: 'Blog',
  blogSubscribe: 'Flux RSS',
  blogByline: 'Par {{author}}',
  blogFilterTag: 'Étiqueté « {{value}} »',
  blogFilterCategory: 'Catégorie : {{value}}',
  blogFilterAuthor: 'Par {{value}}',
  blogFilterAuthorUnknown: 'Par cet auteur',
  blogClearFilter: 'Effacer le filtre',
  blogBackToBlog: '← Tous les articles',
  blogEmptyTitle: 'Aucun article n’a encore été publié',
  blogEmptyBody: 'Commencez par le guide ou explorez la plateforme pendant que cette publication prend forme.',
  blogEmptyPrimaryCta: 'Lire le guide de démarrage',
  blogEmptySecondaryCta: 'Explorer les fonctionnalités',
  blogArchiveEmptyTitle: 'Rien ici pour l’instant',
  blogArchiveEmptyBody: 'Aucun article ne correspond à ce filtre.',
  blogLoadErrorTitle: 'Impossible de charger le blog',
  blogLoadErrorBody: 'Une erreur est survenue lors du chargement des articles. Veuillez réessayer.',
  postNotFoundTitle: 'Article introuvable',
  postNotFoundBody: 'Cet article a peut-être été dépublié ou déplacé.',

  // ROUND 2 (UX_UPGRADE-site R2-G1/G2/G3) — honnêteté en cas d’échec
  postLoadErrorTitle: 'Impossible de charger cet article',
  postLoadErrorBody: 'Une erreur est survenue de notre côté — l’article existe probablement toujours.',
  pageNotFoundTitle: 'Page introuvable',
  pageNotFoundBody: 'Cette page a peut-être été dépubliée ou déplacée.',
  pageLoadErrorTitle: 'Impossible de charger cette page',
  pageLoadErrorBody: 'Une erreur est survenue de notre côté. Veuillez réessayer.',
  backToHome: 'Aller à la page d’accueil',
  blogChromeDegraded: 'Certains détails de l’article (auteur, date, articles liés) n’ont pas pu être chargés.',
  pricingWrapperDegraded: 'Une partie de cette page n’a pas pu être chargée — les offres ci-dessous sont à jour.',
  // UX_UPGRADE-site — filtre du blog (G1), temps de lecture (G2), voir plus (G3),
  // articles liés/pagination (G4) et copier le lien (G6)
  blogReadingTime: '{{count}} min de lecture',
  blogSearchLabel: 'Filtrer les articles',
  blogSearchPlaceholder: 'Filtrer {{count}} articles…',
  blogSearchStatus: 'Affichage de {{count}} sur {{total}}',
  blogSearchClear: 'Effacer le filtre',
  blogSearchEmptyTitle: 'Aucun article ne correspond à « {{query}} »',
  blogSearchEmptyBody: 'Essayez un autre mot ou effacez le filtre pour tout voir.',
  blogSearchShowAll: 'Voir tous les articles',
  blogShowMore: 'Voir {{count}} de plus',
  blogShownCount: 'Affichage de {{count}} sur {{total}} articles',
  blogPagerLabel: 'Articles voisins',
  blogOlderPost: 'Article précédent',
  blogNewerPost: 'Article suivant',
  blogRelatedTitle: 'Lectures associées',
  blogMoreTitle: 'Plus d’articles',
  blogCopyLink: 'Copier le lien',
  blogTocTitle: 'Sur cette page',
  blogShareLabel: 'Partager cet article',
  blogShareX: 'Partager sur X',
  blogShareLinkedIn: 'Partager sur LinkedIn',
  blogShareEmail: 'E-mail',
  blogSearchShortcutHint: 'Ctrl K',
  blogSearchShortcutHintMac: '⌘K',
  blogCopied: 'Copié',

  // ADR 0391 (b) — page publique des tarifs (repli quand aucune page CMS n’existe)
  pricingTitle: 'Tarifs',
  pricingEyebrow: 'Formules',
  pricingHeading: 'Les formules de ce déploiement',
  pricingBlurb: 'Les détails des formules sont configurés par l’opérateur de ce déploiement. Découvrez ce que chacune comprend, puis ouvrez l’espace de travail lorsque vous êtes prêt à commencer.',

  editThisPage: 'Modifier cette page',
  openApp: "Ouvrir l'application",
} as const;
