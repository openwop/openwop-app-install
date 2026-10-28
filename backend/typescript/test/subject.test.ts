/**
 * The Subject abstraction (ADR 0045 Phase 1) — proves the canonical scope is
 * byte-identical to the legacy per-surface scopes (no behavior change), and that
 * `MemorySubject` is now the canonical `Subject`.
 *
 * Wave 61 (grade-tests) cut two cases that asserted nothing of their own: a
 * compile-time alias check whose runtime call duplicated case 2 (probe
 * 8fw3g2-subj-scope reds case 2), and an "orthogonal axes" case whose only
 * product assertion (`rosterSubject(...).kind === 'agent'`) is case 3's
 * (8fw3g2-subj-roster reds case 3); the rest checked its own array literal.
 *
 * @see docs/adr/0045-subject-model.md
 */

import { describe, expect, it } from 'vitest';
import { subjectScope, personSubject, rosterSubject, type Subject } from '../src/host/subject.js';
import { subjectMemoryScope, type MemorySubject } from '../src/host/subjectMemory.js';

describe('subjectScope — canonical, byte-identical to legacy scopes', () => {
  it('produces `${kind}:${id}` for each kind', () => {
    expect(subjectScope({ kind: 'agent', id: 'core.x' })).toBe('agent:core.x');
    expect(subjectScope({ kind: 'user', id: 'u1' })).toBe('user:u1');
    expect(subjectScope({ kind: 'project', id: 'p1' })).toBe('project:p1');
  });

  it('subjectMemoryScope delegates to subjectScope (memory paths unchanged)', () => {
    // `MemorySubject` IS `Subject`: a `Subject` typed value is passed where a
    // MemorySubject is expected (tsc gates the alias; wave 61 folded the former
    // runtime-only "MemorySubject IS Subject" case into this one).
    const subj: Subject = { kind: 'agent', id: 'mem.agent' };
    const s: MemorySubject = subj;
    expect(subjectMemoryScope(s)).toBe('agent:mem.agent');
    expect(subjectMemoryScope({ kind: 'user', id: 'alice' })).toBe('user:alice');
  });

  it('ADR 0047 — canonical projections: a person → kind:user, a roster agent → kind:agent', () => {
    expect(personSubject('user:alice')).toEqual({ kind: 'user', id: 'user:alice' });
    expect(rosterSubject('host:sally-1')).toEqual({ kind: 'agent', id: 'host:sally-1' });
    // A Subject is an OWNER key, not authentication — it carries no scope/authority
    // (the ADR 0045/0047 boundary): its only shape is { kind, id }.
    expect(Object.keys(personSubject('u')).sort()).toEqual(['id', 'kind']);
  });
});
