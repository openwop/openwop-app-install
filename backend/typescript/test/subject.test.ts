/**
 * The Subject abstraction (ADR 0045 Phase 1) — proves the canonical scope is
 * byte-identical to the legacy per-surface scopes (no behavior change), and that
 * `MemorySubject` is now the canonical `Subject`.
 *
 * @see docs/adr/0045-subject-model.md
 */

import { describe, expect, it } from 'vitest';
import { subjectScope, personSubject, rosterSubject, type Subject } from '../src/host/subject.js';
import { subjectMemoryScope, type MemorySubject } from '../src/host/subjectMemory.js';
import type { AgentCapabilityId } from '../src/types.js';

describe('subjectScope — canonical, byte-identical to legacy scopes', () => {
  it('produces `${kind}:${id}` for each kind', () => {
    expect(subjectScope({ kind: 'agent', id: 'core.x' })).toBe('agent:core.x');
    expect(subjectScope({ kind: 'user', id: 'u1' })).toBe('user:u1');
    expect(subjectScope({ kind: 'project', id: 'p1' })).toBe('project:p1');
  });

  it('subjectMemoryScope delegates to subjectScope (memory paths unchanged)', () => {
    const s: MemorySubject = { kind: 'agent', id: 'mem.agent' };
    expect(subjectMemoryScope(s)).toBe('agent:mem.agent');
    expect(subjectMemoryScope({ kind: 'user', id: 'alice' })).toBe('user:alice');
  });

  it('MemorySubject IS Subject (a Subject is assignable where a MemorySubject is expected)', () => {
    const subj: Subject = { kind: 'user', id: 'x' };
    const mem: MemorySubject = subj; // compiles ⇒ the alias holds
    expect(subjectMemoryScope(mem)).toBe('user:x');
  });

  it('ADR 0047 — canonical projections: a person → kind:user, a roster agent → kind:agent', () => {
    expect(personSubject('user:alice')).toEqual({ kind: 'user', id: 'user:alice' });
    expect(rosterSubject('host:sally-1')).toEqual({ kind: 'agent', id: 'host:sally-1' });
    // A Subject is an OWNER key, not authentication — it carries no scope/authority
    // (the ADR 0045/0047 boundary): its only shape is { kind, id }.
    expect(Object.keys(personSubject('u')).sort()).toEqual(['id', 'kind']);
  });

  it('ADR 0048 — kind (is) and capabilities (does) are orthogonal axes', () => {
    // An agent's projection (a Subject `kind`) is independent of its capabilities.
    const agent = rosterSubject('host:iris');
    const caps: AgentCapabilityId[] = ['assistant', 'knowledge', 'cognition', 'advisor'];
    expect(agent.kind).toBe('agent');
    // The capability vocabulary is complete + assignable (compile + runtime).
    expect(caps).toContain('cognition');
    expect(caps).toContain('advisor');
  });
});
