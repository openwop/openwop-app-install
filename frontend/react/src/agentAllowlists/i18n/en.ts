/**
 * `agentAllowlists` namespace — the super-admin agent tool-allowlist editor (ADR 0104).
 * Feature-self-contained copy; the nav label/hint live in the `nav` namespace.
 */
export const messages = {
  eyebrow: 'Platform',
  title: 'Agent tool allowlists',
  lede: 'Grant or revoke the tools an agent is offered — without editing a pack. Overrides apply per workspace and take effect on the next run.',
  loading: 'Loading agents…',
  loadFailed: 'Failed to load agents.',
  saveFailed: 'Failed to save the override.',
  resetFailed: 'Failed to reset to the manifest.',
  noAgentsTitle: 'No agents found',
  noAgentsBody: 'No dispatchable agents are installed for this workspace.',
  agentListLabel: 'Agents',
  overriddenChip: 'override',
  pickAgentTitle: 'Pick an agent',
  pickAgentBody: 'Choose an agent on the left to view and edit the tools it is offered.',
  agentIdChip: 'id: {{id}}',
  usingOverride: 'Override ({{n}} tools)',
  usingManifest: 'Using pack default',
  explainer: 'Checked tools are offered to this agent. Unchecking a pack-default tool revokes it; checking another grants it. A tool that isn’t currently installed is offered only once its pack is mounted.',
  toolChecklistLabel: 'Tools for {{label}}',
  manifestTag: 'pack default',
  notMountedTag: 'not mounted',
  resetToManifest: 'Reset to pack default',
  saveOverride: 'Save override',
  saving: 'Saving…',
} as const;
