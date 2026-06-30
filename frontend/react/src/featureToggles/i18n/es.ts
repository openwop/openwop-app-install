/**
 * `featureToggles` namespace — user-facing strings for the feature-toggle admin
 * panel (`src/featureToggles/FeatureTogglePanel.tsx`). Superadmin-facing surface,
 * but its visible UI copy is externalized per ADR 0065. FLAT camelCase keys,
 * one per line.
 */
export const messages = {
  // Status segmented control
  statusOff: 'Desactivado',
  statusBeta: 'Beta',
  statusOn: 'Activado',

  // ToggleCard — save
  weightsMustSum: 'Los pesos de las variantes deben sumar exactamente 100.',
  saved: 'Se ha guardado «{{label}}».',
  saveFailed: 'No se ha podido guardar.',

  // ToggleCard — controls
  statusForAria: 'Estado de {{id}}',
  randomizeBy: 'Aleatorizar por',
  unitUser: 'Usuario',
  unitTenant: 'Inquilino',
  multivariantSplit: 'División multivariante',
  randomizeByHelp: 'Usuario: a cada persona se le asigna de forma estable. Inquilino: a cada espacio de trabajo (todos en él ven lo mismo).',
  presetsLabel: 'Preajustes:',
  preset5050: '50 / 50 A·B',
  presetBeta: '10% beta',
  presetCanary: '5% canary',

  // ToggleCard — variant editor
  variantKeyAria: 'Clave de la variante {{n}}',
  variantKeyPlaceholder: 'clave',
  variantWeightAria: 'Peso de la variante {{n}}',
  removeVariantAria: 'Eliminar la variante {{n}}',
  removeVariant: 'Eliminar',
  addVariant: '+ Añadir variante',
  variantSum: 'Suma: {{sum}}% ',
  variantSumMustBe100: '(debe ser 100)',

  // ToggleCard — footer
  updatedAt: 'Actualizado {{when}}',
  saving: 'Guardando…',
  save: 'Guardar',

  // FeatureTogglePanel
  loadFailed: 'No se han podido cargar los interruptores de función.',
  generalCategory: 'General',
  eyebrow: 'Administración',
  title: 'Interruptores de función',
  lede: 'Desactive una función, actívela o póngala en beta. La beta es una vista previa ABIERTA de forma predeterminada: visible para todos con una insignia Beta en el menú (defina un grupo beta para mantenerla cerrada). El tráfico elegible puede dividirse en variantes ponderadas. Los cambios se aplican en la siguiente solicitud.',
  superadminRequired: '{{error}} — la administración de interruptores de función requiere un principal superadministrador (defina OPENWOP_SUPERADMIN_TENANTS).',
  noTogglesTitle: 'Aún no hay interruptores de función',
  noTogglesBody: 'Las funciones registran su interruptor predeterminado a medida que se publican. Una vez que una función declara uno, aparece aquí.',
} as const;
