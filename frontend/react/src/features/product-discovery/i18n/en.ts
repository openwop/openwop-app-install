/** `discovery` namespace (ADR 0275 / MERCH-C) — user-facing copy. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Collections and merchandising rules belong to an organization',
  orgsFailedClause: 'The collections and merchandising rules were never requested',
  orgsRetry: 'Try again',
  rowsFailedTitle: 'Could not load collections',
  rowsFailedBody: 'This is a failed read, not an empty list — it does not mean no collections exist.',
  rulesFailedTitle: "We couldn't load this store's rules",
  rulesFailedBody: 'This is a failed read, not an empty list — it does not tell you whether any rules are hiding products from your storefront.',
  hiddenByRules_one: '{{formatted}} product was hidden from this preview by your rules.',
  hiddenByRules_other: '{{formatted}} products were hidden from this preview by your rules.',
  eyebrow: 'Business',
  title: 'Discovery',
  lede: 'Collections, faceted search, and merchandising rules for your storefront.',

  notEnabledTitle: 'Discovery is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the Discovery feature in Admin → Feature toggles.',
  noCollectionsTitle: 'No collections yet',
  noCollectionsBody: 'Add a collection above — a dynamic one auto-fills by category, a manual one is curated by hand.',

  captionCollections: 'Collections',
  captionRules: 'Merchandising rules',
  colName: 'Name',
  colType: 'Type',
  colDetail: 'Contents',
  colScope: 'Scope',
  colHoldout: 'Holdout',
  itemsCount_one: '{{count}} item',
  itemsCount_other: '{{count}} items',

  fieldCollectionName: 'Collection name',
  fieldType: 'Type',
  fieldCategory: 'Category',
  fieldRuleName: 'Rule name',
  fieldHideCategory: 'Hide category',
  fieldSearch: 'Search',
  collectionPlaceholder: 'e.g. Summer picks',
  categoryPlaceholder: 'e.g. photo',
  rulePlaceholder: 'e.g. Hide clearance',
  searchPlaceholder: 'Search products…',

  rulesTitle: 'Add a merchandising rule (hide a category)',
  addCollection: 'Add collection',
  addRule: 'Add rule',
  runSearch: 'Search',
  searchEmpty: 'No products matched.',

  type_dynamic: 'Dynamic (by category)',
  type_manual: 'Manual (curated)',

  deleteRowLabel: 'Delete {{name}}',
  deleteCollectionConfirm: 'Delete the collection "{{name}}"?',
  deleteRuleConfirm: 'Delete the rule "{{name}}"?',

  collectionAdded: 'Collection added.',
  collectionDeleted: 'Collection deleted.',
  ruleAdded: 'Rule added.',
  ruleDeleted: 'Rule deleted.',
  loadFailed: 'Failed to load discovery.',
  addFailed: 'Failed to add.',
  deleteFailed: 'Failed to delete.',
  searchFailed: 'Search failed.',
  searchFailedPersistent: "The search failed — these are not results for your query. Retry to get an answer.",
  noRulesTitle: "No merch rules",
  noRulesBody: "Rules hide products from your storefront. None are active, so shoppers see everything.",
  productsTruncated: "Showing the first {{shown}} of {{total}} matches.",
  facetsTruncated: "Top {{shown}} of {{total}} values per facet.",
  fieldCategoryHelp: "Products in this category join the collection automatically as they are added.",
  fieldHideCategoryHelp: "Products in this category stop appearing on your storefront while this rule is active.",
} as const;
