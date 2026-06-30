/**
 * `orgs` namespace — user-facing strings for the Organizations & access admin
 * area (`src/orgs/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 * Role/scope CODES stay as wire data; only their display LABELS live here.
 */
export const messages = {
  // OrgsPage — header
  pageEyebrow: 'Configurações',
  pageTitle: 'Organizações & acesso',
  pageLede:
    'Organize sua equipe e controle quem pode fazer o quê. Crie equipes, adicione membros e atribua papéis — o acesso de um membro vem apenas dos papéis atribuídos, não da sua posição no organograma.',

  // OrgsListPanel
  orgsHeading: 'Organizações',
  newOrgPlaceholder: 'Nome da nova organização',
  newOrgAriaLabel: 'Nome da nova organização',
  createOrgRequiresScope: 'Requer host:org:manage',
  noOrgsTitle: 'Nenhuma organização ainda',
  noOrgsBody: 'Crie uma para adicionar equipes e membros.',
  deleteOrgAriaLabel: 'Excluir {{name}}',

  // OrgDetailPanel — empty state
  selectOrgTitle: 'Selecione uma organização',
  selectOrgBody: 'Escolha uma organização à esquerda para gerenciar suas equipes e membros.',

  // OrgDetailPanel — "View as" lens
  viewAsLabel: 'Ver como',
  viewAsOwnerOption: 'Proprietário (você) — acesso total',
  viewAsRoleGroupLabel: 'Pré-visualizar um papel (apenas UI)',
  viewAsRoleOption: 'Como {{name}}',
  viewAsMemberGroupLabel: 'Ver como membro (aplicado)',
  viewAsMemberNoRoles: 'sem papéis',
  viewAsMemberOption: '{{name}} ({{roles}})',
  previewingRolePrefix: 'Pré-visualizando o papel',
  previewingRoleSuffix_one: '— {{count}} escopo. Esta é uma pré-visualização de UI (nada é concedido); ações que este papel não pode executar estão desabilitadas abaixo.',
  previewingRoleSuffix_other: '— {{count}} escopos. Esta é uma pré-visualização de UI (nada é concedido); ações que este papel não pode executar estão desabilitadas abaixo.',
  enforcingMemberPrefix: 'Aplicando como',
  enforcingMemberSuffix_one: '— {{count}} escopo. Ações que este membro não pode executar estão desabilitadas abaixo; tentar uma do lado do servidor retorna 403.',
  enforcingMemberSuffix_other: '— {{count}} escopos. Ações que este membro não pode executar estão desabilitadas abaixo; tentar uma do lado do servidor retorna 403.',

  // TeamsPanel
  teamsHeading: 'Equipes',
  newTeamPlaceholder: 'Nome da nova equipe',
  newTeamAriaLabel: 'Nome da nova equipe',
  addTeam: 'Adicionar equipe',
  addTeamRequiresScope: 'Requer host:teams:manage',
  noTeamsYet: 'Nenhuma equipe ainda.',
  deleteTeamAriaLabel: 'Excluir equipe {{name}}',

  // MembersPanel
  membersHeading: 'Membros',
  memberNamePlaceholder: 'Nome',
  memberNameAriaLabel: 'Nome do membro',
  memberEmailPlaceholder: 'E-mail (opcional)',
  memberEmailAriaLabel: 'E-mail do membro',
  addMember: 'Adicionar membro',
  addMemberRequiresScope: 'Requer host:members:manage',
  noMembersTitle: 'Nenhum membro ainda',
  noMembersBody: 'Adicione um membro acima e atribua papéis.',
  accessButton: 'Acesso',
  rolesButton: 'Papéis',
  editRolesAriaLabel: 'Editar papéis de {{name}}',
  removeMemberAriaLabel: 'Remover {{name}}',
  noRoles: 'sem papéis',
  effectiveScopesBasis: 'Escopos efetivos (base: {{basis}}) — resolvidos apenas a partir dos papéis atribuídos:',
  noScopesFailClosed: 'sem escopos (fail-closed)',

  // GroupsPanel
  groupsHeading: 'Grupos',
  groupsHeadingSuffix: '· conjuntos de papéis',
  groupsIntro:
    'Um grupo agrupa papéis e os concede a seus membros — além dos papéis próprios de cada membro. Use-o para gerenciamento de acesso em lote (por exemplo, “Editores”, “Admins”).',
  newGroupPlaceholder: 'Nome do novo grupo',
  newGroupAriaLabel: 'Nome do novo grupo',
  addGroup: 'Adicionar grupo',
  addGroupRequiresScope: 'Requer host:groups:manage',
  noGroupsYet: 'Nenhum grupo ainda.',
  membersButton: 'Membros',
  editGroupMembersAriaLabel: 'Editar membros de {{name}}',
  deleteGroupAriaLabel: 'Excluir grupo {{name}}',
  noGroupRoles: 'sem papéis',
  groupMemberCount_one: '{{count}} membro',
  groupMemberCount_other: '{{count}} membros',
  groupMemberListSuffix: ': {{names}}',
  addMembersToOrgFirst: 'Adicione membros à organização primeiro.',

  // RoleCatalogPanel
  roleCatalogHeading: 'Catálogo de papéis',
  roleCatalogIntro:
    'Papéis internos e os escopos que eles concedem. Escopos simples são escopos do protocolo OpenWOP; escopos host: gerenciam esta superfície de organização/equipe/membro.',

  // CustomRolesPanel
  customRolesHeading: 'Papéis personalizados',
  customRolesHeadingSuffix: '· defina os seus',
  customRolesIntro:
    'Agrupe quaisquer escopos em um papel nomeado e então o atribua a membros e grupos exatamente como um papel interno.',
  newRolePlaceholder: 'Nome do novo papel',
  newRoleAriaLabel: 'Nome do novo papel personalizado',
  createRole: 'Criar papel',
  createRoleRequiresScope: 'Requer host:roles:manage',
  noCustomRolesYet: 'Nenhum papel personalizado ainda.',
  deleteRoleAriaLabel: 'Excluir papel {{name}}',
  noScopes: 'sem escopos',

  // Built-in role display labels (codes are persisted wire data; these are UI copy)
  roleLabelViewer: 'visualizador',
  roleLabelEditor: 'editor',
  roleLabelAdmin: 'admin',
  roleLabelOwner: 'proprietário',

  // useOrgsController — confirm dialogs
  confirmDeleteOrg: 'Excluir a organização "{{name}}" e todas as suas equipes + membros? Isso não pode ser desfeito.',
  confirmDeleteTeam: 'Excluir a equipe "{{name}}"?',
  confirmRemoveMember: 'Remover o membro "{{name}}"?',
  confirmDeleteGroup: 'Excluir o grupo "{{name}}"? Os membros mantêm seus papéis diretos.',
  confirmDeleteRole: 'Excluir o papel personalizado "{{name}}"? Ele será removido de qualquer membro ou grupo que o tenha.',

  // useOrgsController — error toast format ("{{title}} — {{detail}}")
  errorWithDetail: '{{title}} — {{detail}}',
} as const;
