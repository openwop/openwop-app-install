import { describe, it, expect } from 'vitest';
import { categoryOf } from '../src/features/marketplace/listingService.js';

const m = (name: string, agents?: unknown[]) => ({ name, ...(agents ? { agents } : {}) }) as Parameters<typeof categoryOf>[0];
const worker = { persona: 'x', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };
const assistant = { persona: 'x' }; // no handoff — an orchestrator/named agent
// RFC 0131 — explicit AgentManifest.role
const skillRole = { persona: 'x', role: 'skill', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };
const assistantRole = { persona: 'x', role: 'assistant', handoff: { taskSchemaRef: 't', returnSchemaRef: 'r' } };

describe('categoryOf — Skill vs Agent taxonomy (ADR 0312)', () => {
  it('an agent pack whose agents are ALL handoff-workers → "Skill"', () => {
    expect(categoryOf(m('core.openwop.agents.code-reviewer', [worker]))).toBe('Skill');
    expect(categoryOf(m('core.openwop.agents.support-crew', [worker, worker, worker]))).toBe('Skill'); // crew, all handoff
    expect(categoryOf(m('feature.crm.agents', [worker]))).toBe('Skill');
  });

  it('a handoff-less or mixed agent pack → "Agent" (an orchestrator/named agent)', () => {
    expect(categoryOf(m('feature.assistant.agents', [assistant]))).toBe('Agent');
    expect(categoryOf(m('feature.assistant.agents', [worker, assistant]))).toBe('Agent'); // mixed
  });

  it('an agent pack with no/empty agents is NOT vacuously a Skill', () => {
    expect(categoryOf(m('core.openwop.agents.empty', []))).toBe('Agent');
    expect(categoryOf(m('core.openwop.agents.nomanifest'))).toBe('Agent');
  });

  it('RFC 0131 — an explicit role is authoritative (never inferred)', () => {
    // all role:"skill" → Skill
    expect(categoryOf(m('core.openwop.agents.code-reviewer', [skillRole]))).toBe('Skill');
    expect(categoryOf(m('core.openwop.agents.support-crew', [skillRole, skillRole]))).toBe('Skill');
    // a role:"assistant" anywhere → Agent (a named/assistant agent), even with a handoff contract
    expect(categoryOf(m('feature.assistant.agents', [assistantRole]))).toBe('Agent');
    expect(categoryOf(m('feature.assistant.agents', [skillRole, assistantRole]))).toBe('Agent'); // mixed
  });

  it('RFC 0131 — role and the handoff heuristic compose per-agent', () => {
    // role:"skill" + a role-less handoff worker → all resolve to skill → Skill
    expect(categoryOf(m('core.openwop.agents.mix', [skillRole, worker]))).toBe('Skill');
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
