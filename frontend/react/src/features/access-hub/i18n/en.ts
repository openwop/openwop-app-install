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

  // Tab labels (keyed by the route id = path last segment)
  tab_keys: 'Keys',
  tab_connections: 'Connections',
  tab_orgs: 'Organizations',
  tab_voice: 'Voice',
  tab_endpoints: 'Endpoints',
  tab_roles: 'Roles',
  'tab_capability-firewall': 'Capability firewall',
  'tab_example-data': 'Example data',

  // Empty state
  emptyTitle: 'Nothing to manage here yet',
  emptyBody: 'Credential and access tools appear here as they’re enabled for your workspace.',
} as const;
