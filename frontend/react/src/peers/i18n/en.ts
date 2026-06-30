/**
 * `peers` namespace — user-facing copy for the A2A peers panel
 * (spec/v1/a2a-integration.md), currently a not-yet-advertised placeholder.
 */
export const messages = {
  title: 'A2A peers',
  specRef: '(spec/v1/a2a-integration.md)',
  introLead: 'Agent2Agent (A2A) composition lets an openwop host appear to remote callers as an A2A agent (each Workflow becomes an',
  introAgentSkill: 'AgentSkill',
  introMid: '; each run becomes a',
  introTask: 'Task',
  introTail: ') and lets workflows dispatch into remote A2A peers.',
  notAdvertised: 'Not advertised by this host.',
  statusLead: 'A2A composition is documented as',
  statusStable: 'stable',
  statusMid1: 'in',
  statusMid2: 'but the capability advertisement shape is still a candidate (the leading shape is',
  statusMid3: ') and',
  statusMid4: 'does not yet define a',
  statusBlock: 'capabilities.a2a',
  statusTail:
    'block. The reference host does not expose itself as an A2A agent and no',
  statusNodeModule: 'NodeModule is registered, so a peer browser has nothing to enumerate against today.',
  pathForwardLead: 'Path forward — published as',
  pathForwardMid: '§3: a non-steward host publishing an A2A AgentCard (MyndHyve already references A2A peers from',
  pathForwardAnd: 'and',
  pathForwardTail:
    ') would converge a concrete',
  pathForwardShape: 'capabilities.a2a',
  pathForwardEnd:
    'shape and unblock this panel — at which point this placeholder becomes the actual peer browser (Agent Card fetch → list of Skills → "drop an',
  pathForwardNode: 'a2a.dispatch',
  pathForwardCta: 'node configured with this Skill" CTA).',
} as const;
