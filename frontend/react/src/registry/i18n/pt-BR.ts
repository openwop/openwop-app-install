/**
 * registry — Brazilian Portuguese (pt-BR) catalog.
 *
 * User-facing strings for the live pack-registry browser (RFC 0003 / 0013 /
 * 0043): the registry browser modal, per-pack detail/provenance view, trust
 * tiers and operator install guidance.
 */

export const messages = {
  // Trust tiers (registryClient.TRUST_TIER_LABEL)
  trustTierOfficial: 'Oficial',
  trustTierVendor: 'Fornecedor',
  trustTierCommunity: 'Comunidade',
  trustTierUnknown: 'Não verificado',

  // PackBrowser — modal chrome
  dialogLabel: 'Registro de packs',
  title: 'Registro de packs',
  publishedCount: '{{count}} publicado(s)',
  searchPlaceholder: 'Buscar packs, tags, typeIds…',
  registryUnreachable: 'Registro inacessível: {{error}}',
  loadingRegistry: 'Carregando registro…',

  // PackBrowser — list rows
  flagYanked: 'retirado',
  flagDeprecated: 'descontinuado',
  flagInstalled: 'instalado',
  flagNotInstalled: 'não instalado',
  installedTypeIdsTitle_one: '{{count}} typeId instalado',
  installedTypeIdsTitle_other: '{{count}} typeIds instalados',
  rowCounts: '{{nodes}}n',
  rowCountsWithAgents: '{{nodes}}n {{agents}}a',
  noPacksMatch: 'Nenhum pack corresponde.',
  selectPackPrompt: 'Selecione um pack para ver seu manifesto, assinatura, nível de confiança e SBOM.',

  // PackDetailView
  loadingPack: 'Carregando {{name}}…',
  byAuthor: 'por {{author}} · ',
  homepage: 'página inicial',
  repo: 'repositório',
  latestVersionHeading: 'Mais recente {{version}}',
  signatureLabel: 'Assinatura',
  signatureValue: '{{method}} · chave',
  integrityLabel: 'Integridade (SRI)',
  artifactsLabel: 'Artefatos',
  manifestLink: 'manifesto',
  sbomLink: 'SBOM',
  tarballLink: 'tarball',
  sigLink: '.sig',
  typeIdsHeading: 'Type IDs ({{count}})',
  addToCanvas: '+ canvas',
  addToCanvasTitle: 'Adicionar este node ao canvas do builder',
  allVersionsSummary: 'Todas as versões ({{count}})',

  // InstallGuidance
  allNodesInstalled: 'Todos os nodes deste pack estão instalados — arraste-os da paleta para o canvas.',
  someNodesInstalled: '{{installed}}/{{total}} dos nodes deste pack estão instalados.',
  notInstalledOnHost: 'Não instalado neste host.',
  installReadOnly:
    'O navegador é apenas leitura para descoberta — para adicioná-lo, um operador define isto no env do host e reinicia:',
  copyInstallLineTitle: 'Copiar a linha de env de instalação',
  copy: 'Copiar',
  copied: 'Copiado',
  installDeferred: 'A instalação sob demanda pelo navegador está adiada por trás de um modelo de nível de confiança + autenticação.',
} as const;
