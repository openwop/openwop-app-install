/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Consentimento',
  lede: 'Política de consentimento por região + ferramentas de titular de dados (LGPD/GDPR).',

  // Gating / empty states
  notEnabledTitle: 'O consentimento não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de Consentimento para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — a política de consentimento pertence a uma organização.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Policy form
  regulatedRegionsLabel: 'Regiões reguladas (separadas por vírgula)',
  regulatedRegionsPlaceholder: 'EU, CA',
  defaultModeLabel: 'Modo padrão',
  defaultModeOptInLabel: 'opt-in (fail-closed)',
  defaultModeOptOutLabel: 'opt-out',
  savePolicy: 'Salvar política',

  // Data subject (GDPR)
  dataSubjectTitle: 'Titular de dados (LGPD/GDPR)',
  subjectKeyLabel: 'Chave do titular',
  subjectKeyPlaceholder: 'cookie do visitante / id do usuário',
  lookup: 'Consultar',
  erase: 'Apagar',
  eraseConfirm: 'Apagar todos os dados do titular "{{subjectKey}}"? Exclusão de titular de dados (LGPD/GDPR) — não pode ser desfeita.',
  lookupNoRecord: 'Nenhum registro de consentimento para esse titular — os dados a jusante (se houver) ainda são apagados.',

  // Category chips
  categoryAnalytics: 'analytics',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'somente necessários',

  // Consent records
  recordsTitle: 'Registros de consentimento',
  noRecords: 'Nenhum registro de consentimento ainda.',

  // Toasts — success
  policySaved: 'Política salva',
  subjectErased: 'Dados do titular apagados',

  // Toasts / errors
  loadPolicyFailed: 'Falha ao carregar a política.',
  saveFailed: 'Falha ao salvar.',
  lookupFailed: 'Falha na consulta.',
  eraseFailed: 'Falha ao apagar.',
} as const;
