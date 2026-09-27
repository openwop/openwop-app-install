/** `discovery` namespace — French (ADR 0275 / MERCH-C). */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Les collections et les règles de merchandising appartiennent à une organisation',
  orgsFailedClause: 'Les collections et les règles de merchandising n’ont jamais été demandées',
  orgsRetry: 'Réessayer',
  rowsFailedTitle: 'Impossible de charger les collections',
  rowsFailedBody: "Il s'agit d'une lecture en échec, pas d'une liste vide : cela ne signifie pas qu'aucune collection n'existe.",
  rulesFailedTitle: "Nous n'avons pas pu charger les règles de cette boutique",
  rulesFailedBody: "C'est une lecture en échec, pas une liste vide — elle ne dit pas si des règles masquent des produits de votre vitrine.",
  hiddenByRules_one: 'Vos règles ont masqué {{formatted}} produit de cet aperçu.',
  hiddenByRules_other: 'Vos règles ont masqué {{formatted}} produits de cet aperçu.',
  eyebrow: 'Activité',
  title: 'Découverte',
  lede: 'Collections, recherche à facettes et règles de merchandising pour votre boutique.',

  notEnabledTitle: 'La découverte n’est pas activée',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Découverte dans Admin → Interrupteurs de fonctionnalités.',
  noCollectionsTitle: 'Aucune collection pour l’instant',
  noCollectionsBody: 'Ajoutez une collection ci-dessus : une dynamique se remplit par catégorie, une manuelle est constituée à la main.',

  captionCollections: 'Collections',
  captionRules: 'Règles de merchandising',
  colName: 'Nom',
  colType: 'Type',
  colDetail: 'Contenu',
  colScope: 'Portée',
  colHoldout: 'Réserve',
  itemsCount_one: '{{count}} article',
  itemsCount_other: '{{count}} articles',

  fieldCollectionName: 'Nom de la collection',
  fieldType: 'Type',
  fieldCategory: 'Catégorie',
  fieldRuleName: 'Nom de la règle',
  fieldHideCategory: 'Masquer la catégorie',
  fieldSearch: 'Rechercher',
  collectionPlaceholder: 'ex. Sélection d’été',
  categoryPlaceholder: 'ex. photo',
  rulePlaceholder: 'ex. Masquer déstockage',
  searchPlaceholder: 'Rechercher des produits…',

  rulesTitle: 'Ajouter une règle de merchandising (masquer une catégorie)',
  addCollection: 'Ajouter une collection',
  addRule: 'Ajouter une règle',
  runSearch: 'Rechercher',
  searchEmpty: 'Aucun produit ne correspond.',

  type_dynamic: 'Dynamique (par catégorie)',
  type_manual: 'Manuelle (constituée)',

  deleteRowLabel: 'Supprimer {{name}}',
  deleteCollectionConfirm: 'Supprimer la collection « {{name}} » ?',
  deleteRuleConfirm: 'Supprimer la règle « {{name}} » ?',

  collectionAdded: 'Collection ajoutée.',
  collectionDeleted: 'Collection supprimée.',
  ruleAdded: 'Règle ajoutée.',
  ruleDeleted: 'Règle supprimée.',
  loadFailed: 'Échec du chargement de la découverte.',
  addFailed: 'Échec de l’ajout.',
  deleteFailed: 'Échec de la suppression.',
  searchFailed: 'La recherche a échoué.',
  searchFailedPersistent: "La recherche a échoué — ceci n'est pas le résultat de votre requête. Réessayez pour obtenir une réponse.",
  noRulesTitle: "Aucune règle de merchandising",
  noRulesBody: "Les règles masquent des produits de votre boutique. Aucune n'est active : les acheteurs voient tout.",
  productsTruncated: "Affichage des {{shown}} premiers résultats sur {{total}}.",
  facetsTruncated: "Les {{shown}} valeurs principales sur {{total}} par facette.",
  fieldCategoryHelp: "Les produits de cette catégorie rejoignent la collection automatiquement.",
  fieldHideCategoryHelp: "Les produits de cette catégorie cessent d'apparaître sur votre boutique tant que cette règle est active.",
} as const;
