/**
 * `identity.md` §5 / `ids.schema.json` — THE INBOUND ID GRAMMAR IS ENFORCED.
 *
 * v2 makes `/` a legitimate character in a runId. That makes every host which
 * ever used a runId as a storage key a path-safety question, not just an
 * identity one: a peer host on a segment-structured store had the permissive
 * "split on the first slash" turn into a cross-tenant read, because the id
 * re-pointed the reference at a different document and the authorization check
 * gated on a field that document did not carry.
 *
 * This host is not exploitable that way — bound SQL parameters, and the one
 * object-key site keys on a stored (minted) id. That is a property of our
 * storage engine, not of the guard. The grammar is enforced here so the guard
 * stops depending on a downstream detail it does not control.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and that is deliberate. A guard that refuses
 * everything passes every "malformed is refused" test while breaking every real
 * caller, so "refuses the bad input" and "refuses all input" are
 * indistinguishable from the negative tests alone. The accepting legs below are
 * what tell those apart.
 */
import { describe, expect, it } from 'vitest';
import { fromWireRunId, toWireRunId } from '../src/host/v2Ids.js';

const TENANT = 'acme';
const UUID = '11111111-2222-4333-8444-555555555555';

describe('fromWireRunId — the §5 grammar, inbound', () => {
  // ── ACCEPTS (the fail-closed direction: a guard that rejects all reddens here)
  it('accepts a bare id verbatim (v1 clients and this host’s own frontend)', () => {
    expect(fromWireRunId(UUID, TENANT)).toEqual({ ok: true, runId: UUID });
  });

  it('accepts the tenant-bound form and strips the segment', () => {
    expect(fromWireRunId(`${TENANT}/${UUID}`, TENANT)).toEqual({ ok: true, runId: UUID });
  });

  it('round-trips with toWireRunId', () => {
    const wire = toWireRunId(UUID, TENANT);
    expect(wire).toBe(`${TENANT}/${UUID}`);
    expect(fromWireRunId(wire, TENANT)).toEqual({ ok: true, runId: UUID });
  });

  // ── REFUSES (the fail-open direction: a guard that accepts all reddens here)
  it('refuses a foreign tenant segment', () => {
    expect(fromWireRunId(`other/${UUID}`, TENANT).ok).toBe(false);
  });

  it('refuses a SECOND separator — the remainder must be one opaque segment', () => {
    // Was accepted before the fix, yielding runId "a/b" with the slash intact.
    const r = fromWireRunId(`${TENANT}/${UUID}/events`, TENANT);
    expect(r.ok, 'a tenant-bound id has EXACTLY one separator').toBe(false);
  });

  it('refuses a leading separator', () => {
    // Was returned VERBATIM before the fix (the `slash <= 0` branch), so
    // `/etc/passwd` reached the route handler as a runId.
    expect(fromWireRunId('/etc/passwd', TENANT).ok).toBe(false);
  });

  it('refuses an opaque half outside the grammar', () => {
    expect(fromWireRunId(`${TENANT}/short`, TENANT).ok, 'under 16 chars').toBe(false);
    expect(fromWireRunId(`${TENANT}/has space 0123456789`, TENANT).ok, 'space').toBe(false);
  });

  it('never leaks existence: a malformed id and a foreign one refuse alike', () => {
    // A caller that can distinguish "malformed" from "not yours" learns which
    // tenant segments are real.
    const malformed = fromWireRunId(`${TENANT}/x`, TENANT);
    const foreign = fromWireRunId(`other/${UUID}`, TENANT);
    expect(Object.keys(malformed).sort()).toEqual(Object.keys(foreign).sort());
  });
});
