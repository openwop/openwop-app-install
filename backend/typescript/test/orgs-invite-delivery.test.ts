/**
 * Deferred-Plan Phase A — invite email delivery (ADR 0004 ⊕ ADR 0193), plus
 * DEF-3 / ADR 0655 D8 (the ledger reservation). Service-level over a FAKE
 * SendGrid endpoint (the email-adapter.test.ts harness pattern): pins
 *   1. a configured inviter (brokered connection) + org sender ⇒ exactly ONE
 *      provider request, addressed to the invitee, whose body carries the
 *      accept URL (the delivery channel for the one-time token);
 *   2. retry-delivery for the SAME invite ⇒ still one request (the adapter's
 *      sent-ledger dedups on the deterministic `org-invite:<inviteId>` key);
 *   3. no sender identity ⇒ `skipped / no_sender`, zero requests (fail-soft copy-link UX);
 *   4. no brokered connection ⇒ `skipped / no_connection` (credential_required is caught);
 *   5. DEF-3 — two CONCURRENT deliveries of one invite ⇒ exactly ONE provider
 *      request (the ledger CAS reservation), both callers `sent`;
 *   6. DEF-3 — a FAILED send releases the reservation, so a retry re-sends
 *      (put-on-accept). The `skipped` outcomes carry the R2 review-F1 `reason`.
 *
 * HONEST CEILING (determinism, claim 5): since ADR 0655 D8 the losing caller
 * re-reads the ledger after a REAL `setTimeout(LOSER_REREAD_WAIT_MS = 250)`
 * (`host/emailAdapter.ts`) and reports `sent` only if the winner's provider
 * call was ACCEPTED by then. The fake provider answers immediately, so the
 * winner lands well inside the window — but under extreme host load a winner
 * slower than 250 ms would make the loser `skipped / send_failed`. That bound
 * is product timing; the test keeps the full claim rather than loosening it.
 *
 * Sabotage that turns it red (grade-tests wave 2, probes `g2-del-*`): a
 * non-deterministic idempotency key → 1 and 5; a different accept-link path →
 * 1; the no-sender guard returning `sent` → 3; credential_required mapped to
 * `send_failed` → 4; the reservation compare disabled → 5; the release-on-
 * failure dropped → 6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createInvitation } from '../src/features/orgs/invitationsService.js';
import { deliverInviteEmail } from '../src/features/orgs/inviteDelivery.js';
import { setSenderAddress } from '../src/features/email/emailService.js';

let storage: Storage;
let sg: http.Server;
let requests: Array<{ body: string }> = [];
let failNext = false; // one-shot 500 for the DEF-3 release-on-failure case

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __resetConnectionsStore();

  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ body: raw });
      if (failNext) {
        failNext = false;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'simulated provider outage' }] }));
        return;
      }
      res.writeHead(202, { 'x-message-id': 'sg-inv-1' });
      res.end();
    });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;

  await createSecretConnection({ tenantId: 'tinv', provider: 'sendgrid', kind: 'api_key', secret: 'SG.invkey', scope: 'user', userId: 'inviter-1' });
});
afterAll(async () => {
  delete process.env.OPENWOP_SENDGRID_API_BASE;
  await new Promise<void>((r) => sg.close(() => r()));
});

describe('invite email delivery (Phase A)', () => {
  it('sends exactly one email carrying the accept URL; a retry dedups; no-sender skips', async () => {
    const org = await createOrg({ tenantId: 'tinv', createdBy: 'owner', name: 'Deliverco' });
    await setSenderAddress('tinv', org.orgId, 'invites@deliverco.test', 'owner');
    const { invite, token } = await createInvitation({ tenantId: 'tinv', orgId: org.orgId, email: 'new@deliverco.test', role: 'editor' });

    requests = [];
    const out = await deliverInviteEmail({
      storage, tenantId: 'tinv', actingUserId: 'inviter-1', invite, token,
      baseUrl: 'https://app.deliverco.test',
    });
    expect(out).toEqual({ outcome: 'sent' });
    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    expect(body).toContain(`https://app.deliverco.test/invitations/accept?token=${encodeURIComponent(token)}`);
    expect(body).toContain('editor');
    const sent = JSON.parse(body) as { personalizations: Array<{ to: Array<{ email: string }> }> };
    expect(sent.personalizations[0]!.to.map((t) => t.email)).toEqual(['new@deliverco.test']); // addressed to the INVITEE

    // Retry (route replay) — the sent-ledger dedups on org-invite:<inviteId>.
    const again = await deliverInviteEmail({
      storage, tenantId: 'tinv', actingUserId: 'inviter-1', invite, token,
      baseUrl: 'https://app.deliverco.test',
    });
    expect(again).toEqual({ outcome: 'sent' });
    expect(requests).toHaveLength(1);
  });

  it("no org sender identity ⇒ 'skipped' with zero provider requests", async () => {
    const org = await createOrg({ tenantId: 'tinv', createdBy: 'owner', name: 'NoSender Inc' });
    const { invite, token } = await createInvitation({ tenantId: 'tinv', orgId: org.orgId, email: 'x@nosender.test', role: 'viewer' });
    requests = [];
    const out = await deliverInviteEmail({
      storage, tenantId: 'tinv', actingUserId: 'inviter-1', invite, token,
      baseUrl: 'https://app.deliverco.test',
    });
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_sender' });
    expect(requests).toHaveLength(0);
  });

  it('DEF-3: two CONCURRENT deliveries of the same invite send exactly once (CAS reservation)', async () => {
    const org = await createOrg({ tenantId: 'tinv', createdBy: 'owner', name: 'Raceco' });
    await setSenderAddress('tinv', org.orgId, 'invites@raceco.test', 'owner');
    const { invite, token } = await createInvitation({ tenantId: 'tinv', orgId: org.orgId, email: 'race@raceco.test', role: 'editor' });
    requests = [];
    const args = { storage, tenantId: 'tinv', actingUserId: 'inviter-1', invite, token, baseUrl: 'https://app.raceco.test' };
    const [a, b] = await Promise.all([deliverInviteEmail(args), deliverInviteEmail(args)]);
    // Exactly ONE provider request — the ledger CAS reservation admits one
    // sender; the loser re-reads after a bounded wait (ADR 0655 D8) and reports
    // 'sent' only for an ACCEPTED winner. The fake provider answers immediately,
    // so the winner lands inside the window (see the header's HONEST CEILING).
    expect(requests).toHaveLength(1);
    expect([a, b]).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
  });

  it('DEF-3: a FAILED send releases the reservation so a retry re-sends (put-on-accept preserved)', async () => {
    const org = await createOrg({ tenantId: 'tinv', createdBy: 'owner', name: 'Retryco' });
    await setSenderAddress('tinv', org.orgId, 'invites@retryco.test', 'owner');
    const { invite, token } = await createInvitation({ tenantId: 'tinv', orgId: org.orgId, email: 'retry@retryco.test', role: 'viewer' });
    requests = [];
    const args = { storage, tenantId: 'tinv', actingUserId: 'inviter-1', invite, token, baseUrl: 'https://app.retryco.test' };
    failNext = true;
    expect(await deliverInviteEmail(args)).toEqual({ outcome: 'skipped', reason: 'send_failed' }); // provider 500 → fail-soft
    expect(requests).toHaveLength(1);
    expect(await deliverInviteEmail(args)).toEqual({ outcome: 'sent' }); // reservation released → retry sends
    expect(requests).toHaveLength(2);
  });

  it("no brokered connection for the inviter ⇒ 'skipped' (credential_required caught)", async () => {
    const org = await createOrg({ tenantId: 'tinv', createdBy: 'owner', name: 'NoConn Inc' });
    await setSenderAddress('tinv', org.orgId, 'invites@noconn.test', 'owner');
    const { invite, token } = await createInvitation({ tenantId: 'tinv', orgId: org.orgId, email: 'y@noconn.test', role: 'viewer' });
    requests = [];
    const out = await deliverInviteEmail({
      storage, tenantId: 'tinv', actingUserId: 'user-without-connection', invite, token,
      baseUrl: 'https://app.deliverco.test',
    });
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_connection' });
    expect(requests).toHaveLength(0);
  });
});
