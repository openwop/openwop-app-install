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
  openFeature: 'Open',
  openFeatureAria: 'Open {{label}}',
  recommendsLabel: 'Works better with',
  recommendOffSuffix: 'off — consider enabling',
  recommendOffHint: 'Enable {{feature}} for the best experience — optional, not required.',
  dependsOnLabel: 'Depends on',
  packsLabel: 'Packs',
  packStatus_installed: 'installed',
  packStatus_mounted: 'dev-mounted',
  packStatus_missing: 'not present',
  packStatus_tombstoned: 'removed from host',
  packOnDisk: 'on disk {{version}}',
  offLockedTitle: 'Cannot turn off — required by {{features}}. Disable those first.',
  requiredByNote: 'Required by {{features}} — turn those off before disabling this.',
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
  // §4.5 filtering — key-figure band + filterbar + list rows
  figureAttention: 'Needs attention',
  figuresLabel: 'Toggle counts — click to filter',
  filterGroup: 'Filter toggles',
  filterPlaceholder: 'Search by name, id, or description…',
  filterAria: 'Search feature toggles',
  categoryLabel: 'Category',
  clearFilters: 'Clear filters',
  categoryAll: 'All categories',
  sortLabel: 'Sort',
  sortDefault: 'Sort: category order',
  sortName: 'Sort: name A–Z',
  sortUpdated: 'Sort: recently updated',
  noMatchTitle: 'No toggles match',
  noMatchBody: 'No feature toggle matches the current filters. Clear the search or tiles above.',
  rowNeedsAttention: 'Needs attention',
  eyebrow: 'Admin',
  title: 'Feature toggles',
  lede: 'Turn a feature off, on, or to beta. Beta is an OPEN preview by default — visible to everyone with a Beta badge in the menu (set a beta cohort to keep it closed). Eligible traffic can split across weighted variants. Changes apply on the next request.',
  superadminRequired: 'Feature-toggle administration requires the host superadmin role. Ask a host operator to grant access, then try again.',
  noTogglesTitle: 'No feature toggles yet',
  noTogglesBody: 'Features register their default toggle as they ship. Once a feature declares one, it appears here.',
  overriddenChip: "Admin override",
  overriddenTitle: "A stored admin choice pins this toggle; the code default no longer applies until you re-save or revert.",
  defaultDriftChip: "Code default changed",
  defaultDriftTitle: "The compiled default changed since this override was saved — flipping the code default has no effect while the override exists.",
  revertTitle: "Revert “{{label}}” to its code default?",
  revertBody: "Deletes the stored admin override — the compiled default in code governs this toggle again. Variants, cohort, and per-workspace overrides saved on it are removed.",
  revertConfirm: "Revert to code default",
  reverted: "Reverted “{{label}}” to its code default.",
  consoleFailed: "Feature dependency information could not be loaded, so the “required by” notes may be missing. Turning a feature off is still checked by the server.",
  consoleRetry: "Try again",
} as const;
