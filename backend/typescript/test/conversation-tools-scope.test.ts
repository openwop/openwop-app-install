/**
 * ADR 0132 Phase 1 — the pure capability-scope resolver + the run.metadata stamp.
 */
import { describe, it, expect } from 'vitest';
import { resolveCapabilityScope, isNarrowing } from '../src/features/conversation-tools/scopeResolver.js';
import {
  computeCapabilityScopeStamp,
  readCapabilityScopeStamp,
  CAPABILITY_SCOPE_KEY,
} from '../src/features/conversation-tools/capabilityScopeStamp.js';
import type { ConversationCapabilityScope } from '../src/host/conversationStore.js';

const CEILING = ['crm.contact.read', 'crm.contact.update', 'kb.search', 'email.draft'];

describe('resolveCapabilityScope', () => {
  it('agent-default ⇒ the full ceiling, no approvals (no narrowing)', () => {
    expect(resolveCapabilityScope(CEILING, undefined)).toEqual({ enabled: [...CEILING], requireApproval: [] });
    expect(resolveCapabilityScope(CEILING, { mode: 'agent-default' })).toEqual({ enabled: [...CEILING], requireApproval: [] });
  });

  it('enabled restricts to the named subset (intersect with ceiling)', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', enabled: ['kb.search'] };
    expect(resolveCapabilityScope(CEILING, scope)).toEqual({ enabled: ['kb.search'], requireApproval: [] });
  });

  it('NEVER-WIDEN — an enabled entry outside the ceiling is dropped', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', enabled: ['kb.search', 'admin.delete-everything'] };
    const eff = resolveCapabilityScope(CEILING, scope);
    expect(eff.enabled).toEqual(['kb.search']); // admin.delete-everything is NOT granted — not in the ceiling
  });

  it('disabled wins over enabled', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', enabled: ['crm.contact.read', 'crm.contact.update'], disabled: ['crm.contact.update'] };
    expect(resolveCapabilityScope(CEILING, scope).enabled).toEqual(['crm.contact.read']);
  });

  it('disabled with a namespace prefix removes the whole namespace', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', disabled: ['crm'] };
    expect(resolveCapabilityScope(CEILING, scope).enabled).toEqual(['kb.search', 'email.draft']);
  });

  it('empty enabled ⇒ no tools enabled', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', enabled: [] };
    expect(resolveCapabilityScope(CEILING, scope).enabled).toEqual([]);
  });

  it('requireApproval is clamped to the effective enabled set', () => {
    const scope: ConversationCapabilityScope = {
      mode: 'restricted',
      enabled: ['kb.search'],
      requireApproval: ['kb.search', 'email.draft'], // email.draft is not enabled → clamped out
    };
    const eff = resolveCapabilityScope(CEILING, scope);
    expect(eff.enabled).toEqual(['kb.search']);
    expect(eff.requireApproval).toEqual(['kb.search']);
  });

  it('requireApproval by prefix marks every matching enabled tool', () => {
    const scope: ConversationCapabilityScope = { mode: 'restricted', requireApproval: ['crm'] };
    const eff = resolveCapabilityScope(CEILING, scope);
    expect(eff.requireApproval).toEqual(['crm.contact.read', 'crm.contact.update']);
  });
});

describe('isNarrowing', () => {
  it('false for agent-default / absent', () => {
    expect(isNarrowing(CEILING, undefined)).toBe(false);
    expect(isNarrowing(CEILING, { mode: 'agent-default' })).toBe(false);
  });
  it('false when restricted but effectively the full ceiling + no approvals', () => {
    expect(isNarrowing(CEILING, { mode: 'restricted' })).toBe(false);
  });
  it('true when a tool is removed', () => {
    expect(isNarrowing(CEILING, { mode: 'restricted', disabled: ['kb.search'] })).toBe(true);
  });
  it('true when any tool requires approval (even with no removals)', () => {
    expect(isNarrowing(CEILING, { mode: 'restricted', requireApproval: ['kb.search'] })).toBe(true);
  });
});

describe('computeCapabilityScopeStamp', () => {
  it('stamps the effective set when narrowing', () => {
    const eff = { enabled: ['kb.search'], requireApproval: ['kb.search'] };
    const out = computeCapabilityScopeStamp({}, eff, '2026-06-24T00:00:00.000Z');
    expect(out).toEqual({ [CAPABILITY_SCOPE_KEY]: { enabled: ['kb.search'], requireApproval: ['kb.search'], resolvedAt: '2026-06-24T00:00:00.000Z' } });
  });

  it('returns null when there is no narrowing (effective null)', () => {
    expect(computeCapabilityScopeStamp({}, null)).toBeNull();
  });

  it('REPLAY GUARD — returns null when already stamped (never re-resolve on :fork)', () => {
    const existing = { [CAPABILITY_SCOPE_KEY]: { enabled: ['kb.search'], requireApproval: [] } };
    expect(computeCapabilityScopeStamp(existing, { enabled: ['email.draft'], requireApproval: [] })).toBeNull();
  });

  it('preserves other metadata keys', () => {
    const out = computeCapabilityScopeStamp({ modelRoute: { provider: 'anthropic' } }, { enabled: ['kb.search'], requireApproval: [] });
    expect(out).toMatchObject({ modelRoute: { provider: 'anthropic' }, [CAPABILITY_SCOPE_KEY]: { enabled: ['kb.search'] } });
  });
});

describe('readCapabilityScopeStamp', () => {
  it('reads a well-formed stamp verbatim', () => {
    const md = { [CAPABILITY_SCOPE_KEY]: { enabled: ['kb.search'], requireApproval: ['kb.search'], resolvedAt: 'x' } };
    expect(readCapabilityScopeStamp(md)).toEqual({ enabled: ['kb.search'], requireApproval: ['kb.search'], resolvedAt: 'x' });
  });
  it('returns null for unstamped / malformed metadata', () => {
    expect(readCapabilityScopeStamp(undefined)).toBeNull();
    expect(readCapabilityScopeStamp({})).toBeNull();
    expect(readCapabilityScopeStamp({ [CAPABILITY_SCOPE_KEY]: { enabled: 'nope' } })).toBeNull();
  });
});
