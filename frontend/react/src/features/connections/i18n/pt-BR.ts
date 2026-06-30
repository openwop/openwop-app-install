/**
 * `connections` namespace — user-facing copy for the Connections feature
 * (ADR 0024 / 0025 / 0028). Feature-self-contained: every connections string
 * lives here. Generic actions/states are reused from the `common` namespace via
 * `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Acesso & dados',
  title: 'Conexões',
  lede: 'Conecte os apps com os quais seu assistente trabalha — Google, Slack, ServiceNow, Zoom.',

  // Manager — generic load/connect errors & toasts
  loadFailed: 'Falha ao carregar.',
  connectFailed: 'Falha ao conectar.',
  revokeFailed: 'Falha ao revogar.',
  testFailed: 'Falha no teste.',
  connected: '{{label}} conectado.',
  connectedForOrg: '{{label}} conectado para a organização.',
  couldNotStart: 'Não foi possível iniciar {{label}}.',
  connectionHealthy: '{{name}} está saudável.',
  connectionNeedsReconnect: '{{name}} precisa se reconectar.',

  // OAuth consent card
  connectWithConsent: 'Conectar com consentimento',
  consentBlurb:
    'Você será enviado ao provedor para aprovar o acesso de leitura e então retornará aqui. Seus tokens são armazenados criptografados e nunca são exibidos de volta para você.',
  connectProvider: 'Conectar {{label}}',
  connectingProvider: 'Conectando {{label}}…',
  notConfiguredHint:
    'Provedores em cinza ainda não estão configurados para OAuth neste host — o operador precisa adicionar as credenciais do cliente.',
  oauthNotConfiguredTitle: 'O OAuth de {{label}} não está configurado neste host',

  // Secret connect form
  providerLabel: 'Provedor (chave de API / token)',
  loadingProviders: 'Carregando provedores…',
  secretLabel: 'Chave de API / token',
  secretPlaceholder: 'cole seu token',
  sharedWith: 'Compartilhado com',
  shareJustMe: 'Apenas eu',
  shareOrganization: 'Organização',
  connect: 'Conectar',

  // Connections table
  tableCaption: 'Suas conexões',
  colConnection: 'Conexão',
  colProvider: 'Provedor',
  colSharing: 'Compartilhamento',
  colStatus: 'Status',
  sharingOrganization: 'Organização',
  sharingPersonal: 'Pessoal',
  sharingWrite: 'escrita',
  grantWriteAccess: 'Conceder acesso de escrita',
  grantWriteAccessLabel: 'Conceder acesso de escrita para {{name}}',
  grantWriteAccessConnect: 'acesso de escrita de {{label}}',
  connectProviderConnect: 'conectar {{label}}',
  testConnectionLabel: 'Testar {{name}}',
  test: 'Testar',
  revokeConnectionLabel: 'Revogar {{name}}',
  revoke: 'Revogar',
  noConnectionsTitle: 'Nenhuma conexão ainda',
  noConnectionsBody: 'Conecte um app acima para permitir que seu assistente leia a partir dele.',

  // OAuth callback toast
  callbackConnected: '{{provider}} conectado.',
  callbackConsentDenied: 'O consentimento foi recusado.',
  callbackInvalidState: 'A sessão de consentimento expirou — tente novamente.',
  callbackMissingParams: 'A resposta do provedor estava incompleta — tente novamente.',
  callbackExchangeFailed: 'Não foi possível concluir a troca de token. Tente novamente.',
  callbackGenericError: 'Não foi possível conectar {{provider}}.',

  // Governance panel
  governanceTitle: 'Governança',
  governanceBlurb:
    'Política do workspace: quais provedores podem se conectar e o que cada tipo de ação do assistente pode fazer. Aplicada nos pontos de conexão, resolução e dispatch.',
  governanceSaved: 'Política de governança salva.',
  saveFailed: 'Falha ao salvar.',
  providerAllowlist: 'Allowlist de provedores',
  restrictProviders: 'Restringir os provedores conectáveis',
  actionPolicy: 'Política de ação',
  policyApprovalRequired: 'Aprovação obrigatória (executa ao aprovar)',
  policyDraftOnly: 'Apenas rascunho (nunca executa)',
  policyDisabled: 'Desabilitado (sem rascunhos)',
  savePolicy: 'Salvar política',
  mediaBudgetTitle: 'Orçamentos de geração de mídia',
  mediaBudgetBlurb:
    'Limites diários por organização para geração de mídia paga (transcrição e conversão de texto em fala), definidos pelo operador via configuração de ambiente. O uso é redefinido às 00:00 UTC.',
  mediaBudgetTts: 'Texto para fala',
  mediaBudgetStt: 'Transcrição',
  mediaBudgetUsage: '{{used}} / {{cap}} {{unit}} usados hoje',
  mediaBudgetUncapped: '{{used}} {{unit}} usados hoje · sem limite',
  mediaUnitChars: 'caracteres',
  mediaUnitBytes: 'bytes',
  mediaBudgetBlurbEditable: 'Limites diários por organização para geração de mídia paga. Deixe um campo em branco para usar o padrão do host; insira 0 para remover o limite desta organização. O uso é redefinido às 00:00 UTC.',
  mediaBudgetTtsOverride: 'Orçamento de texto para fala (caracteres/dia)',
  mediaBudgetSttOverride: 'Orçamento de transcrição (bytes/dia)',
  mediaBudgetEnvPlaceholder: 'Padrão do host: {{value}}',
  mediaBudgetNoDefault: 'sem limite',
  mediaBudgetSave: 'Salvar orçamentos de mídia',
  mediaBudgetSaved: 'Orçamentos de mídia atualizados.',
  mediaBudgetInvalid: 'Os orçamentos devem estar em branco ou ser um número inteiro não negativo.',

  // OAuth client admin panel
  oauthClientSetup: 'Configuração de cliente OAuth (operador)',
  oauthClientBlurb:
    'Configure o app OAuth de cada provedor para que seu botão Conectar funcione — sem env vars, sem redeploy. Registre o redirect URI mostrado abaixo com o provedor, depois cole o Client ID e o Secret dele aqui. O secret é selado do lado do servidor e nunca mais é exibido.',
  loadOAuthClientFailed: 'Falha ao carregar a configuração do cliente OAuth.',
  oauthClientSaved: 'Cliente OAuth salvo — {{provider}} já pode executar o consentimento.',
  oauthClientRemoved: 'Cliente OAuth removido para {{provider}}.',
  removeFailed: 'Falha ao remover.',
  configured: 'Configurado',
  notConfigured: 'Não configurado',
  redirectUriLabel: 'Redirect URI para registrar com {{label}}',
  clientIdLabel: 'Client ID',
  clientIdLabelCurrent: 'Client ID (atual: {{clientId}})',
  clientIdPlaceholder: 'cole o client id do OAuth',
  clientIdPlaceholderReplace: 'substituir o client id',
  clientSecretLabel: 'Client secret',
  clientSecretPlaceholder: 'cole o client secret do OAuth',
  replace: 'Substituir',
  removeOAuthClientLabel: 'Remover cliente OAuth de {{label}}',
} as const;
