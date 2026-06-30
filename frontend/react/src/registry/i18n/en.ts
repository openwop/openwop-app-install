/**
 * registry — English (en) catalog.
 *
 * User-facing strings for the live pack-registry browser (RFC 0003 / 0013 /
 * 0043): the registry browser modal, per-pack detail/provenance view, trust
 * tiers and operator install guidance.
 */

export const messages = {
  // Trust tiers (registryClient.TRUST_TIER_LABEL)
  trustTierOfficial: 'Official',
  trustTierVendor: 'Vendor',
  trustTierCommunity: 'Community',
  trustTierUnknown: 'Unverified',

  // PackBrowser — modal chrome
  dialogLabel: 'Pack registry',
  title: 'Pack registry',
  publishedCount: '{{count}} published',
  searchPlaceholder: 'Search packs, tags, typeIds…',
  registryUnreachable: 'Registry unreachable: {{error}}',
  loadingRegistry: 'Loading registry…',

  // PackBrowser — list rows
  flagYanked: 'yanked',
  flagDeprecated: 'deprecated',
  flagInstalled: 'installed',
  flagNotInstalled: 'not installed',
  installedTypeIdsTitle_one: '{{count}} typeId installed',
  installedTypeIdsTitle_other: '{{count}} typeIds installed',
  rowCounts: '{{nodes}}n',
  rowCountsWithAgents: '{{nodes}}n {{agents}}a',
  noPacksMatch: 'No packs match.',
  selectPackPrompt: 'Select a pack to view its manifest, signature, trust tier and SBOM.',

  // PackDetailView
  loadingPack: 'Loading {{name}}…',
  byAuthor: 'by {{author}} · ',
  homepage: 'homepage',
  repo: 'repo',
  latestVersionHeading: 'Latest {{version}}',
  signatureLabel: 'Signature',
  signatureValue: '{{method}} · key',
  integrityLabel: 'Integrity (SRI)',
  artifactsLabel: 'Artifacts',
  manifestLink: 'manifest',
  sbomLink: 'SBOM',
  tarballLink: 'tarball',
  sigLink: '.sig',
  typeIdsHeading: 'Type IDs ({{count}})',
  addToCanvas: '+ canvas',
  addToCanvasTitle: 'Add this node to the builder canvas',
  allVersionsSummary: 'All versions ({{count}})',

  // InstallGuidance
  allNodesInstalled: "All of this pack's nodes are installed — drag them onto the canvas from the palette.",
  someNodesInstalled: "{{installed}}/{{total}} of this pack's nodes are installed.",
  notInstalledOnHost: 'Not installed on this host.',
  installReadOnly:
    'The browser is read-only discovery — to add it, an operator sets this on the host env and restarts:',
  copyInstallLineTitle: 'Copy the install env line',
  copy: 'Copy',
  copied: 'Copied',
  installDeferred: 'On-demand install from the browser is deferred behind a trust-tier + auth model.',
} as const;
