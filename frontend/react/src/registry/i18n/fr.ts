/**
 * registry — French (fr) catalog.
 *
 * User-facing strings for the live pack-registry browser (RFC 0003 / 0013 /
 * 0043): the registry browser modal, per-pack detail/provenance view, trust
 * tiers and operator install guidance.
 */

export const messages = {
  // Trust tiers (registryClient.TRUST_TIER_LABEL)
  trustTierOfficial: 'Officiel',
  trustTierVendor: 'Éditeur',
  trustTierCommunity: 'Communauté',
  trustTierUnknown: 'Non vérifié',

  // PackBrowser — modal chrome
  dialogLabel: 'Registre de packs',
  title: 'Registre de packs',
  publishedCount: '{{count}} publié(s)',
  searchPlaceholder: 'Rechercher des packs, étiquettes, typeIds…',
  registryUnreachable: 'Registre injoignable : {{error}}',
  loadingRegistry: 'Chargement du registre…',

  // PackBrowser — list rows
  flagYanked: 'retiré',
  flagDeprecated: 'déprécié',
  flagInstalled: 'installé',
  flagNotInstalled: 'non installé',
  installedTypeIdsTitle_one: '{{count}} typeId installé',
  installedTypeIdsTitle_other: '{{count}} typeIds installés',
  rowCounts: '{{nodes}}n',
  rowCountsWithAgents: '{{nodes}}n {{agents}}a',
  noPacksMatch: 'Aucun pack correspondant.',
  selectPackPrompt: 'Sélectionnez un pack pour afficher son manifeste, sa signature, son niveau de confiance et son SBOM.',

  // PackDetailView
  loadingPack: 'Chargement de {{name}}…',
  byAuthor: 'par {{author}} · ',
  homepage: 'page d\'accueil',
  repo: 'dépôt',
  latestVersionHeading: 'Dernière {{version}}',
  signatureLabel: 'Signature',
  signatureValue: '{{method}} · clé',
  integrityLabel: 'Intégrité (SRI)',
  artifactsLabel: 'Artefacts',
  manifestLink: 'manifeste',
  sbomLink: 'SBOM',
  tarballLink: 'archive tar',
  sigLink: '.sig',
  typeIdsHeading: 'ID de type ({{count}})',
  addToCanvas: '+ canevas',
  addToCanvasTitle: 'Ajouter ce nœud au canevas du concepteur',
  allVersionsSummary: 'Toutes les versions ({{count}})',

  // InstallGuidance
  allNodesInstalled: "Tous les nœuds de ce pack sont installés — faites-les glisser sur le canevas depuis la palette.",
  someNodesInstalled: "{{installed}}/{{total}} des nœuds de ce pack sont installés.",
  notInstalledOnHost: 'Non installé sur cet hôte.',
  installReadOnly:
    'Le navigateur est une découverte en lecture seule — pour l\'ajouter, un opérateur configure ceci dans l\'environnement de l\'hôte et redémarre :',
  copyInstallLineTitle: 'Copier la ligne d\'installation de l\'environnement',
  copy: 'Copier',
  copied: 'Copié',
  installDeferred: 'L\'installation à la demande depuis le navigateur est différée derrière un modèle de niveau de confiance et d\'authentification.',
} as const;
