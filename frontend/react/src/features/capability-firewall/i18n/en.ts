/**
 * `capability-firewall` namespace (ADR 0135) — the composition-rule manager,
 * clarity redesign: plain-language classes + sentence-style rules.
 */
export const messages = {
  eyebrow: 'Access & data',
  title: 'Capability firewall',
  lede: 'Require approval (or block) when an AI run combines risky steps — like reading data and then sending it off-host.',
  org: 'Organization',
  usingDefault: 'using default',

  // Explainer
  whatTitle: 'What this does',
  whatBody: 'AI agents call tools to get work done. Reading data is fine; sending data out is fine — but reading data and then sending it off-host is how information leaks. This firewall watches the combination of what a run has already done and what a tool is about to do, and can pause for approval or block it.',

  // Plain-language classes (chosen to read after both “did …” and “tries to …”)
  tierPure: 'just compute',
  tierRead: 'read data',
  tierWrite: 'change data',
  tierExec: 'run code',
  egrNone: 'keep data in the app',
  egrSafeFetch: 'read the public web',
  egrHostMediated: 'send data via a connected app',
  egrHostOwned: 'act on your behalf',
  scopeClass: 'scope: {{scope}}',

  // Rules list
  rulesHeading: 'Active rules',
  emptyTitle: 'On, but watching nothing yet',
  emptyBody: 'No rules means every tool combination is allowed. Add the recommended rule below, or build your own.',
  sentRunDid: 'If a run did',
  sentAndTool: 'and a tool tries to',
  sentToolOnly: 'If a tool tries to',
  verdictDeny: 'deny',
  verdictRequireApproval: 'require approval',
  remove: 'Remove',
  removeRuleConfirm: 'Remove this rule?',
  removeRuleAria: 'Remove rule {{desc}}',

  // Recommended rule
  recommendedTitle: 'Recommended rule',
  recommendedBody: 'Ask for approval when a run reads data and a tool then tries to send it off-host — the most common leak.',
  recommendedAdd: 'Add recommended rule',
  recommendedDesc: 'Reading data then sending it off-host',
  recommendedReason: 'This run read data and is about to send it off-host — approve to proceed.',

  // Builder
  addHeading: 'Build a rule',
  anyOfLegend: 'If a run has already…',
  anyOfHint: 'leave blank to match any run',
  withLegend: '…and a tool then tries to…',
  groupAction: 'do this:',
  groupData: 'with data:',
  verdictLabel: 'then',
  reasonPlaceholder: 'Reason shown to the user (optional)',
  addRule: 'Add rule',
  needWith: 'Pick at least one thing the next tool might do.',
  customRule: 'Custom rule',

  // Builder live preview
  previewLabel: 'Preview',
  previewWithAny: 'If a run did {{any}} and a tool tries to {{next}}',
  previewNoAny: 'If a tool tries to {{next}}',
  previewDeny: 'block it',
  previewApproval: 'ask for approval',
  orJoin: ' or ',

  // Unclassified-tools posture
  policyHeading: 'Tools we can’t classify',
  policyBody: 'Custom and third-party tools may not be classified yet. Choose what the firewall assumes about them.',
  policySkipLabel: 'Allow them — only classified tools are checked',
  policyRiskyLabel: 'Treat as risky — safer, but may prompt for approval more often',

  // States
  loading: 'Loading…',
  loadOrgsFailed: 'Failed to load organizations.',
  loadFailed: 'Failed to load rules.',
  saveFailed: 'Failed to save rules.',
  saved: 'Firewall rules saved',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization to configure the capability firewall.',
};
