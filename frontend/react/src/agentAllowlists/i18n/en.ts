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
  usingManifest: 'Pack default + platform tools',
  explainer: 'Checked tools are offered to this agent. Six platform tools are on by default for every agent (tagged “default-on”); unchecking one revokes it for this agent, checking another grants it. A tool that isn’t currently installed is offered only once its pack is mounted.',
  toolChecklistLabel: 'Tools for {{label}}',
  defaultOnTag: 'default-on',
  manifestTag: 'pack default',
  notMountedTag: 'not mounted',
  resetToManifest: 'Reset to pack default',
  saveOverride: 'Save override',
  pinWarning: 'Saving pins this agent to the tools checked here. It will no longer automatically receive new default-on tools until you Reset to pack default.',
  saving: 'Saving…',
  loadFailedTitle: "Could not load the tool allowlists",
  loadFailedBody: "This is a failed read, not an empty list — each agent’s allowlist is unchanged.",
  retry: "Try again",
} as const;
