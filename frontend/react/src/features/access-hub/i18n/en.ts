/**
 * `access-hub` namespace — copy for the Access Hub console (ADR 0144).
 * Auto-discovered from this path as the `access-hub` i18n namespace.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Access & data',
  title: 'Access',
  lede: 'Manage credentials, connections, and who can do what — all in one place.',
  anonSignInPrompt: 'You\'re in an anonymous demo session — connections and keys you add here reset after 24 hours. Sign in to keep them.',

  // Scope pill
  scopeLabel: 'Scope',
  scope_workspace: 'Workspace',
  scope_personal: 'Personal',

  // Tablist
  tablistLabel: 'Access sections',
  panelRegion: '{{panel}} access panel',

  // Side-menu clusters (keyed by hubTab.group)
  group_credentials: 'Credentials',
  group_identity: 'Identity',

  // Tab labels (keyed by the route id = path last segment)
  tab_keys: 'Keys',
  tab_connections: 'Connections',
  tab_orgs: 'Organizations',
  tab_voice: 'Voice',
  tab_endpoints: 'Endpoints',
  tab_mcp: 'AI clients',
  'tab_api-keys': 'API keys',
  tab_roles: 'Roles',
  'tab_capability-firewall': 'Capability firewall',
  'tab_example-data': 'Example data',

  // Empty state
  emptyTitle: 'Nothing to manage here yet',
  emptyBody: 'Credential and access tools appear here as they’re enabled for your workspace.',
  // Summary (ADR 0864) — statuses after each section, the cards, the banner
  summaryLabel: 'Access summary',
  meta_issues_one: '{{count}} issue',
  meta_issues_other: '{{count}} issues',
  meta_on: 'On',
  meta_off: 'Off',
  meta_expired_one: '{{count}} expired',
  meta_expired_other: '{{count}} expired',
  meta_default: 'Default',
  meta_rules_one: '{{count}} rule',
  meta_rules_other: '{{count}} rules',
  card_keys: 'Model keys',
  card_keys_some: 'Stored on the host',
  card_keys_none: 'None added yet',
  card_connections: 'Connections',
  card_connections_issues_one: '{{count}} needs reconnecting',
  card_connections_issues_other: '{{count}} need reconnecting',
  card_connections_ok: 'All working',
  card_connections_none: 'None yet',
  card_mcp: 'AI clients',
  card_mcp_some: 'Connected over MCP',
  card_mcp_none: 'None connected over MCP',
  card_members: 'Members',
  card_members_orgs_one: 'In {{count}} organization',
  card_members_orgs_other: 'In {{count}} organizations',
  banner_one_title: '{{name}} needs reconnecting.',
  banner_one_body: 'Its sign-in has expired, so workflows that use it can’t reach the service until you reconnect.',
  banner_many_title_one: '{{count}} connection needs reconnecting.',
  banner_many_title_other: '{{count}} connections need reconnecting.',
  banner_many_body: 'Their sign-ins have expired, so workflows that use them can’t reach those services until you reconnect.',
  banner_action: 'Review connections',
} as const;
