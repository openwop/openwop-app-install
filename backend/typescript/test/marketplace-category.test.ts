/**
 * ADR 0312 + RFC 0131 — `categoryOf`, the marketplace's display taxonomy: an agent
 * pack whose agents are ALL composable skills is a "Skill", anything else an
 * "Agent"; an explicit RFC 0131 `role` wins over the `handoff` heuristic.
 *
 * Sabotage witnesses (wave 10): empty-agents → Skill, ignoring an explicit
 * `role` (either value), `handoff` heuristic → always true, or the `.nodes`
 * branch → 'Pack' each turns its case red.
 */
import { describe, it, expect } from 'vitest';
import { categoryOf } from '../src/features/marketplace/listingService.js';

type AgentFixture = { persona?: string; role?: string; handoff?: unknown };
const m = (name: string, agents?: AgentFixture[]) => ({ name, ...(agents ? { agents } : {}) });
const worker = { persona: 'x', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };
const assistant = { persona: 'x' }; // no handoff — an orchestrator/named agent
// RFC 0131 — explicit AgentManifest.role
const skillRole = { persona: 'x', role: 'skill', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };
const assistantRole = { persona: 'x', role: 'assistant', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };
// An explicit skill WITHOUT a handoff — only the explicit role can make it a Skill.
const skillNoHandoff = { persona: 'x', role: 'skill' };

describe('categoryOf — Skill vs Agent taxonomy (ADR 0312)', () => {
  it('an agent pack whose agents are ALL handoff-workers → "Skill"', () => {
    expect(categoryOf(m('core.openwop.agents.code-reviewer', [worker]))).toBe('Skill');
    expect(categoryOf(m('core.openwop.agents.support-crew', [worker, worker, worker]))).toBe('Skill'); // crew, all handoff
    expect(categoryOf(m('vendor.openwop-app.crm.agents', [worker]))).toBe('Skill');
  });

  it('a handoff-less or mixed agent pack → "Agent" (an orchestrator/named agent)', () => {
    expect(categoryOf(m('vendor.openwop-app.assistant.agents', [assistant]))).toBe('Agent');
    expect(categoryOf(m('vendor.openwop-app.assistant.agents', [worker, assistant]))).toBe('Agent'); // mixed
  });

  it('an agent pack with no/empty agents is NOT vacuously a Skill', () => {
    expect(categoryOf(m('core.openwop.agents.empty', []))).toBe('Agent');
    expect(categoryOf(m('core.openwop.agents.nomanifest'))).toBe('Agent');
  });

  it('RFC 0131 — an explicit role is authoritative (never inferred)', () => {
    // all role:"skill" → Skill
    expect(categoryOf(m('core.openwop.agents.code-reviewer', [skillRole]))).toBe('Skill');
    expect(categoryOf(m('core.openwop.agents.support-crew', [skillRole, skillRole]))).toBe('Skill');
    // the role is authoritative even with no handoff contract to infer from
    expect(categoryOf(m('core.openwop.agents.x', [skillNoHandoff]))).toBe('Skill');
    // a role:"assistant" anywhere → Agent (a named/assistant agent), even with a handoff contract
    expect(categoryOf(m('vendor.openwop-app.assistant.agents', [assistantRole]))).toBe('Agent');
    expect(categoryOf(m('vendor.openwop-app.assistant.agents', [skillRole, assistantRole]))).toBe('Agent'); // mixed
  });

  it('RFC 0131 — role and the handoff heuristic compose per-agent', () => {
    // role:"skill" + a role-less handoff worker → all resolve to skill → Skill
    expect(categoryOf(m('core.openwop.agents.mix', [skillRole, worker]))).toBe('Skill');
    expect(categoryOf(m('core.openwop.agents.mix', [skillNoHandoff, worker]))).toBe('Skill');
    // role:"skill" + a role-less handoff-LESS agent → the latter fails → Agent
    expect(categoryOf(m('core.openwop.agents.mix', [skillRole, assistant]))).toBe('Agent');
  });

  it('non-agent packs are unchanged', () => {
    expect(categoryOf(m('core.openwop.storage.nodes', [worker]))).toBe('Node pack');
    expect(categoryOf(m('feature.crm.nodes'))).toBe('Node pack');
    expect(categoryOf(m('feature.commerce'))).toBe('Feature pack');
    expect(categoryOf(m('core.openwop.a2a'))).toBe('Pack');
  });
});
