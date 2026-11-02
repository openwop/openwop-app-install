/**
 * Agent clarification cards (ADR 1001) — an agent that cannot continue without
 * information only a person has asks through the `openwop:ask-user` tool
 * instead of guessing or burying the ask in prose. The run pauses on a `clarification` interrupt, the person answers on
 * the existing card, and the agent continues from where it stopped.
 *
 * The mechanism is core (`host/clarificationLift.ts`, `host/agentClarificationTurn.ts`,
 * `host/clarificationCheckpoint.ts`, the executor's durable suspend keys), because
 * every caller is core. This package owns only what a feature may: the toggle,
 * the run-start stamp that freezes it per run, and the expiry sweep.
 *
 * @see docs/adr/1001-clarification-cards-both-lanes.md
 */
import type { BackendFeature } from '../types.js';
import { registerRunStartContributor, type RunStartContext } from '../../host/runStartContext.js';
import { registerInheritedRunMetadataKey } from '../../host/inheritedRunMetadata.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { CLARIFICATION_STAMP_KEY } from '../../host/agentClarificationTurn.js';
import { CLARIFICATION_ROUNDS_CAP } from '../../host/clarificationLift.js';
import { registerAgentClarificationExpirySweep } from './expirySweep.js';
import { registerAskUserTool } from './askUserTool.js';
import { setChatAskEnabledResolver } from '../../host/clarificationChat.js';

export const AGENT_CLARIFICATION_TOGGLE = 'agent-clarification';
/** ADR 1001 D9 — P2's sub-toggle (ADR 0404 §P4), AND-ed with the parent. */
export const AGENT_CLARIFICATION_CHAT_TOGGLE = 'agent-clarification-chat';

/** The chat ask is on only when the parent AND the sub-toggle are (§P4). */
export async function chatAskEnabled(tenantId: string): Promise<boolean> {
  const [parent, chat] = await Promise.all([
    resolveOne(AGENT_CLARIFICATION_TOGGLE, { tenantId }),
    resolveOne(AGENT_CLARIFICATION_CHAT_TOGGLE, { tenantId }),
  ]);
  return parent?.enabled === true && chat?.enabled === true;
}

/** ADR 1001 D5 — freeze the toggle into the run. A derived (`:fork`) run
 *  inherits the source's value, present or absent: the prompt block it adds is
 *  in the request digest, so re-resolving would break the fork's replay. */
export async function agentClarificationContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {};
  const t = await resolveOne(AGENT_CLARIFICATION_TOGGLE, { tenantId: ctx.tenantId });
  return t?.enabled ? { [CLARIFICATION_STAMP_KEY]: { v: 1, cap: CLARIFICATION_ROUNDS_CAP } } : {};
}

export const agentClarificationFeature: BackendFeature = {
  id: AGENT_CLARIFICATION_TOGGLE,
  registerRoutes: () => {
    registerRunStartContributor(agentClarificationContributor);
    // A sub-workflow child runs under its parent's decision.
    registerInheritedRunMetadataKey(CLARIFICATION_STAMP_KEY);
    registerAgentClarificationExpirySweep();
    registerAskUserTool();
    setChatAskEnabledResolver(chatAskEnabled);
  },
  toggleDefault: {
    id: AGENT_CLARIFICATION_TOGGLE,
    label: 'Agent clarification questions',
    description:
      'Lets an agent in a workflow stop and ask a person a question when it is missing information, instead of guessing. The run waits on a question card in the run view and the inbox, and the agent continues with the answer. At most five questions per step; unanswered questions expire after a day.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'agent-clarification',
  },
  extraToggleDefaults: [{
    id: AGENT_CLARIFICATION_CHAT_TOGGLE,
    label: 'Agent clarification questions in chat',
    description:
      'Lets an agent in a chat end its reply with a question card (the ask-user tool) when it is missing information only you have. Your answer comes back as your next message. Only for agents that list the tool. A sub-capability of Agent clarification questions.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'agent-clarification-chat',
  }],
};
