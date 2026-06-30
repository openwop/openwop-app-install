/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agents you’ve allowed to recall your corpus as your <0>digital twin</0>. Revoking takes effect immediately — including on any run already in flight.',
  failedToLoadGrants: 'Failed to load grants.',
  recallRevokedEverywhere: 'Recall revoked — effective immediately, everywhere.',
  revokeFailed: 'Revoke failed.',
  loading: 'Loading…',
  noAgentTitle: 'No agent can recall your memory',
  noAgentBody: 'When you make an agent your twin and allow recall (on the agent’s profile), it appears here.',
  noScopes: 'no scopes',
  revoke: 'Revoke',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Digital twin',
  panelIntro: 'Link {{persona}} to a person so it can act as their digital twin. The agent can recall that person’s memory or knowledge <0>only after they grant it</0> — a link alone grants nothing.',
  failedToLoadTwinLink: 'Failed to load twin link.',
  actionFailed: 'Action failed.',
  notTwinYet: '{{persona}} isn’t a twin of anyone yet.',
  nowYourTwin: '{{persona}} is now your twin.',
  makeTwinOfMe: 'Make {{persona}} a twin of me',
  twinOfYou: 'Twin of <0>you</0>',
  twinOfPerson: 'Twin of',
  twinLinkRemoved: 'Twin link removed.',
  unlink: 'Unlink',
  allowRecallHeading: 'Allow {{persona}} to recall your…',
  scopeMemory: 'memory',
  scopeKnowledge: 'knowledge',
  recallConsentSaved: 'Recall consent saved.',
  updateConsent: 'Update consent',
  allowRecall: 'Allow recall',
  recallRevoked: 'Recall revoked.',
  revokeRecall: 'Revoke recall',
  recallActive: 'Active — {{persona}} can recall your {{scopes}}. Revocation is immediate, everywhere.',
  recallActiveNothing: 'nothing',
  noRecallGranted: 'No recall granted yet — {{persona}} can’t read your memory or knowledge.',
  onlyLinkedCanAllow: 'Only {{name}} can allow {{persona}} to recall their memory or knowledge.',
} as const;
