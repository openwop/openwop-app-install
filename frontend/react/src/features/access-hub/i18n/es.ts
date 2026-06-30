/**
 * `access-hub` namespace (es) — Access Hub console (ADR 0144).
 */
export const messages = {
  eyebrow: 'Acceso y datos',
  title: 'Acceso',
  lede: 'Gestiona credenciales, conexiones y quién puede hacer qué, todo en un solo lugar.',

  scopeLabel: 'Ámbito',
  scope_workspace: 'Espacio de trabajo',
  scope_personal: 'Personal',

  tablistLabel: 'Secciones de acceso',

  tab_keys: 'Claves',
  tab_connections: 'Conexiones',
  tab_orgs: 'Organizaciones',
  tab_voice: 'Voz',
  tab_endpoints: 'Endpoints',
  tab_roles: 'Roles',
  'tab_capability-firewall': 'Cortafuegos de capacidades',
  'tab_example-data': 'Datos de ejemplo',

  emptyTitle: 'Aún no hay nada que gestionar aquí',
  emptyBody: 'Las herramientas de credenciales y acceso aparecerán aquí a medida que se habiliten para tu espacio de trabajo.',
} as const;
