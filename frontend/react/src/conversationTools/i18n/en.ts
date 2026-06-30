/**
 * `conversationTools` namespace (ADR 0132) — the per-conversation tool-scope panel
 * (scope editor + per-tool approvals). Feature-self-contained catalog.
 */
export const messages = {
  openTitle: 'Tool scope for this conversation',
  heading: 'Conversation tool scope',
  blurb: 'Control which of the agent’s tools it may use in this conversation, and which need your approval first. Narrowing only — this never grants tools beyond the agent’s permissions.',
  pendingHeading: 'Pending approvals',
  noPending: 'No tools are awaiting approval.',
  approve: 'Approve',
  deny: 'Deny',
  approveAria: 'Approve {{tool}}',
  denyAria: 'Deny {{tool}}',
  scopeHeading: 'Tool access',
  modeLegend: 'Tool scope mode',
  modeDefault: 'Agent default (all the agent’s tools)',
  modeRestricted: 'Restricted (only the tools below)',
  list_enabled: 'Enabled',
  list_disabled: 'Disabled',
  list_requireApproval: 'Requires approval',
  addPlaceholder: 'tool id (e.g. crm.contact.update)',
  removeAria: 'Remove {{tool}}',
  close: 'Close',
  save: 'Save scope',
  saving: 'Saving…',
  saved: 'Tool scope saved',
  loadFailed: 'Failed to load the tool scope.',
  decisionFailed: 'Failed to record your decision.',
  saveFailed: 'Failed to save the tool scope.',
};
