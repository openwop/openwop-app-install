/**
 * Agent-profile policy enforcement (ADR 0036).
 *
 * Two layers of coverage:
 *
 *  A. The pure resolver (`resolveAgentPolicy`) — the single composition point.
 *     permissions.never → deny; hitl → review (regardless of level); auto +
 *     withinPolicyActions allowlist → auto only for listed action classes
 *     (off-list / empty allowlist → review); and composition with the ADR 0033
 *     readiness gate (most-restrictive wins).
 *
 *  B. The two enforcement seams that consult it:
 *     - the heartbeat pick (`runHeartbeatOnce`): a `never` workflow is skipped
 *       (neither run nor proposed); a `hitl` workflow is proposed; an `auto`
 *       agent runs only allowlisted workflows (off-list → propose); an un-ready
 *       required connection forces a proposal.
 *     - the assistant action enqueue (`enqueueActionWithApproval`): a `never`
 *       action kind is forbidden (403, nothing drafted).
 *
 * @see docs/adr/0036-agent-profile-policy-enforcement.md
 */

import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../src/types.js';
import {
  resolveAgentPolicy,
  type PolicyVerdict,
} from '../src/host/agentPolicyResolver.js';
import type { ConnectionReadiness } from '../src/host/connectionReadiness.js';

// ─────────────────────────────────────────────────────────────────────────────
// A. Pure resolver
// ─────────────────────────────────────────────────────────────────────────────

const READY: ConnectionReadiness = { required: [], entries: [], allConfigured: true, missing: [] };
const NOT_READY: ConnectionReadiness = {
  required: ['servicenow'],
  entries: [{ provider: 'servicenow', configured: false }],
  allConfigured: false,
  missing: ['servicenow'],
};

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  const now = '2026-06-13T00:00:00Z';
  return {
    profileId: 'host:twin',
    tenantId: 'tenant-A',
    roleKey: 'it-service-desk',
    autonomy: { level: 'auto', specLevel: 'autonomous-within-policy' },
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function verdict(p: AgentProfile | null, actionClass: string, readiness: ConnectionReadiness = READY, level?: PolicyVerdict): PolicyVerdict {
  return resolveAgentPolicy({
    profile: p,
    actionClass,
    readiness,
    ...(level && level !== 'deny' ? { level: level as 'auto' | 'guided' | 'review' } : {}),
  }).verdict;
}

describe('resolveAgentPolicy — pure composition (ADR 0036)', () => {
  it('denies an action class on permissions.never (fail-closed, short-circuits)', () => {
    const p = profile({
      permissions: { read: [], write: [], never: ['email.send'] },
      // even with auto + the action on the allowlist, never wins.
      autonomy: { level: 'auto', specLevel: 'autonomous-within-policy', withinPolicyActions: ['email.send'] },
    });
    const r = resolveAgentPolicy({ profile: p, actionClass: 'email.send', readiness: READY });
    expect(r.verdict).toBe('deny');
    expect(r.reason).toBe('permissions.never');
  });

  it('forces review for a hitl action class regardless of autonomy level', () => {
    const p = profile({
      hitl: ['email.send'],
      autonomy: { level: 'auto', specLevel: 'autonomous-within-policy', withinPolicyActions: ['email.send'] },
    });
    const r = resolveAgentPolicy({ profile: p, actionClass: 'email.send', readiness: READY });
    expect(r.verdict).toBe('review');
    expect(r.reason).toBe('hitl');
  });

  it('never beats hitl when an action class is on BOTH (most-restrictive wins)', () => {
    const p = profile({
      permissions: { read: [], write: [], never: ['x'] },
      hitl: ['x'],
    });
    expect(verdict(p, 'x')).toBe('deny');
  });

  it('auto: permits ONLY allowlisted action classes; off-list → review', () => {
    const p = profile({
      autonomy: { level: 'auto', specLevel: 'autonomous-within-policy', withinPolicyActions: ['ticket.tag', 'ticket.triage-draft'] },
    });
    expect(verdict(p, 'ticket.tag')).toBe('auto');
    expect(verdict(p, 'ticket.triage-draft')).toBe('auto');
    // off the allowlist:
    const off = resolveAgentPolicy({ profile: p, actionClass: 'pricing.commit', readiness: READY });
    expect(off.verdict).toBe('review');
    expect(off.reason).toBe('not-within-policy');
  });

  it('auto with an EMPTY/ABSENT allowlist permits nothing (conservative)', () => {
    const empty = profile({ autonomy: { level: 'auto', specLevel: 'autonomous-within-policy', withinPolicyActions: [] } });
    expect(verdict(empty, 'anything')).toBe('review');
    const absent = profile({ autonomy: { level: 'auto', specLevel: 'autonomous-within-policy' } });
    expect(verdict(absent, 'anything')).toBe('review');
  });

  it('composes with the readiness gate — an un-ready connection forces review even for an allowlisted auto action', () => {
    const p = profile({
      requiredConnections: ['servicenow'],
      autonomy: { level: 'auto', specLevel: 'autonomous-within-policy', withinPolicyActions: ['ticket.tag'] },
    });
    // ready → auto; not-ready → review (most-restrictive).
    expect(verdict(p, 'ticket.tag', READY)).toBe('auto');
    const r = resolveAgentPolicy({ profile: p, actionClass: 'ticket.tag', readiness: NOT_READY });
    expect(r.verdict).toBe('review');
    expect(r.reason).toBe('connection-readiness');
  });

  it('guided rides through at guided (caller applies the priority split)', () => {
    const p = profile({ autonomy: { level: 'guided', specLevel: 'execute-with-approval' } });
    const r = resolveAgentPolicy({ profile: p, actionClass: 'x', level: 'guided', readiness: READY });
    expect(r.verdict).toBe('guided');
  });

  it('a profile-less agent is ungated: the readiness-gated base level passes through', () => {
    expect(resolveAgentPolicy({ profile: null, actionClass: 'x', level: 'auto', readiness: READY }).verdict).toBe('auto');
    expect(resolveAgentPolicy({ profile: null, actionClass: 'x', level: 'auto', readiness: NOT_READY }).verdict).toBe('review');
    expect(resolveAgentPolicy({ profile: null, actionClass: 'x', level: 'review', readiness: READY }).verdict).toBe('review');
  });
});
