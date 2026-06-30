/**
 * `featureToggles` namespace — user-facing strings for the feature-toggle admin
 * panel (`src/featureToggles/FeatureTogglePanel.tsx`). Superadmin-facing surface,
 * but its visible UI copy is externalized per ADR 0065. FLAT camelCase keys,
 * one per line.
 */
export const messages = {
  // Status segmented control
  statusOff: 'Off',
  statusBeta: 'Beta',
  statusOn: 'On',

  // ToggleCard — save
  weightsMustSum: 'Variant weights must sum to exactly 100.',
  saved: 'Saved “{{label}}”.',
  saveFailed: 'Save failed.',

  // ToggleCard — controls
  statusForAria: 'Status for {{id}}',
  randomizeBy: 'Randomize by',
  unitUser: 'User',
  unitTenant: 'Tenant',
  multivariantSplit: 'Multivariant split',
  randomizeByHelp: 'User: each person gets a stable assignment. Tenant: each workspace gets one (everyone in it sees the same).',
  presetsLabel: 'Presets:',
  preset5050: '50 / 50 A·B',
  presetBeta: '10% beta',
  presetCanary: '5% canary',

  // ToggleCard — variant editor
  variantKeyAria: 'Variant {{n}} key',
  variantKeyPlaceholder: 'key',
  variantWeightAria: 'Variant {{n}} weight',
  removeVariantAria: 'Remove variant {{n}}',
  removeVariant: 'Remove',
  addVariant: '+ Add variant',
  variantSum: 'Sum: {{sum}}% ',
  variantSumMustBe100: '(must be 100)',

  // ToggleCard — footer
  updatedAt: 'Updated {{when}}',
  saving: 'Saving…',
  save: 'Save',

  // FeatureTogglePanel
  loadFailed: 'Failed to load toggles.',
  generalCategory: 'General',
  eyebrow: 'Admin',
  title: 'Feature toggles',
  lede: 'Turn a feature off, on, or to beta. Beta is an OPEN preview by default — visible to everyone with a Beta badge in the menu (set a beta cohort to keep it closed). Eligible traffic can split across weighted variants. Changes apply on the next request.',
  superadminRequired: '{{error}} — feature-toggle administration requires a superadmin principal (set OPENWOP_SUPERADMIN_TENANTS).',
  noTogglesTitle: 'No feature toggles yet',
  noTogglesBody: 'Features register their default toggle as they ship. Once a feature declares one, it appears here.',
} as const;
