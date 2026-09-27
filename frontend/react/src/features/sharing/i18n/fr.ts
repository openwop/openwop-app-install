/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Les liens de partage appartiennent à une organisation',
  orgsFailedClause: 'Les liens de partage n’ont jamais été demandés',
  resourcesFailed: 'Impossible de charger les ressources — réessayez',
  // Page chrome
  eyebrow: 'Plateforme',
  title: 'Partage',
  lede: 'Générez des liens publics indevinable vers une page ou une collection de connaissances.',

  // Gating / empty states
  notEnabledTitle: 'Le partage n’est pas activé',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Partage pour ce locataire.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Resource-type display labels
  typeCmsPage: 'Page CMS',
  typeKbCollection: 'Collection KB',

  // Mint form
  mintTitle: 'Créer un lien de partage',
  fieldResourceType: 'Type de ressource',
  fieldResource: 'Ressource',
  resourcePlaceholder: '— sélectionner —',
  fieldLabel: 'Libellé (facultatif)',
  labelPlaceholder: 'ex. Brouillon à relire',
  fieldExpiry: 'Expire dans (jours, facultatif)',
  expiryPlaceholder: 'jamais',
  createLink: 'Créer un lien',

  // Active links
  activeTitle: 'Liens actifs',
  filterPlaceholder: 'Filtrer les liens…',
  filterAria: 'Filtrer les liens de partage par libellé',
  noMatchBody: 'Aucun lien ne correspond à votre recherche.',
  clearSearch: 'Effacer la recherche',
  noActiveLinks: 'Aucun lien de partage actif.',
  expiresAt: 'expire le {{date}}',
  copyLinkLabel: 'Copier le lien public',
  linkCreatedCopied: 'Lien créé — URL copiée dans le presse-papiers.',
  linkMintedOnce: 'Copiez ce lien maintenant — affiché une seule fois :',
  dismissMinted: 'Fermer',
  fingerprintTitle: 'L’URL n’est jamais stockée',
  fingerprintLabel: 'Empreinte {{fingerprint}}…',
  revokeLinkLabel: 'Révoquer',

  // Toasts
  linkCopied: 'Lien copié',
  linkCreated: 'Lien de partage créé',
  loadFailed: 'Échec du chargement des liens.',
  createFailed: 'Échec de la création.',
  revokeFailed: 'Échec de la révocation.',
  typeCreativeBrief: 'Brief créatif',
  typeBookingManage: 'Réservation (créé par l’app)',
  typeSignRequest: 'Invitation de signature (créé par l’app)',
  expiryInvalid: 'Saisissez un nombre entier de jours (1–3650), ou laissez vide pour aucune expiration.',
  linksFailedTitle: 'Impossible de charger les liens de cet espace',
  linksFailedBody: 'Une erreur s’est produite de notre côté — vos liens existent très probablement encore. Réessayez.',
  retryLabel: 'Réessayer',
  revokeDone: 'Lien révoqué — il cesse de fonctionner immédiatement.',
  seenCount_one: 'Vu {{count}} fois',
  seenCount_other: 'Vu {{count}} fois',
  lastSeenOn: 'Vu pour la dernière fois {{date}}',
  viewCapLabel: 'plafond de vues {{n}}',
  createdOn: 'créé le {{date}}',
  systemLinksToggle: 'Liens créés par l’app ({{n}}) — réservations, signatures et commandes',
  noMineLinks: 'Aucun lien créé par une personne pour l’instant — les liens ci-dessous ont été créés par l’app.',
  showMoreLinks: 'Afficher {{n}} de plus',
  quoteSubtotal: 'Sous-total',
  revokeShareConfirm: 'Révoquer ce lien de partage ? Toute personne disposant de l’URL perd l’accès.',
  typeDocument: 'Document',
  typeConversation: 'Conversation',
  typePrompt: 'Prompt',
  typeCommerceQuote: 'Devis',
  typeCommerceOrder: 'Commande',
  typeAppBuilderCanvas: 'Maquette d’application',

  typeSlidesCanvas: "Pr\u00e9sentation",

  // Visionneuse publique en lecture seule (ADR 0122 Phase 6)
  publicReadOnly: 'Vue partagée en lecture seule',
  publicSnapshotAt: 'Instantané du {{when}}',
  publicExpiresAt: 'le lien expire le {{when}}',
  publicLoading: 'Chargement de la vue partagée',
  publicUntitled: 'Conversation partagée',
  publicEmpty: 'Rien à afficher ici.',
  publicGoneTitle: 'Ce lien n’est plus disponible',
  publicGoneBody: 'Le lien a peut-être été révoqué par son propriétaire, il a peut-être atteint sa limite de vues, ou le contenu vers lequel il pointe n’est plus partagé.',
  publicLiveView: 'Vue en direct — le propriétaire peut encore modifier ce contenu',
  publicExpiredTitle: 'Ce lien a expiré',
  publicExpiredBody: 'Le propriétaire a défini une expiration pour ce lien et elle est passée. Demandez-lui un nouveau lien.',
  publicLoadFailedTitle: 'Impossible de charger cette vue partagée',
  publicLoadFailedBody: 'Une erreur s’est produite de notre côté — le lien fonctionne très probablement encore. Réessayez.',
  publicRetry: 'Réessayer',
  publicDraftedByAgent: 'Rédigé par un agent IA',
  publicGeneratedByWorkflow: 'Généré par un flux de travail automatisé',
  publicPoweredBy: 'Partagé depuis',
  quoteChip: 'Devis',
  quoteTitle: 'Votre devis',
  quoteValidUntil: 'Valable jusqu’au',
  quoteTotal: 'Total',
  quoteAccept: 'Accepter ce devis',
  quoteAccepting: 'Acceptation…',
  quoteAccepted: 'Devis accepté — la commande {{order}} est enregistrée. Le vendeur vous recontactera pour le paiement.',
  quoteAcceptFailed: 'Échec de l’acceptation — le devis a peut-être expiré ou changé.',
  quoteNotOpen: 'Ce devis n’est pas ouvert à l’acceptation pour le moment.',
  frameViewsToggle: "Vues par diapositive",
  frameViewsLoading: "Chargement\u2026",
  frameViewsEmpty: "Aucune vue pour le moment.",
  frameViewsUnavailable: 'Impossible de charger les vues.',
  frameViewsSlide: "Diapositive {{n}}",

  // SHARE-UX-1/2/3 — link STATUS (a row carried none), the honest
  // expired/orphaned copy, and the copy-outcome-dependent mint claims.
  statusLive: 'Actif',
  statusExpiring: 'Expire bientôt',
  statusExpired: 'Expiré',
  statusRevoked: 'Révoqué',
  statusOrphaned: 'Contenu supprimé',
  // SHARE-1 HONESTY — the gate made document/commerce/creative-brief links
  // darkenable, and the row used to render “Live” for them anyway.
  statusCapReached: 'Limite de vues atteinte',
  capReachedBody: 'Ce lien a atteint sa limite de {{n}} vue(s) ; il affiche désormais « indisponible » à quiconque l’ouvre. Les limites de vues ne peuvent pas être augmentées — créez un nouveau lien si vous devez encore partager ceci.',
  statusFeatureOff: 'Fonctionnalité désactivée',
  featureOffBody: 'Un administrateur a désactivé la fonctionnalité {{feature}} pour cet espace de travail : ce lien affiche désormais « non disponible » à toute personne qui l’ouvre. Réactivez la fonctionnalité pour le rétablir, ou révoquez le lien.',
  expiredAt: 'expiré le {{date}}',
  resourceMissingBody: 'Le contenu vers lequel pointait ce lien n’existe plus — toute personne qui l’ouvre est informée que le contenu a été supprimé. Révoquez-le pour faire le ménage.',
  deadLinksToggle: 'Liens expirés et révoqués ({{n}})',
  linkCreatedNotCopied: 'Lien créé — mais il n’a PAS pu être copié. Copiez-le depuis l’encadré ci-dessus maintenant ; il ne sera plus jamais affiché.',
  linkMintedCopyFailed: 'Copiez ce lien manuellement — le presse-papiers a été bloqué et il n’est affiché qu’une seule fois :',
  publicResourceGoneTitle: 'Ce contenu partagé a été supprimé',
  publicResourceGoneBody: 'Le lien fonctionne toujours, mais la page, le document ou la maquette vers lequel il pointait n’existe plus. Demandez un lien à jour à la personne qui l’a partagé.',
} as const;
