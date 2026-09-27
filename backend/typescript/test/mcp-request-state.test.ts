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
    expect(mintMcpRequestState(CLAIMS)).not.toContain('tok-1');
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
    const state = mintMcpRequestState(CLAIMS, 0);
    expect(verifyMcpRequestState(state, EXPECT, 0)).toMatchObject({ ok: true });
    expect(verifyMcpRequestState(state, EXPECT, 3_600_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('garbage is malformed, not a 500', () => {
    for (const junk of ['', 'forged', 'a.b', '.']) {
      expect(verifyMcpRequestState(junk, EXPECT).ok, junk).toBe(false);
    }
    expect(verifyMcpRequestState(undefined, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyMcpRequestState({ not: 'a string' }, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the request digest is stable across the round trip', () => {
  it('the retry adds inputResponses + requestState, and the digest must not move', () => {
    // If the digest covered the whole params object, no retry could ever
    // verify — the binding would be self-defeating rather than protective.
    const initial = mcpRequestDigest('tools/call', 'needs_input', {});
    const retry = mcpRequestDigest('tools/call', 'needs_input', {});
    expect(retry).toBe(initial);
  });

  it('but a changed ARGUMENT moves it', () => {
    expect(mcpRequestDigest('tools/call', 'needs_input', { a: 1 })).not.toBe(mcpRequestDigest('tools/call', 'needs_input', { a: 2 }));
  });
});
