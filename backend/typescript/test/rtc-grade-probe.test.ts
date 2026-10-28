/**
 * Collab WS ticket — the 2 h TTL BOUNDARY (`host/collab/collabServer.ts`
 * `TICKET_TTL_MS` + the `p.exp < now` check in `verifyCollabTicket`).
 *
 * Why this file exists: it is the ONLY test that pins the expiry edge.
 * `test/collab-authboundary.test.ts` 'rejects an EXPIRED ticket (401) and a
 * TAMPERED one' mints its stale ticket 3 h back, so a TTL raised to 2.5 h stays
 * green there (round-1 probe `8fw2g2-rtc-ttl-collab` was VACUOUS). Here the
 * clock is INJECTED (`now` parameter, fixed `T0`), never the wall clock, so the
 * case is deterministic under OPENWOP_CI_CLOCKSHIFT.
 *
 * Breaks it: any change to `TICKET_TTL_MS` (accept at TTL−1 / reject at TTL+1
 * moves), or `p.exp < now` → `p.exp <= now` (the exactly-at-TTL accept goes red).
 *
 * Claims this file used to carry and no longer does — collab-authboundary OWNS
 * them (the paired round-1 probes reddened that file, reports/):
 *   - canvas binding (`p.c !== canvasId`): 'rejects a ticket bound to a
 *     DIFFERENT canvas — 404 not a cross-canvas key' (8fw2g2-rtc-canvas-collab).
 *   - tamper / HMAC compare: 'rejects an EXPIRED ticket (401) and a TAMPERED
 *     one' (8fw2g2-rtc-sig-collab). This file's old tamper leg flipped a
 *     PAYLOAD char, which JSON.parse refused anyway, so it could not fail
 *     (8fw2g2-rtc-sig was VACUOUS).
 *   - principal attribution (`principalId` from `p.u`): 'carries optional
 *     principal attribution through mint→verify' (8fw2g2-rtc-principal-collab-r2).
 * The filename is a grading-pass leftover (noted for b1/9c).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mintCollabTicket, verifyCollabTicket } from '../src/host/collab/collabServer.js';

const T0 = 1_700_000_000_000; // fixed epoch — the clock is injected, never Date.now()
const TTL_MS = 7_200_000; // 2 h, pinned as a literal (not imported from the subject)

let priorSecret: string | undefined;
beforeAll(() => {
  priorSecret = process.env.OPENWOP_SESSION_SECRET;
  process.env.OPENWOP_SESSION_SECRET = 'grade-probe-session-secret-at-least-32-characters-long';
});
afterAll(() => {
  if (priorSecret === undefined) delete process.env.OPENWOP_SESSION_SECRET;
  else process.env.OPENWOP_SESSION_SECRET = priorSecret;
});

describe('collab ticket — the 2 h TTL boundary (injected clock)', () => {
  it('RTCP-2: ticket is expiry-bounded — accepted through exactly 2h, rejected 1 ms after', () => {
    const ticket = mintCollabTicket('org:acme', 'canvas-A', T0);
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + TTL_MS - 1)).toEqual({ tenantId: 'org:acme' });
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + TTL_MS)).toEqual({ tenantId: 'org:acme' });
    expect(verifyCollabTicket(ticket, 'canvas-A', T0 + TTL_MS + 1)).toBeNull(); // expired
  });
});
