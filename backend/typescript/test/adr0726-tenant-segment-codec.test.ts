/**
 * ADR 0726 — the tenant SEGMENT of a bound id (and every plain `tenantId`-typed
 * field) is projected onto the corpus grammar with the RFC 0184 byte-escape.
 *
 * This host's personal workspaces are `user:<sha256[:32]>`; `identity.md` §5's
 * tenantId grammar admits no `:`. Before this ADR `toWireRunId` silently returned
 * the id BARE for such a tenant (every bound kind unbound for every signed-in
 * user's default workspace) and `fromWireRunId` refused the raw spelling with a
 * 403. Measured on the full suite 2026-09-17: 120 of 128 remaining wire errors.
 *
 * Tracker TST-BAA-9. The key-shape table itself (every `toWireTenant` row,
 * round-trip, injectivity) is `adr0814-wire-tenant.test.ts`; this file keeps the
 * BINDING and REFUSAL legs. Red when (sabotage-witnessed, wave 60):
 * `fromWireRunId` stops comparing the tenant segment, or stops enforcing the
 * opaque grammar; `toWireRunId` binds the raw tenant; tenant fields are not
 * projected; the `user:` row maps elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { fromWireRunId, fromWireTenant, projectV2RunIds, toWireRunId, toWireTenant, V2_TENANT_FIELD_KEYS, V2_TENANT_ID } from '../src/host/v2Ids.js';

const PERSONAL = 'user:0123456789abcdef0123456789abcdef';
// CORRECTED by ADR 0814: ADR 0726's `user~3A…` minted `~`, which identity.md §5
// forbids. The wire tenant is now the grammar-clean `u-…`. The old spelling is
// still ACCEPTED on input (pinned in adr0814-wire-tenant.test.ts).
const WIRE_PERSONAL = 'u-0123456789abcdef0123456789abcdef';
const OPAQUE = 'c99ec4da-bd97-4057-a58c-bc7bc27491f7';

describe('ADR 0726 — tenant segment codec', () => {
  it('a grammar-valid tenant is untouched; a personal `user:` tenant projects to a grammar-valid, reversible spelling', () => {
    expect(toWireTenant('default')).toBe('default');
    expect(toWireTenant('org-1a2b3c4d')).toBe('org-1a2b3c4d');
    expect(toWireTenant(PERSONAL)).toBe(WIRE_PERSONAL);
    expect(V2_TENANT_ID.test(WIRE_PERSONAL), 'the projected form IS inside the corpus grammar').toBe(true);
    expect(fromWireTenant(WIRE_PERSONAL)).toBe(PERSONAL);
    expect(fromWireTenant('default')).toBe('default');
    expect(toWireTenant('anon:abc'), 'ADR 0760: an anon tenant is inside the corpus grammar, so it passes through raw (and its runs bind)').toBe('anon:abc');
    expect(toWireRunId(OPAQUE, 'anon:abc'), 'ADR 0760: anonymous runs bind').toBe(`anon:abc/${OPAQUE}`);
  });

  it('toWireRunId BINDS under a personal tenant (it used to return the id bare — a silent fail-open)', () => {
    expect(toWireRunId(OPAQUE, PERSONAL)).toBe(`${WIRE_PERSONAL}/${OPAQUE}`);
    expect(toWireRunId(OPAQUE, 'default')).toBe(`default/${OPAQUE}`);
    expect(toWireRunId('short-id', PERSONAL), 'an opaque outside the grammar is never bound (fixture ids)').toBe('short-id');
  });

  it('fromWireRunId accepts the projected AND the raw spelling of a personal tenant, and still refuses a foreign one', () => {
    expect(fromWireRunId(`${WIRE_PERSONAL}/${OPAQUE}`, PERSONAL)).toEqual({ ok: true, runId: OPAQUE });
    expect(fromWireRunId(`${PERSONAL}/${OPAQUE}`, PERSONAL), 'raw spelling: what an SDK binding with the host-ext .active sends').toEqual({ ok: true, runId: OPAQUE });
    expect(fromWireRunId(`${WIRE_PERSONAL}/${OPAQUE}`, 'user:ffffffffffffffffffffffffffffffff').ok).toBe(false);
    expect(fromWireRunId(`default/${OPAQUE}`, PERSONAL).ok).toBe(false);
    expect(fromWireRunId(`${WIRE_PERSONAL}/a/b`, PERSONAL).ok, 'the opaque grammar still binds').toBe(false);
    expect(fromWireRunId(`user~3Z/${OPAQUE}`, 'user~3Z').ok, 'a malformed escape is compared verbatim, never decoded into something else').toBe(true);
  });

  it('projects every schema-typed tenant field (owner.tenant, subject.tenant) and every bound kind under the personal tenant', () => {
    expect(V2_TENANT_FIELD_KEYS.has('tenant')).toBe(true);
    expect(V2_TENANT_FIELD_KEYS.has('tenantId')).toBe(true);
    const out = projectV2RunIds({ runId: OPAQUE, owner: { tenant: PERSONAL, subject: { issuer: 'urn:openwop:legacy', subjectId: 'x', tenant: PERSONAL, lane: 'session', kind: 'user' } } }, PERSONAL);
    expect(out).toEqual({
      runId: `${WIRE_PERSONAL}/${OPAQUE}`,
      owner: { tenant: WIRE_PERSONAL, subject: { issuer: 'urn:openwop:legacy', subjectId: 'x', tenant: WIRE_PERSONAL, lane: 'session', kind: 'user' } },
    });
    expect(V2_TENANT_ID.test(WIRE_PERSONAL)).toBe(true);
  });
});
