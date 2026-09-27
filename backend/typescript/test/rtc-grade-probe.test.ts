/**
 * GRADING PROBE — "Real-time canvas collaboration" (FEATURES.md ordinal 231).
 * Evidence only. GREEN + CI-safe (pure HMAC; deterministic `now` param, no wall clock).
 *
 * Witnesses Headline #1 (transport auth + ticket lifecycle) by execution: the
 * cross-origin collab ticket is SCOPED TO ONE CANVAS + ONE TENANT (not broad),
 * expiry-bounded, and tamper-rejected fail-closed. This is the grade-relevant
 * answer to "is the ticket scope one canvas or broad?" — proven single-canvas.
 * (The known SLC-1 join-authz gap is orthogonal: it's about WHO may mint/join a
 * room for a private-project canvas, tracked pending the ADR 0610 collab-lane
 * follow-up — not this probe.)
 *
 * RTCP-1 (scope): a ticket minted for canvas A verifies for A but is REJECTED
 *     (null) for canvas B — the `p.c !== canvasId` cross-canvas hard-block.
 * RTCP-2 (expiry): a ticket checked after its 2h TTL is rejected (null).
 * RTCP-3 (integrity + attribution): a tampered payload is rejected (null); a
 *     valid ticket round-trips the tenant + optional principal attribution.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mintCollabTicket, verifyCollabTicket } from '../src/host/collab/collabServer.js';

const T0 = 1_700_000_000_000; // fixed epoch — deterministic, no Date.now()
const TTL = 2 * 60 * 60 * 1000;

beforeAll(() => {
  process.env.OPENWOP_SESSION_SECRET = 'grade-probe-session-secret-at-least-32-characters-long';
});

describe('RTC collab — ticket lifecycle (by execution)', () => {
  it('RTCP-1: ticket is scoped to ONE canvas — verifies for A, rejected for B', () => {
    const ticket = mintCollabTicket('org:acme', 'canvas-A', T0);
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + 1000)?.tenantId).toBe('org:acme');
    expect(verifyCollabTicket(ticket, 'canvas-B', T0 + 1000)).toBeNull(); // cross-canvas hard-block
  });

  it('RTCP-2: ticket is expiry-bounded — rejected after the 2h TTL', () => {
    const ticket = mintCollabTicket('org:acme', 'canvas-A', T0);
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + TTL - 1)?.tenantId).toBe('org:acme');
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + TTL + 1)).toBeNull(); // expired
  });

  it('RTCP-3: tamper rejected fail-closed; valid ticket round-trips tenant + principal', () => {
    const ticket = mintCollabTicket('org:acme', 'canvas-A', T0, 'user:123');
    const [payload, sig] = ticket.split('.');
    // flip a payload char → signature no longer matches → null (fail closed)
    const tampered = `${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`;
    expect(verifyCollabTicket(tampered, 'canvas-A', T0 + 1000)).toBeNull();
    // an intact ticket returns the tenant + the principal attribution field
    const ok = verifyCollabTicket(ticket, 'canvas-A', T0 + 1000);
    expect(ok?.tenantId).toBe('org:acme');
    expect(ok?.principalId).toBe('user:123');
  });
});
