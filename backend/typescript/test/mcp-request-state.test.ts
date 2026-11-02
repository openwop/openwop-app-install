/**
 * ADR 0553 P2 — the MRTR `requestState` bindings, one leg per binding.
 *
 * `mcp-integration.md` §C.2 turns upstream's SHOULD into a MUST and adds two
 * bindings of its own, so the value carries FIVE facts. The round-trip tests in
 * `mcp-current-codec.test.ts` exercise them through the wire; these exercise
 * each in isolation, because a wire test that happens to pass tells you the
 * chain held — not which link did.
 *
 * Upstream classes `requestState` as attacker-controlled on receipt. Every leg
 * below is therefore an ATTACK, not a happy path with a typo.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { mcpRequestDigest, mintMcpRequestState, verifyMcpRequestState } from '../src/host/mcpRequestState.js';

beforeAll(() => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
});

const CLAIMS = {
  principalId: 'user:ada',
  runId: 'run-1',
  interruptId: 'int-1',
  interruptToken: 'tok-1',
  requestDigest: mcpRequestDigest('tools/call', 'transfer_funds', { amount: 5 }),
};
const EXPECT = { principalId: CLAIMS.principalId, requestDigest: CLAIMS.requestDigest };

describe('the state verifies for the round it was minted for', () => {
  it('round-trips and names the interrupt it resolves', () => {
    const verdict = verifyMcpRequestState(mintMcpRequestState(CLAIMS), EXPECT);
    expect(verdict).toEqual({ ok: true, runId: 'run-1', interruptId: 'int-1' });
  });

  it('is opaque — the interrupt TOKEN is bound by digest, never carried', () => {
    // A state the peer holds must not be a way to LEARN a live capability. The
    // token is hashed into the preimage; it never appears in the value.
    //
    // The value is base64url, so a substring check on the raw state can never
    // see a carried token (MEASURED w72: carrying the raw token left the old
    // `not.toContain('tok-1')` green). Decode the payload half and read it.
    const [payload] = mintMcpRequestState(CLAIMS).split('.') as [string, string];
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    expect(decoded).not.toContain('tok-1');
    const claims = JSON.parse(decoded) as { t?: unknown };
    // Independent derivation (node:crypto), not the function under test.
    expect(claims.t).toBe(createHash('sha256').update('tok-1').digest('base64url'));
  });
});

describe('every binding refuses independently', () => {
  it('a tampered payload fails the MAC', () => {
    const state = mintMcpRequestState(CLAIMS);
    const [payload, mac] = state.split('.') as [string, string];
    const flipped = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), p: 'user:mallory' }),
      'utf8',
    ).toString('base64url');
    expect(verifyMcpRequestState(`${flipped}.${mac}`, { principalId: 'user:mallory', requestDigest: CLAIMS.requestDigest })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('a state minted for another PRINCIPAL is refused', () => {
    const state = mintMcpRequestState(CLAIMS);
    expect(verifyMcpRequestState(state, { ...EXPECT, principalId: 'user:mallory' })).toEqual({ ok: false, reason: 'principal_mismatch' });
  });

  it('a state minted for another REQUEST is refused', () => {
    // The binding that stops a state issued for a harmless tool resolving the
    // gate of an effectful one.
    const state = mintMcpRequestState(CLAIMS);
    const otherDigest = mcpRequestDigest('tools/call', 'transfer_funds', { amount: 5_000_000 });
    expect(verifyMcpRequestState(state, { ...EXPECT, requestDigest: otherDigest })).toEqual({ ok: false, reason: 'request_mismatch' });
  });

  it('expires', () => {
    // The TTL is 15 minutes (900 s) and `exp <= now` is expired, so the
    // boundary is pinned from both sides: one second before is still valid,
    // exactly 900 s is not. (MEASURED w72: the old 1-hour check stayed green
    // with the TTL doubled.)
    const state = mintMcpRequestState(CLAIMS, 0);
    expect(verifyMcpRequestState(state, EXPECT, 0)).toMatchObject({ ok: true });
    expect(verifyMcpRequestState(state, EXPECT, 899_000)).toMatchObject({ ok: true });
    expect(verifyMcpRequestState(state, EXPECT, 900_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('garbage is malformed, not a 500', () => {
    const expected: Array<[string, string]> = [
      ['', 'malformed'],
      ['forged', 'malformed'],
      ['.', 'malformed'],
      // A dot with a payload: reaches the MAC, whose length mismatch is refused
      // cleanly rather than throwing from timingSafeEqual.
      ['a.b', 'bad_signature'],
    ];
    for (const [junk, reason] of expected) {
      expect(verifyMcpRequestState(junk, EXPECT), junk).toEqual({ ok: false, reason });
    }
    expect(verifyMcpRequestState(undefined, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyMcpRequestState({ not: 'a string' }, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the request digest is stable across the round trip', () => {
  it('the retry adds inputResponses + requestState, and the digest must not move', () => {
    // If the digest covered the whole params object, no retry could ever
    // verify — the binding would be self-defeating rather than protective.
    //
    // The digest's preimage is exactly (method, name, arguments): the codec
    // (`mcpCurrentCodec.ts`) passes `params.arguments`, never the whole params
    // object a retry grows. Pinned against an INDEPENDENT sha256 of the literal
    // preimage — hashing the same call twice (the old form) could not fail.
    const expected = createHash('sha256').update('["tools/call","needs_input",{}]').digest('base64url');
    expect(mcpRequestDigest('tools/call', 'needs_input', {})).toBe(expected);
  });

  it('but a changed ARGUMENT moves it', () => {
    expect(mcpRequestDigest('tools/call', 'needs_input', { a: 1 })).not.toBe(mcpRequestDigest('tools/call', 'needs_input', { a: 2 }));
  });
});
