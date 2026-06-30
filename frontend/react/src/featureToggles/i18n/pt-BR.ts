/**
 * `featureToggles` namespace — user-facing strings for the feature-toggle admin
 * panel (`src/featureToggles/FeatureTogglePanel.tsx`). Superadmin-facing surface,
 * but its visible UI copy is externalized per ADR 0065. FLAT camelCase keys,
 * one per line.
 */
export const messages = {
  // Status segmented control
  statusOff: 'Desligado',
  statusBeta: 'Beta',
  statusOn: 'Ligado',

  // ToggleCard — save
  weightsMustSum: 'Os pesos das variantes devem somar exatamente 100.',
  saved: 'Salvo “{{label}}”.',
  saveFailed: 'Falha ao salvar.',

  // ToggleCard — controls
  statusForAria: 'Status de {{id}}',
  randomizeBy: 'Randomizar por',
  unitUser: 'Usuário',
  unitTenant: 'Tenant',
  multivariantSplit: 'Divisão multivariante',
  randomizeByHelp: 'Usuário: cada pessoa recebe uma atribuição estável. Locatário: cada espaço de trabalho (todos nele veem a mesma).',
  presetsLabel: 'Predefinições:',
  preset5050: '50 / 50 A·B',
  presetBeta: '10% beta',
  presetCanary: '5% canary',

  // ToggleCard — variant editor
  variantKeyAria: 'Chave da variante {{n}}',
  variantKeyPlaceholder: 'chave',
  variantWeightAria: 'Peso da variante {{n}}',
  removeVariantAria: 'Remover variante {{n}}',
  removeVariant: 'Remover',
  addVariant: '+ Adicionar variante',
  variantSum: 'Soma: {{sum}}% ',
  variantSumMustBe100: '(deve ser 100)',

  // ToggleCard — footer
  updatedAt: 'Atualizado {{when}}',
  saving: 'Salvando…',
  save: 'Salvar',

  // FeatureTogglePanel
  loadFailed: 'Falha ao carregar os toggles.',
  generalCategory: 'Geral',
  eyebrow: 'Admin',
  title: 'Feature toggles',
  lede: 'Desligue, ligue ou coloque um recurso em beta. Beta é uma prévia ABERTA por padrão — visível para todos com um selo Beta no menu (defina uma coorte beta para mantê-lo fechado). O tráfego elegível pode se dividir entre variantes ponderadas. As alterações se aplicam na próxima requisição.',
  superadminRequired: '{{error}} — a administração de feature toggles requer um principal superadmin (defina OPENWOP_SUPERADMIN_TENANTS).',
  noTogglesTitle: 'Nenhum feature toggle ainda',
  noTogglesBody: 'Os recursos registram seu toggle padrão conforme são lançados. Quando um recurso declara um, ele aparece aqui.',
} as const;
