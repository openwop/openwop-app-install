/**
 * Pure helpers over an inventory row, kept out of `agentsClient.ts` on purpose:
 * tests mock that module down to its fetchers (`vi.mock(…, () => ({ listAgents }))`),
 * and a helper living there is `undefined` under every such mock.
 */
import type { AgentEntry } from './agentsClient.js';

/** issue 5800 — the name a handle is built from. The manifest schema says `persona` is a
 *  human-readable name and "NOT the harnessRole enum", but 39 pack agents set it to a
 *  role token (`RESEARCH` ×30, `WRITER`, `SUPERVISOR`, …). Slugging that gave every one
 *  of them the same base, so the Chief of Staff became `@research-13`. A persona that
 *  is a bare upper-case role token yields to the agent's `label` when it has one; a
 *  real name is used as before, so existing handles do not move. */
export function handleName(agent: Pick<AgentEntry, 'persona' | 'label'>): string {
  return /^[A-Z][A-Z0-9_]*$/.test(agent.persona) && agent.label ? agent.label : agent.persona;
}

/** issue 5799 — packs whose agents are conformance and smoke fixtures (`@echo`,
 *  `@structured-fixture`, `@tool-caller`, …). They stay in the protocol inventory,
 *  because the conformance suite dispatches them, but a person never picks one:
 *  the @ picker and the agents page leave them out. A pack that declares the
 *  `fixtures` keyword must be listed here (`fixtureAgentPacks.test.ts`). */
export const FIXTURE_AGENT_PACKS: ReadonlySet<string> = new Set(['core.openwop.agent-examples']);

export function isFixtureAgent(agent: Pick<AgentEntry, 'packName'>): boolean {
  return FIXTURE_AGENT_PACKS.has(agent.packName);
}
