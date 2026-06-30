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
} as const;
