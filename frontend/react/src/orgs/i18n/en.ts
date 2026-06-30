/**
 * `orgs` namespace — user-facing strings for the Organizations & access admin
 * area (`src/orgs/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 * Role/scope CODES stay as wire data; only their display LABELS live here.
 */
export const messages = {
  // OrgsPage — header
  pageEyebrow: 'Settings',
  pageTitle: 'Organizations & access',
  pageLede:
    'Organize your team and control who can do what. Create teams, add members, and assign roles — a member’s access comes only from its assigned roles, not its place in the org chart.',

  // OrgsListPanel
  orgsHeading: 'Organizations',
  newOrgPlaceholder: 'New organization name',
  newOrgAriaLabel: 'New organization name',
  createOrgRequiresScope: 'Requires host:org:manage',
  noOrgsTitle: 'No organizations yet',
  noOrgsBody: 'Create one to add teams and members.',
  deleteOrgAriaLabel: 'Delete {{name}}',

  // OrgDetailPanel — empty state
  selectOrgTitle: 'Select an organization',
  selectOrgBody: 'Pick an organization on the left to manage its teams and members.',

  // OrgDetailPanel — "View as" lens
  viewAsLabel: 'View as',
  viewAsOwnerOption: 'Owner (you) — full access',
  viewAsRoleGroupLabel: 'Preview a role (UI only)',
  viewAsRoleOption: 'As {{name}}',
  viewAsMemberGroupLabel: 'View as member (enforced)',
  viewAsMemberNoRoles: 'no roles',
  viewAsMemberOption: '{{name}} ({{roles}})',
  previewingRolePrefix: 'Previewing the',
  previewingRoleSuffix_one: 'role — {{count}} scope. This is a UI preview (nothing is granted); actions this role can’t perform are disabled below.',
  previewingRoleSuffix_other: 'role — {{count}} scopes. This is a UI preview (nothing is granted); actions this role can’t perform are disabled below.',
  enforcingMemberPrefix: 'Enforcing as',
  enforcingMemberSuffix_one: '— {{count}} scope. Actions this member can’t perform are disabled below; attempting one server-side returns 403.',
  enforcingMemberSuffix_other: '— {{count}} scopes. Actions this member can’t perform are disabled below; attempting one server-side returns 403.',

  // TeamsPanel
  teamsHeading: 'Teams',
  newTeamPlaceholder: 'New team name',
  newTeamAriaLabel: 'New team name',
  addTeam: 'Add team',
  addTeamRequiresScope: 'Requires host:teams:manage',
  noTeamsYet: 'No teams yet.',
  deleteTeamAriaLabel: 'Delete team {{name}}',

  // MembersPanel
  membersHeading: 'Members',
  memberNamePlaceholder: 'Name',
  memberNameAriaLabel: 'Member name',
  memberEmailPlaceholder: 'Email (optional)',
  memberEmailAriaLabel: 'Member email',
  addMember: 'Add member',
  addMemberRequiresScope: 'Requires host:members:manage',
  noMembersTitle: 'No members yet',
  noMembersBody: 'Add a member above and assign roles.',
  accessButton: 'Access',
  rolesButton: 'Roles',
  editRolesAriaLabel: 'Edit roles for {{name}}',
  removeMemberAriaLabel: 'Remove {{name}}',
  noRoles: 'no roles',
  effectiveScopesBasis: 'Effective scopes (basis: {{basis}}) — resolved from assigned roles only:',
  noScopesFailClosed: 'no scopes (fail-closed)',

  // GroupsPanel
  groupsHeading: 'Groups',
  groupsHeadingSuffix: '· role bundles',
  groupsIntro:
    'A group bundles roles and grants them to its members — on top of each member’s own roles. Use it for batch access management (e.g. “Editors”, “Admins”).',
  newGroupPlaceholder: 'New group name',
  newGroupAriaLabel: 'New group name',
  addGroup: 'Add group',
  addGroupRequiresScope: 'Requires host:groups:manage',
  noGroupsYet: 'No groups yet.',
  membersButton: 'Members',
  editGroupMembersAriaLabel: 'Edit members of {{name}}',
  deleteGroupAriaLabel: 'Delete group {{name}}',
  noGroupRoles: 'no roles',
  groupMemberCount_one: '{{count}} member',
  groupMemberCount_other: '{{count}} members',
  groupMemberListSuffix: ': {{names}}',
  addMembersToOrgFirst: 'Add members to the org first.',

  // RoleCatalogPanel
  roleCatalogHeading: 'Role catalog',
  roleCatalogIntro:
    'Built-in roles and the scopes they grant. Bare scopes are OpenWOP protocol scopes; host: scopes manage this org/team/member surface.',

  // CustomRolesPanel
  customRolesHeading: 'Custom roles',
  customRolesHeadingSuffix: '· define your own',
  customRolesIntro:
    'Bundle any scopes into a named role, then assign it to members and groups exactly like a built-in role.',
  newRolePlaceholder: 'New role name',
  newRoleAriaLabel: 'New custom role name',
  createRole: 'Create role',
  createRoleRequiresScope: 'Requires host:roles:manage',
  noCustomRolesYet: 'No custom roles yet.',
  deleteRoleAriaLabel: 'Delete role {{name}}',
  noScopes: 'no scopes',

  // Built-in role display labels (codes are persisted wire data; these are UI copy)
  roleLabelViewer: 'viewer',
  roleLabelEditor: 'editor',
  roleLabelAdmin: 'admin',
  roleLabelOwner: 'owner',

  // useOrgsController — confirm dialogs
  confirmDeleteOrg: 'Delete organization "{{name}}" and all its teams + members? This can’t be undone.',
  confirmDeleteTeam: 'Delete team "{{name}}"?',
  confirmRemoveMember: 'Remove member "{{name}}"?',
  confirmDeleteGroup: 'Delete group "{{name}}"? Members keep their direct roles.',
  confirmDeleteRole: 'Delete custom role "{{name}}"? It will be removed from any member or group that has it.',

  // useOrgsController — error toast format ("{{title}} — {{detail}}")
  errorWithDetail: '{{title}} — {{detail}}',
} as const;
