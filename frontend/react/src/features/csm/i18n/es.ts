/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negocio',
  title: 'CSM',
  lede: 'Cuentas de éxito del cliente, primero las de menor salud.',

  // Gating / empty states
  notEnabledTitle: 'CSM no está habilitado',
  notEnabledBody: 'Pida a un administrador que active la función CSM en Administración → Conmutadores de funciones.',
  noAccountsTitle: 'Aún no hay cuentas',
  noAccountsBody: 'Añada su primera cuenta de cliente con el formulario de arriba; la de menor salud se ordena primero.',

  // Table
  captionAccounts: 'Cuentas',
  colAccount: 'Cuenta',
  colHealth: 'Salud',

  // aria-labels
  deleteRowLabel: 'Eliminar {{name}}',

  // Form field labels / placeholders
  fieldAccount: 'Cuenta',
  fieldHealth: 'Salud (0–100)',
  accountNamePlaceholder: 'Acme Corp',

  // Buttons
  addAccount: 'Añadir cuenta',

  // Toasts — success
  accountAdded: 'Cuenta añadida.',

  // Toasts / errors
  loadAccountsFailed: 'No se pudieron cargar las cuentas.',
  addFailed: 'No se pudo añadir.',
  deleteFailed: 'No se pudo eliminar.',
} as const;
