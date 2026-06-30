/**
 * `orgs` namespace — user-facing strings for the Organizations & access admin
 * area (`src/orgs/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 * Role/scope CODES stay as wire data; only their display LABELS live here.
 */
export const messages = {
  // OrgsPage — header
  pageEyebrow: 'Paramètres',
  pageTitle: 'Organisations et accès',
  pageLede:
    'Organisez votre équipe et contrôlez qui peut faire quoi. Créez des équipes, ajoutez des membres et attribuez des rôles — l\'accès d\'un membre provient uniquement des rôles qui lui sont attribués, et non de sa position dans l\'organigramme.',

  // OrgsListPanel
  orgsHeading: 'Organisations',
  newOrgPlaceholder: 'Nom de la nouvelle organisation',
  newOrgAriaLabel: 'Nom de la nouvelle organisation',
  createOrgRequiresScope: 'Nécessite host:org:manage',
  noOrgsTitle: 'Aucune organisation pour le moment',
  noOrgsBody: 'Créez-en une pour ajouter des équipes et des membres.',
  deleteOrgAriaLabel: 'Supprimer {{name}}',

  // OrgDetailPanel — empty state
  selectOrgTitle: 'Sélectionnez une organisation',
  selectOrgBody: 'Choisissez une organisation à gauche pour gérer ses équipes et ses membres.',

  // OrgDetailPanel — "View as" lens
  viewAsLabel: 'Afficher en tant que',
  viewAsOwnerOption: 'Propriétaire (vous) — accès complet',
  viewAsRoleGroupLabel: 'Prévisualiser un rôle (interface uniquement)',
  viewAsRoleOption: 'En tant que {{name}}',
  viewAsMemberGroupLabel: 'Afficher en tant que membre (appliqué)',
  viewAsMemberNoRoles: 'aucun rôle',
  viewAsMemberOption: '{{name}} ({{roles}})',
  previewingRolePrefix: 'Prévisualisation du rôle',
  previewingRoleSuffix_one: '— {{count}} portée. Il s\'agit d\'un aperçu de l\'interface (rien n\'est accordé) ; les actions que ce rôle ne peut pas effectuer sont désactivées ci-dessous.',
  previewingRoleSuffix_other: '— {{count}} portées. Il s\'agit d\'un aperçu de l\'interface (rien n\'est accordé) ; les actions que ce rôle ne peut pas effectuer sont désactivées ci-dessous.',
  enforcingMemberPrefix: 'Application en tant que',
  enforcingMemberSuffix_one: '— {{count}} portée. Les actions que ce membre ne peut pas effectuer sont désactivées ci-dessous ; en tenter une côté serveur renvoie 403.',
  enforcingMemberSuffix_other: '— {{count}} portées. Les actions que ce membre ne peut pas effectuer sont désactivées ci-dessous ; en tenter une côté serveur renvoie 403.',

  // TeamsPanel
  teamsHeading: 'Équipes',
  newTeamPlaceholder: 'Nom de la nouvelle équipe',
  newTeamAriaLabel: 'Nom de la nouvelle équipe',
  addTeam: 'Ajouter une équipe',
  addTeamRequiresScope: 'Nécessite host:teams:manage',
  noTeamsYet: 'Aucune équipe pour le moment.',
  deleteTeamAriaLabel: 'Supprimer l\'équipe {{name}}',

  // MembersPanel
  membersHeading: 'Membres',
  memberNamePlaceholder: 'Nom',
  memberNameAriaLabel: 'Nom du membre',
  memberEmailPlaceholder: 'E-mail (facultatif)',
  memberEmailAriaLabel: 'E-mail du membre',
  addMember: 'Ajouter un membre',
  addMemberRequiresScope: 'Nécessite host:members:manage',
  noMembersTitle: 'Aucun membre pour le moment',
  noMembersBody: 'Ajoutez un membre ci-dessus et attribuez-lui des rôles.',
  accessButton: 'Accès',
  rolesButton: 'Rôles',
  editRolesAriaLabel: 'Modifier les rôles de {{name}}',
  removeMemberAriaLabel: 'Retirer {{name}}',
  noRoles: 'aucun rôle',
  effectiveScopesBasis: 'Portées effectives (base : {{basis}}) — résolues uniquement à partir des rôles attribués :',
  noScopesFailClosed: 'aucune portée (fermeture par défaut)',

  // GroupsPanel
  groupsHeading: 'Groupes',
  groupsHeadingSuffix: '· ensembles de rôles',
  groupsIntro:
    'Un groupe regroupe des rôles et les accorde à ses membres — en plus des rôles propres à chaque membre. Utilisez-le pour la gestion des accès par lots (p. ex. « Éditeurs », « Administrateurs »).',
  newGroupPlaceholder: 'Nom du nouveau groupe',
  newGroupAriaLabel: 'Nom du nouveau groupe',
  addGroup: 'Ajouter un groupe',
  addGroupRequiresScope: 'Nécessite host:groups:manage',
  noGroupsYet: 'Aucun groupe pour le moment.',
  membersButton: 'Membres',
  editGroupMembersAriaLabel: 'Modifier les membres de {{name}}',
  deleteGroupAriaLabel: 'Supprimer le groupe {{name}}',
  noGroupRoles: 'aucun rôle',
  groupMemberCount_one: '{{count}} membre',
  groupMemberCount_other: '{{count}} membres',
  groupMemberListSuffix: ' : {{names}}',
  addMembersToOrgFirst: 'Ajoutez d\'abord des membres à l\'organisation.',

  // RoleCatalogPanel
  roleCatalogHeading: 'Catalogue de rôles',
  roleCatalogIntro:
    'Rôles intégrés et portées qu\'ils accordent. Les portées simples sont des portées du protocole OpenWOP ; les portées host: gèrent cette surface d\'organisation/équipe/membre.',

  // CustomRolesPanel
  customRolesHeading: 'Rôles personnalisés',
  customRolesHeadingSuffix: '· définissez les vôtres',
  customRolesIntro:
    'Regroupez n\'importe quelles portées dans un rôle nommé, puis attribuez-le aux membres et aux groupes exactement comme un rôle intégré.',
  newRolePlaceholder: 'Nom du nouveau rôle',
  newRoleAriaLabel: 'Nom du nouveau rôle personnalisé',
  createRole: 'Créer un rôle',
  createRoleRequiresScope: 'Nécessite host:roles:manage',
  noCustomRolesYet: 'Aucun rôle personnalisé pour le moment.',
  deleteRoleAriaLabel: 'Supprimer le rôle {{name}}',
  noScopes: 'aucune portée',

  // Built-in role display labels (codes are persisted wire data; these are UI copy)
  roleLabelViewer: 'lecteur',
  roleLabelEditor: 'éditeur',
  roleLabelAdmin: 'administrateur',
  roleLabelOwner: 'propriétaire',

  // useOrgsController — confirm dialogs
  confirmDeleteOrg: 'Supprimer l\'organisation « {{name}} » ainsi que toutes ses équipes et tous ses membres ? Cette action est irréversible.',
  confirmDeleteTeam: 'Supprimer l\'équipe « {{name}} » ?',
  confirmRemoveMember: 'Retirer le membre « {{name}} » ?',
  confirmDeleteGroup: 'Supprimer le groupe « {{name}} » ? Les membres conservent leurs rôles directs.',
  confirmDeleteRole: 'Supprimer le rôle personnalisé « {{name}} » ? Il sera retiré de tout membre ou groupe qui le possède.',

  // useOrgsController — error toast format ("{{title}} — {{detail}}")
  errorWithDetail: '{{title}} — {{detail}}',
} as const;
