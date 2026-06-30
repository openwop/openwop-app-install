/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negócios',
  title: 'CSM',
  lede: 'Contas de sucesso do cliente, da menor saúde primeiro.',

  // Gating / empty states
  notEnabledTitle: 'O CSM não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso CSM em Admin → Feature toggles.',
  noAccountsTitle: 'Nenhuma conta ainda',
  noAccountsBody: 'Adicione sua primeira conta de cliente com o formulário acima — a menor saúde vai para o topo.',

  // Table
  captionAccounts: 'Contas',
  colAccount: 'Conta',
  colHealth: 'Saúde',

  // aria-labels
  deleteRowLabel: 'Excluir {{name}}',

  // Form field labels / placeholders
  fieldAccount: 'Conta',
  fieldHealth: 'Saúde (0–100)',
  accountNamePlaceholder: 'Acme Corp',

  // Buttons
  addAccount: 'Adicionar conta',

  // Toasts — success
  accountAdded: 'Conta adicionada.',

  // Toasts / errors
  loadAccountsFailed: 'Falha ao carregar as contas.',
  addFailed: 'Falha ao adicionar.',
  deleteFailed: 'Falha ao excluir.',
} as const;
