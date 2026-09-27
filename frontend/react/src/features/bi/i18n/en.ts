/** `bi` namespace (ADR 0417) — the governed business-metrics admin. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Business metrics belong to an organization',
  orgsFailedClause: 'The metric list was never requested',
  orgsRetry: 'Try again',
  rowsFailedTitle: 'Could not load metrics',
  rowsFailedBody: 'This is a failed read, not an empty list — it does not mean no metrics are defined.',
  eyebrow: "Business Tools",
  title: "Business metrics",
  lede: "Governed metric definitions over your workspace data \u2014 runnable from chat, workflows, and the dashboard.",
  // ONE noun. This was the last "workspace org" on the page — es/fr/pt-BR all
  // already said "organization", so English was the outlier as well as the
  // contradiction.
  colTitle: "Metric",
  colEntity: "Entity type",
  colAggregate: "Aggregate",
  colGrouping: "Grouping",
  systemChip: "System",
  run: "Run",
  running: "Running\u2026",
  runEmpty: "No rows matched.",
  runKeyAll: "All",
  runResultAria: "Result for {{title}}",
  edit: "Edit",
  delete: "Delete",
  newMetric: "New metric",
  createTitle: "Define a metric",
  editTitle: "Edit metric",
  fieldId: "Metric id",
  fieldTitle: "Title",
  fieldEntity: "Entity type",
  fieldEntityPick: "Choose a type\u2026",
  fieldAggregate: "Aggregate",
  fieldField: "Field (numeric)",
  fieldGroupBy: "Group by (optional)",
  fieldTimeField: "Time field (optional)",
  fieldDescription: "Description (optional)",
  save: "Save metric",
  saving: "Saving\u2026",
  cancel: "Cancel",
  deleteTitle: "Delete this metric?",
  deleteBody: "\u201c{{title}}\u201d will be removed. Dashboards or workflows referencing it will report it as missing.",
  deleteConfirm: "Delete metric",
  emptyTitle: "No metrics yet",
  emptyBody: "Define a metric over your deals, products, companies, or custom entities.",
  typesFailed: "Could not load this workspace’s entity types — the picker below shows only the built-in ones, and field suggestions are unavailable.",
  typesRetry: "Try again",
  typesFailedHelp: "Built-in types only — the workspace’s own types could not be loaded.",
};
