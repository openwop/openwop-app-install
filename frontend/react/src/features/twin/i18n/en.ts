/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agents you’ve allowed to recall your corpus as your <0>digital twin</0>. Revoking stops all further recall at once — including partway through a turn already running. It cannot take back what was already retrieved: content recalled earlier in that same turn stays in it, and it cannot unsay what an agent already wrote into an earlier conversation. Recall answers only you: when anyone else — a colleague, or an unattributed automation — addresses your twin, it gets nothing from your memory. In a live voice call, content composed at the start of the call stays with that call until it ends.',
  failedToLoadGrants: 'Failed to load grants.',
  recallRevokedEverywhere: 'Recall revoked. No further recall, from this moment on.',
  revokeFailed: 'Revoke failed.',
  loading: 'Loading…',
  noAgentTitle: 'No agent can recall your memory',
  noAgentBody: 'Open an agent’s <0>Integrations tab</0> to make it your twin and allow recall. It then appears here.',
  noScopes: 'no scopes',
  identityUnknown: 'We could not confirm which profile is yours, so we can’t tell whether this twin is linked to you. Recall settings are hidden until that is known — this is not confirmation that no recall is granted.',
  twinOfUnknown: 'Twin of (owner unconfirmed)',
  agentNamesUnavailable: 'Agent names could not be loaded, so the grants below show raw agent ids. Revoking still works.',
  revoke: 'Revoke',
  revokeNothingToRevoke: 'Nothing to revoke — that access had already ended.',
  scopeUnknown: 'an unrecognised kind of access',
  // TWIN-UX-4 — use-visibility on the grant cards
  failedToLoadRecalls: 'Failed to load recall activity.',
  recallsUnavailable: 'Recall activity could not be loaded — this is a failed read, not confirmation that nothing was recalled.',
  lastRecalled_one: 'Last recalled {{date}} · {{count}} time',
  lastRecalled_other: 'Last recalled {{date}} · {{count}} times',
  neverRecalled: 'Never recalled yet.',
  deniedRecallAttempts_one: '{{count}} attempt by someone else was denied',
  deniedRecallAttempts_other: '{{count}} attempts by someone else were denied',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Digital twin',
  panelIntro: 'Link {{persona}} to a person so it can act as their digital twin. The agent can recall that person’s memory or knowledge <0>only after they grant it</0> — a link alone grants nothing.',
  failedToLoadTwinLink: 'Failed to load twin link.',
  twinLoadFailedBody: "Could not read {{persona}}'s twin link. This is a failed read, not an answer — it does not mean {{persona}} is unlinked, so the link action is withheld until it succeeds.",
  twinRetry: 'Try again',
  actionFailed: 'Action failed.',
  notTwinYet: '{{persona}} isn’t a twin of anyone yet.',
  nowYourTwin: '{{persona}} is now your twin.',
  makeTwinOfMe: 'Make {{persona}} a twin of me',
  twinOfYou: 'Twin of <0>you</0>',
  twinOfPerson: 'Twin of',
  twinLinkRemoved: 'Twin link removed.',
  unlink: 'Unlink',
  unlinkConfirmTitle: 'Unlink {{persona}} from this person?',
  unlinkConfirmBody: 'This removes the twin link AND revokes {{name}}’s consent for {{persona}} to recall their memory or knowledge. They are not notified. They can grant it again after you re-link.',
  unlinkConfirmBodySelf: 'This removes the twin link AND revokes your consent for {{persona}} to recall your memory or knowledge. You can grant it again after you re-link.',
  unlinkNothingRemoved: 'There was no twin link to remove.',
  allowRecallHeading: 'Allow {{persona}} to recall your…',
  scopeMemory: 'memory',
  scopeKnowledge: 'knowledge',
  recallConsentSaved: 'Recall consent saved.',
  updateConsent: 'Update consent',
  allowRecall: 'Allow recall',
  recallRevoked: 'Recall revoked.',
  revokeRecall: 'Revoke recall',
  recallActive: 'Active — {{persona}} can recall your {{scopes}}. Revoking stops all further recall at once; content already recalled — even earlier in the same turn — stays, and it cannot unsay what {{persona}} already wrote. It recalls only when you yourself are the one talking to it — anyone else gets nothing.',
  recallActiveNothing: 'nothing',
  recallActiveEmpty: 'Active, but with no scopes selected — {{persona}} can read nothing. Choose memory or knowledge above.',
  noRecallGranted: 'No recall granted yet — {{persona}} can’t read your memory or knowledge.',
  onlyLinkedCanAllow: 'Only {{name}} can allow {{persona}} to recall their memory or knowledge.',
  grantsLoadFailedTitle: "Could not load agent access",
  grantsLoadFailedBody: "This is a failed read, not an empty list — it does not mean no agent has access to you.",
  grantsRetry: "Try again",

  // ProfilePage — the twin tab when the FEATURE-TOGGLE read itself failed
  toggleReadFailedTitle: 'Could not check whether twin recall is enabled here',
  toggleReadFailedBody: 'The feature check failed, so we can’t show your consent dashboard — this is a failed read, not confirmation that recall is off or that no agent has access to you.',
} as const;
