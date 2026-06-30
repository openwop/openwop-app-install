/**
 * `settings` namespace — user-facing strings for the Settings area
 * (`src/settings/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AdminOverviewPage
  adminEyebrow: 'Administration',
  adminTitle: 'Vue d\'ensemble',
  adminLede: 'Configuration de la plateforme et surfaces de console. Le travail quotidien se trouve dans le rail de l\'espace de travail ; tout ce qui configure le déploiement se trouve ici.',

  // ExampleDataPage — header
  exampleDataEyebrow: 'Paramètres',
  exampleDataTitle: 'Données d\'exemple',
  exampleDataLede: 'Chargez des données d\'exemple afin que les tableaux de bord aient quelque chose à afficher — agents, effectifs et leur historique. Tout ici est explicite et clairement identifié comme données d\'exemple ; une installation propre démarre vide.',

  // ExampleDataPage — types list
  typesHeading: 'Types de données d\'exemple',
  typesIntro: 'Idempotent et non destructif : chaque type n\'est créé que là où il manque, de sorte que le chargement ne crée jamais de doublon et ne touche jamais aux données que vous avez créées vous-même. Limité à votre locataire.',
  noTypesTitle: 'Aucun type de données d\'exemple enregistré',
  noTypesBody: 'Cet hôte n\'annonce aucune donnée d\'exemple amorçable.',
  selectAria: 'Sélectionner {{label}}',
  countPresent: '{{n}} présent(s)',

  // ExampleDataPage — actions
  dryRunLabel: 'Simulation (aperçu)',
  loadAllExampleData: 'Charger toutes les données d\'exemple',
  loadSelected: 'Charger la sélection ({{n}})',
  clearExampleData: 'Effacer les données d\'exemple',
  clearTitle: 'Supprimer les entités d\'exemple (vos propres agents ne sont pas touchés)',
  clearing: 'Effacement…',
  clearConfirm: 'Effacer {{label}} ? Cela supprime les entités d\'exemple de votre locataire (vos propres agents ne sont pas touchés).',
  clearAllFallback: 'toutes les données d\'exemple',

  // ExampleDataPage — results
  dryRunNotice: 'Simulation — rien n\'a été écrit.',
  summaryCreated_one: '{{n}} créé',
  summaryCreated_other: '{{n}} créés',
  summaryCleared_one: '{{n}} effacé',
  summaryCleared_other: '{{n}} effacés',
  summarySkipped_one: '{{n}} ignoré',
  summarySkipped_other: '{{n}} ignorés',
  summaryErrors_one: '{{n}} erreur',
  summaryErrors_other: '{{n}} erreurs',

  // ExampleDataPage — per-step action labels
  actionCreated: 'créé',
  actionCleared: 'effacé',
  actionError: 'erreur',
  actionSkipped: 'ignoré',
} as const;
