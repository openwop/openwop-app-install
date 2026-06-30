/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // App-shell chrome
  skipToContent: 'Aller au contenu',
  privacy: 'Confidentialité',
  language: 'Langue',
  // Generic actions
  save: 'Enregistrer',
  cancel: 'Annuler',
  close: 'Fermer',
  delete: 'Supprimer',
  edit: 'Modifier',
  back: 'Retour',
  next: 'Suivant',
  confirm: 'Confirmer',
  create: 'Créer',
  remove: 'Retirer',
  retry: 'Réessayer',
  refresh: 'Actualiser',
  search: 'Rechercher',
  searching: 'Recherche en cours…',
  // Generic states
  loading: 'Chargement…',
  saving: 'Enregistrement…',
  none: 'Aucun',
} as const;
