/**
 * registry — Spanish (es) catalog.
 *
 * User-facing strings for the live pack-registry browser (RFC 0003 / 0013 /
 * 0043): the registry browser modal, per-pack detail/provenance view, trust
 * tiers and operator install guidance.
 */

export const messages = {
  // Trust tiers (registryClient.TRUST_TIER_LABEL)
  trustTierOfficial: 'Oficial',
  trustTierVendor: 'Proveedor',
  trustTierCommunity: 'Comunidad',
  trustTierUnknown: 'Sin verificar',

  // PackBrowser — modal chrome
  dialogLabel: 'Registro de packs',
  title: 'Registro de packs',
  publishedCount: '{{count}} publicados',
  searchPlaceholder: 'Buscar packs, etiquetas, typeIds…',
  registryUnreachable: 'Registro inaccesible: {{error}}',
  loadingRegistry: 'Cargando registro…',

  // PackBrowser — list rows
  flagYanked: 'retirado',
  flagDeprecated: 'obsoleto',
  flagInstalled: 'instalado',
  flagNotInstalled: 'no instalado',
  installedTypeIdsTitle_one: '{{count}} typeId instalado',
  installedTypeIdsTitle_other: '{{count}} typeIds instalados',
  rowCounts: '{{nodes}}n',
  rowCountsWithAgents: '{{nodes}}n {{agents}}a',
  noPacksMatch: 'Ningún pack coincide.',
  selectPackPrompt: 'Seleccione un pack para ver su manifiesto, su firma, su nivel de confianza y su SBOM.',

  // PackDetailView
  loadingPack: 'Cargando {{name}}…',
  byAuthor: 'por {{author}} · ',
  homepage: 'página de inicio',
  repo: 'repositorio',
  latestVersionHeading: 'Última {{version}}',
  signatureLabel: 'Firma',
  signatureValue: '{{method}} · clave',
  integrityLabel: 'Integridad (SRI)',
  artifactsLabel: 'Artefactos',
  manifestLink: 'manifiesto',
  sbomLink: 'SBOM',
  tarballLink: 'tarball',
  sigLink: '.sig',
  typeIdsHeading: 'IDs de tipo ({{count}})',
  addToCanvas: '+ lienzo',
  addToCanvasTitle: 'Añadir este nodo al lienzo del constructor',
  allVersionsSummary: 'Todas las versiones ({{count}})',

  // InstallGuidance
  allNodesInstalled: 'Todos los nodos de este pack están instalados: arrástrelos al lienzo desde la paleta.',
  someNodesInstalled: '{{installed}}/{{total}} de los nodos de este pack están instalados.',
  notInstalledOnHost: 'No instalado en este host.',
  installReadOnly:
    'El navegador es de descubrimiento de solo lectura: para añadirlo, un operador lo configura en el entorno del host y reinicia:',
  copyInstallLineTitle: 'Copiar la línea de entorno de instalación',
  copy: 'Copiar',
  copied: 'Copiado',
  installDeferred: 'La instalación bajo demanda desde el navegador está aplazada tras un modelo de nivel de confianza y autenticación.',
} as const;
