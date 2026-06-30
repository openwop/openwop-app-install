/**
 * `forms` namespace — user-facing copy for the forms feature.
 * Feature-self-contained: every forms string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Formulaires',
  lede: 'Créez un formulaire public ; les soumissions deviennent des contacts CRM.',

  // Gating / empty states
  notEnabledTitle: 'Les formulaires ne sont pas activés',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Formulaires pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les formulaires appartiennent à une organisation.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // New-form toolbar
  newFormLabel: 'Nouveau formulaire',
  newFormPlaceholder: 'ex. Contactez-nous',
  newFormButton: 'Nouveau formulaire',

  // Forms list
  formsHeading: 'Formulaires',
  noFormsYet: 'Aucun formulaire pour l\'instant.',
  deleteForm: 'Supprimer le formulaire',

  // Builder
  editForm: 'Modifier le formulaire',
  publish: 'Publier',
  unpublish: 'Dépublier',
  titleLabel: 'Titre',
  fieldsHeading: 'Champs',
  fieldLabelPlaceholder: 'Libellé',
  fieldKeyPlaceholder: 'clé (auto)',
  fieldLabelAria: 'Libellé du champ',
  fieldKeyAria: 'Clé du champ',
  fieldTypeAria: 'Type de champ',
  fieldRequired: 'requis',
  removeField: 'Supprimer le champ',
  addField: 'Ajouter un champ',
  createToContact: 'Créer un contact CRM à partir de chaque soumission',
  submitMessageLabel: 'Message de confirmation (facultatif)',
  submitMessagePlaceholder: 'Merci — nous vous recontacterons bientôt.',
  untitledForm: 'Sans titre',

  // Public URL
  publicUrlLabel: 'URL publique',
  copyPublicUrl: 'Copier l\'URL publique',
  publishToGetUrl: 'Publiez le formulaire pour obtenir son URL publique.',
  publicUrlCopied: 'URL publique copiée',

  // Submissions
  submissionsHeading: 'Soumissions',
  noSubmissionsYet: 'Aucune soumission pour l\'instant.',
  submissionContact: 'contact',
  submissionError: 'erreur',
  errNoContactFields: 'aucun champ de contact',
  errContactCreateFailed: 'échec du contact',

  // Toasts — success
  formCreated: 'Formulaire créé',
  saved: 'Enregistré',

  // Toasts — errors
  loadFormsFailed: 'Échec du chargement des formulaires.',
  createFailed: 'Échec de la création.',
  saveFailed: 'Échec de l\'enregistrement.',
  publishFailed: 'Échec de la publication.',
  deleteFailed: 'Échec de la suppression.',
} as const;
