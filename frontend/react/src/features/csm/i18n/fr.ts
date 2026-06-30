/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Activité',
  title: 'CSM',
  lede: 'Comptes de réussite client, état de santé le plus faible en premier.',

  // Gating / empty states
  notEnabledTitle: 'Le CSM n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité CSM dans Admin → Bascules de fonctionnalités.',
  noAccountsTitle: 'Aucun compte pour l\'instant',
  noAccountsBody: 'Ajoutez votre premier compte client avec le formulaire ci-dessus — l\'état de santé le plus faible est trié en haut.',

  // Table
  captionAccounts: 'Comptes',
  colAccount: 'Compte',
  colHealth: 'État de santé',

  // aria-labels
  deleteRowLabel: 'Supprimer {{name}}',

  // Form field labels / placeholders
  fieldAccount: 'Compte',
  fieldHealth: 'État de santé (0–100)',
  accountNamePlaceholder: 'Acme Corp',

  // Buttons
  addAccount: 'Ajouter un compte',

  // Toasts — success
  accountAdded: 'Compte ajouté.',

  // Toasts / errors
  loadAccountsFailed: 'Échec du chargement des comptes.',
  addFailed: 'Échec de l\'ajout.',
  deleteFailed: 'Échec de la suppression.',
} as const;
