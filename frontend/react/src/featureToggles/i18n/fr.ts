/**
 * `featureToggles` namespace — user-facing strings for the feature-toggle admin
 * panel (`src/featureToggles/FeatureTogglePanel.tsx`). Superadmin-facing surface,
 * but its visible UI copy is externalized per ADR 0065. FLAT camelCase keys,
 * one per line.
 */
export const messages = {
  // Status segmented control
  statusOff: 'Désactivé',
  statusBeta: 'Bêta',
  statusOn: 'Activé',

  // ToggleCard — save
  weightsMustSum: 'La somme des pondérations des variantes doit être exactement égale à 100.',
  saved: 'Enregistré « {{label}} ».',
  saveFailed: 'Échec de l\'enregistrement.',

  // ToggleCard — controls
  statusForAria: 'Statut pour {{id}}',
  randomizeBy: 'Répartir aléatoirement par',
  unitUser: 'Utilisateur',
  unitTenant: 'Locataire',
  multivariantSplit: 'Répartition multivariante',
  randomizeByHelp: 'Utilisateur : chaque personne reçoit une affectation stable. Locataire : chaque espace de travail (tous y voient la même chose).',
  presetsLabel: 'Préréglages :',
  preset5050: '50 / 50 A·B',
  presetBeta: '10% bêta',
  presetCanary: '5% canary',

  // ToggleCard — variant editor
  variantKeyAria: 'Clé de la variante {{n}}',
  variantKeyPlaceholder: 'clé',
  variantWeightAria: 'Pondération de la variante {{n}}',
  removeVariantAria: 'Supprimer la variante {{n}}',
  removeVariant: 'Supprimer',
  addVariant: '+ Ajouter une variante',
  variantSum: 'Somme : {{sum}}% ',
  variantSumMustBe100: '(doit être 100)',

  // ToggleCard — footer
  updatedAt: 'Mis à jour {{when}}',
  saving: 'Enregistrement…',
  save: 'Enregistrer',

  // FeatureTogglePanel
  loadFailed: 'Échec du chargement des bascules.',
  generalCategory: 'Général',
  eyebrow: 'Administration',
  title: 'Bascules de fonctionnalité',
  lede: 'Désactivez une fonctionnalité, activez-la ou passez-la en bêta. La bêta est une préversion OUVERTE par défaut — visible par tous avec un badge Bêta dans le menu (définissez une cohorte bêta pour la garder fermée). Le trafic éligible peut être réparti entre des variantes pondérées. Les modifications s\'appliquent à la prochaine requête.',
  superadminRequired: '{{error}} — l\'administration des bascules de fonctionnalité requiert un principal superadmin (définissez OPENWOP_SUPERADMIN_TENANTS).',
  noTogglesTitle: 'Aucune bascule de fonctionnalité pour l\'instant',
  noTogglesBody: 'Les fonctionnalités enregistrent leur bascule par défaut au fur et à mesure de leur livraison. Dès qu\'une fonctionnalité en déclare une, elle apparaît ici.',
} as const;
