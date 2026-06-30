/**
 * `email` namespace — user-facing copy for the email feature.
 * Feature-self-contained: every email string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'E-mail',
  lede: 'Campagnes par modèle sur vos contacts CRM — soumises au consentement.',

  // Gating / empty states
  notEnabledTitle: 'L\'e-mail n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité E-mail pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les campagnes appartiennent à une organisation.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Template form
  templateNameLabel: 'Nom du modèle',
  templateNamePlaceholder: 'Bienvenue',
  subjectLabel: 'Objet',
  subjectPlaceholder: 'Bonjour {{contact.name}}',
  bodyLabel: 'Corps',
  bodyPlaceholder: 'Bonjour {{contact.name}} …',
  newTemplate: 'Nouveau modèle',

  // Templates list + editor
  templatesHeading: 'Modèles',
  noTemplates: 'Aucun modèle pour le moment.',
  deleteTemplate: 'Supprimer le modèle',
  editorNameLabel: 'Nom',
  editorSubjectLabel: 'Objet',
  editorBodyLabel: 'Corps',

  // Campaign form
  campaignTemplateLabel: 'Modèle',
  audienceStageLabel: 'Étape de l\'audience',
  audienceAllContacts: 'tous les contacts',
  newCampaign: 'Nouvelle campagne',

  // Campaigns list
  campaignsHeading: 'Campagnes',
  noCampaigns: 'Aucune campagne pour le moment.',
  campaignStats: '{{sent}} envoyés · {{skipped}} ignorés · {{failed}} échoués',
  resend: 'Renvoyer',
  campaignSend: 'Envoyer',
  sendCampaignAria: 'Envoyer la campagne',
  log: 'Journal',
  deleteCampaign: 'Supprimer la campagne',
  noSends: 'Aucun envoi pour le moment.',

  // Confirm dialog
  resendConfirm: 'Cette campagne a déjà été envoyée — la renvoyer à toute l\'audience ? Chaque destinataire est contacté de nouveau.',

  // Toasts — success
  templateCreated: 'Modèle créé',
  templateSaved: 'Enregistré',
  campaignCreated: 'Campagne créée',
  sendResult: 'Envoyés {{sent}} · ignorés {{skipped}} · échoués {{failed}}',

  // Toasts / errors
  loadFailed: 'Échec du chargement.',
  createFailed: 'Échec de la création.',
  saveFailed: 'Échec de l\'enregistrement.',
  deleteFailed: 'Échec de la suppression.',
  sendFailed: 'Échec de l\'envoi.',
} as const;
