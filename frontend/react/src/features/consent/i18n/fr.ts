/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Consentement',
  lede: 'Politique de consentement adaptée à la région + outils relatifs aux personnes concernées (RGPD).',

  // Gating / empty states
  notEnabledTitle: 'Le consentement n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Consentement pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — la politique de consentement appartient à une organisation.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Policy form
  regulatedRegionsLabel: 'Régions réglementées (séparées par des virgules)',
  regulatedRegionsPlaceholder: 'UE, CA',
  defaultModeLabel: 'Mode par défaut',
  defaultModeOptInLabel: 'opt-in (fail-closed)',
  defaultModeOptOutLabel: 'opt-out',
  savePolicy: 'Enregistrer la politique',

  // Data subject (GDPR)
  dataSubjectTitle: 'Personne concernée (RGPD)',
  subjectKeyLabel: 'Clé du sujet',
  subjectKeyPlaceholder: 'cookie visiteur / id utilisateur',
  lookup: 'Rechercher',
  erase: 'Effacer',
  eraseConfirm: 'Effacer toutes les données du sujet "{{subjectKey}}" ? Suppression de la personne concernée (RGPD) — irréversible.',
  lookupNoRecord: 'Aucun enregistrement de consentement pour ce sujet — les données en aval (le cas échéant) sont tout de même effacées.',

  // Category chips
  categoryAnalytics: 'analytique',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'strictement nécessaire',

  // Consent records
  recordsTitle: 'Enregistrements de consentement',
  noRecords: 'Aucun enregistrement de consentement pour l\'instant.',

  // Toasts — success
  policySaved: 'Politique enregistrée',
  subjectErased: 'Données du sujet effacées',

  // Toasts / errors
  loadPolicyFailed: 'Échec du chargement de la politique.',
  saveFailed: 'Échec de l\'enregistrement.',
  lookupFailed: 'Échec de la recherche.',
  eraseFailed: 'Échec de l\'effacement.',
} as const;
