/**
 * `orgs` namespace — user-facing strings for the Organizations & access admin
 * area (`src/orgs/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 * Role/scope CODES stay as wire data; only their display LABELS live here.
 */
export const messages = {
  // OrgsPage — header
  pageEyebrow: 'Ajustes',
  pageTitle: 'Organizaciones y acceso',
  pageLede:
    'Organiza tu equipo y controla quién puede hacer qué. Crea equipos, agrega miembros y asigna roles: el acceso de un miembro proviene únicamente de sus roles asignados, no de su posición en el organigrama.',

  // OrgsListPanel
  orgsHeading: 'Organizaciones',
  newOrgPlaceholder: 'Nombre de la nueva organización',
  newOrgAriaLabel: 'Nombre de la nueva organización',
  createOrgRequiresScope: 'Requiere host:org:manage',
  noOrgsTitle: 'Aún no hay organizaciones',
  noOrgsBody: 'Cree una para añadir equipos y miembros.',
  deleteOrgAriaLabel: 'Eliminar {{name}}',

  // OrgDetailPanel — empty state
  selectOrgTitle: 'Seleccione una organización',
  selectOrgBody: 'Elija una organización a la izquierda para gestionar sus equipos y miembros.',

  // OrgDetailPanel — "View as" lens
  viewAsLabel: 'Ver como',
  viewAsOwnerOption: 'Propietario (usted): acceso completo',
  viewAsRoleGroupLabel: 'Previsualizar un rol (solo IU)',
  viewAsRoleOption: 'Como {{name}}',
  viewAsMemberGroupLabel: 'Ver como miembro (aplicado)',
  viewAsMemberNoRoles: 'sin roles',
  viewAsMemberOption: '{{name}} ({{roles}})',
  previewingRolePrefix: 'Previsualizando el rol',
  previewingRoleSuffix_one: '— {{count}} ámbito. Esta es una vista previa de IU (no se concede nada); las acciones que este rol no puede realizar aparecen deshabilitadas a continuación.',
  previewingRoleSuffix_other: '— {{count}} ámbitos. Esta es una vista previa de IU (no se concede nada); las acciones que este rol no puede realizar aparecen deshabilitadas a continuación.',
  enforcingMemberPrefix: 'Aplicando como',
  enforcingMemberSuffix_one: '— {{count}} ámbito. Las acciones que este miembro no puede realizar aparecen deshabilitadas a continuación; intentar una en el servidor devuelve 403.',
  enforcingMemberSuffix_other: '— {{count}} ámbitos. Las acciones que este miembro no puede realizar aparecen deshabilitadas a continuación; intentar una en el servidor devuelve 403.',

  // TeamsPanel
  teamsHeading: 'Equipos',
  newTeamPlaceholder: 'Nombre del nuevo equipo',
  newTeamAriaLabel: 'Nombre del nuevo equipo',
  addTeam: 'Añadir equipo',
  addTeamRequiresScope: 'Requiere host:teams:manage',
  noTeamsYet: 'Aún no hay equipos.',
  deleteTeamAriaLabel: 'Eliminar equipo {{name}}',

  // MembersPanel
  membersHeading: 'Miembros',
  memberNamePlaceholder: 'Nombre',
  memberNameAriaLabel: 'Nombre del miembro',
  memberEmailPlaceholder: 'Correo electrónico (opcional)',
  memberEmailAriaLabel: 'Correo electrónico del miembro',
  addMember: 'Añadir miembro',
  addMemberRequiresScope: 'Requiere host:members:manage',
  noMembersTitle: 'Aún no hay miembros',
  noMembersBody: 'Añada un miembro arriba y asigne roles.',
  accessButton: 'Acceso',
  rolesButton: 'Roles',
  editRolesAriaLabel: 'Editar roles de {{name}}',
  removeMemberAriaLabel: 'Quitar {{name}}',
  noRoles: 'sin roles',
  effectiveScopesBasis: 'Ámbitos efectivos (base: {{basis}}): resueltos únicamente a partir de los roles asignados:',
  noScopesFailClosed: 'sin ámbitos (cierre seguro)',

  // GroupsPanel
  groupsHeading: 'Grupos',
  groupsHeadingSuffix: '· paquetes de roles',
  groupsIntro:
    'Un grupo agrupa roles y los concede a sus miembros, además de los roles propios de cada miembro. Úselo para la gestión de acceso por lotes (p. ej. “Editores”, “Administradores”).',
  newGroupPlaceholder: 'Nombre del nuevo grupo',
  newGroupAriaLabel: 'Nombre del nuevo grupo',
  addGroup: 'Añadir grupo',
  addGroupRequiresScope: 'Requiere host:groups:manage',
  noGroupsYet: 'Aún no hay grupos.',
  membersButton: 'Miembros',
  editGroupMembersAriaLabel: 'Editar miembros de {{name}}',
  deleteGroupAriaLabel: 'Eliminar grupo {{name}}',
  noGroupRoles: 'sin roles',
  groupMemberCount_one: '{{count}} miembro',
  groupMemberCount_other: '{{count}} miembros',
  groupMemberListSuffix: ': {{names}}',
  addMembersToOrgFirst: 'Añada primero miembros a la organización.',

  // RoleCatalogPanel
  roleCatalogHeading: 'Catálogo de roles',
  roleCatalogIntro:
    'Roles integrados y los ámbitos que conceden. Los ámbitos simples son ámbitos del protocolo OpenWOP; los ámbitos host: gestionan esta superficie de organización/equipo/miembro.',

  // CustomRolesPanel
  customRolesHeading: 'Roles personalizados',
  customRolesHeadingSuffix: '· defina los suyos',
  customRolesIntro:
    'Agrupe cualquier ámbito en un rol con nombre y luego asígnelo a miembros y grupos exactamente igual que un rol integrado.',
  newRolePlaceholder: 'Nombre del nuevo rol',
  newRoleAriaLabel: 'Nombre del nuevo rol personalizado',
  createRole: 'Crear rol',
  createRoleRequiresScope: 'Requiere host:roles:manage',
  noCustomRolesYet: 'Aún no hay roles personalizados.',
  deleteRoleAriaLabel: 'Eliminar rol {{name}}',
  noScopes: 'sin ámbitos',

  // Built-in role display labels (codes are persisted wire data; these are UI copy)
  roleLabelViewer: 'visualizador',
  roleLabelEditor: 'editor',
  roleLabelAdmin: 'administrador',
  roleLabelOwner: 'propietario',

  // useOrgsController — confirm dialogs
  confirmDeleteOrg: '¿Eliminar la organización "{{name}}" y todos sus equipos + miembros? Esto no se puede deshacer.',
  confirmDeleteTeam: '¿Eliminar el equipo "{{name}}"?',
  confirmRemoveMember: '¿Quitar al miembro "{{name}}"?',
  confirmDeleteGroup: '¿Eliminar el grupo "{{name}}"? Los miembros conservan sus roles directos.',
  confirmDeleteRole: '¿Eliminar el rol personalizado "{{name}}"? Se quitará de cualquier miembro o grupo que lo tenga.',

  // useOrgsController — error toast format ("{{title}} — {{detail}}")
  errorWithDetail: '{{title}} — {{detail}}',
} as const;
