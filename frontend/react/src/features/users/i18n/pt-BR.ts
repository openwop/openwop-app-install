/**
 * `users` namespace — user-facing copy for the users feature (incl. SSO panel).
 * Feature-self-contained: every users string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Acesso e dados',
  title: 'Usuários e autenticação',
  lede: 'Contas duráveis por trás do principal autenticado — a base da identidade.',

  // Signed-in notice
  signedInAs: 'Conectado como <0>{{name}}</0> (origem: {{source}}; status: {{status}}).',
  meFailed: 'Não foi possível carregar seu próprio registro de usuário. A lista e as configurações de SSO abaixo não são afetadas.',

  // Form field labels
  fieldPrincipalId: 'ID do principal',
  fieldDisplayName: 'Nome de exibição',

  // Placeholders
  principalIdPlaceholder: 'oidc:sub-123',
  displayNamePlaceholder: 'Jane Doe',

  // Buttons
  addUser: 'Adicionar usuário',
  disable: 'Desativar',
  enable: 'Ativar',

  // aria-labels
  deleteRowLabel: 'Excluir {{name}}',
  disableRowLabel: 'Desativar {{name}}',
  enableRowLabel: 'Ativar {{name}}',

  // Table caption + column headers
  captionUsers: 'Usuários',
  colPrincipal: 'Principal',
  colEmail: 'E-mail',
  colSource: 'Origem',
  colGroups: 'Grupos',
  colStatus: 'Status',

  // Empty state
  noUsers: 'Nenhum usuário ainda — adicione um acima ou entre para criar seu registro.',

  // Toasts
  userAdded: 'Usuário adicionado.',
  addFailed: 'Falha ao adicionar.',
  updateFailed: 'Falha ao atualizar.',
  deleteFailed: 'Falha ao excluir.',
  loadUsersFailed: 'Falha ao carregar usuários.',

  // ── SSO panel ──────────────────────────────────────────────────────────────
  ssoTitle: 'SSO empresarial e provisionamento',
  ssoLede:
    'Single sign-on SAML 2.0 e provisionamento SCIM 2.0. Pontos de integração do host para implantações white-label / B2B — anunciados apenas quando configurados e respeitados.',
  ssoReadingCaps: 'Lendo capacidades do host…',
  ssoCapsFailed: 'Não foi possível ler as capacidades anunciadas por este host, então não dá para dizer se SAML ou SCIM está habilitado. Isto não confirma que estejam desativados.',

  // SSO row state chips
  ssoAdvertised: 'Anunciado',
  ssoNotConfigured: 'Não configurado',
  ssoActive: 'Ativo',

  // SSO rows
  ssoOidcName: 'OIDC (Google / GitHub)',
  ssoOidcDetail: 'Bearer intermediado pelo Firebase — o login principal do host.',
  ssoPasswordName: 'E-mail e senha',
  ssoPasswordDetail: 'Contas locais com MFA via TOTP (este app, quando a feature de Usuários está ativa).',
  ssoSamlName: 'SSO SAML 2.0',
  ssoSamlDetail: 'O host valida asserções do IdP em seu ACS (Okta / Azure AD / Ping…).',
  ssoScimName: 'Provisionamento SCIM 2.0',
  ssoScimDetail: 'O IdP cria/desativa usuários e atribui grupos via SCIM.',

  // SSO endpoints
  ssoEndpointsLabel: 'Endpoints de integração empresarial (aponte seu IdP para cá)',
  ssoSamlAcs: 'ACS do SAML',
  ssoScimProvisioning: 'Provisionamento SCIM',

  // SSO not-enabled alert (rich markup via <Trans>)
  ssoNotEnabled:
    'Não habilitado nesta implantação. Um host white-label os ativa configurando um certificado de IdP / bearer SCIM; o host então anuncia os perfis <0> openwop-auth-saml</0> / <1>openwop-auth-scim</1> acima.',
  deleteUserConfirm: 'Excluir o usuário "{{name}}"?',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtrar usuários',
  filterPlaceholder: 'Buscar usuários…',
  filterAria: 'Buscar usuários por nome ou e-mail',
  filterStatusLabel: 'Filtrar por status',
  filterSourceLabel: 'Filtrar por origem',
  allStatuses: 'Todos os status',
  allSources: 'Todas as origens',
  status_active: 'Ativo',
  status_disabled: 'Desativado',
  source_oidc: 'OIDC',
  source_password: 'Senha',
  source_saml: 'SAML',
  source_scim: 'SCIM',
  source_manual: 'Manual',
  viewTable: 'Tabela',
  noMatchTitle: 'Nenhum usuário corresponde',
  noMatchBody: 'Nenhum usuário corresponde aos filtros atuais.',
  clearFilters: 'Limpar filtros',

  // ── ADR 0621 D5/D7 — consequências do ciclo de vida, autobloqueio, sair de todos os lugares ──
  ownRowHint: 'Sua própria conta — peça a outro administrador para alterá-la.',
  signOutEverywhere: 'Sair de todos os lugares',
  revokeRowLabel: 'Encerrar todas as sessões de {{name}}',
  revokeUserConfirm: 'Encerrar todas as sessões de "{{name}}"?',
  revokeUserBody: 'Isso encerra imediatamente todas as sessões ativas deste usuário em todos os dispositivos. A conta continua ativa e ele poderá entrar de novo.',
  userSessionsRevoked: 'Todas as sessões de {{name}} foram encerradas.',
  revokeFailed: 'Não foi possível encerrar as sessões do usuário.',
  disableUserConfirm: 'Desativar "{{name}}"?',
  disableUserBody: 'Desativar encerra imediatamente todas as sessões ativas deste usuário e bloqueia novos logins até que a conta seja reativada.',
  userDisabled: '{{name}} foi desativado e todas as suas sessões foram encerradas.',
  userEnabled: '{{name}} foi ativado.',
  userDeleted: '{{name}} foi excluído.',
  deleteUserBody: 'Isso apaga permanentemente a conta de {{name}} e todos os registros guardados nela — perfil, memórias, fluxos de trabalho, execuções e credenciais armazenadas. Não há como desfazer.',
  selfLockoutRefused: 'Você não pode desativar, encerrar as sessões nem excluir a sua própria conta por aqui — peça a outro administrador.',
  legalHoldRefused: 'Este espaço de trabalho está sob retenção legal, então os dados de usuário não podem ser apagados. Remova a retenção e tente de novo.',
  addRequired: 'Informe um id de principal.',
  addInvalidPrincipal: 'Um id de principal é um único token sem espaços, por exemplo oidc:sub-123.',
  addDuplicate: 'Já existe um usuário com este id de principal.',
  principalIdHelp: 'O sujeito do provedor de identidade com o qual este usuário faz login.',
} as const;
