/**
 * ADR 0895 — the chain lane's email policy (`EM2-WF-1`): sender binding, purpose
 * authority and a recipient meter, through the REAL adapter and a SendGrid mock.
 *
 * Born-red on the pre-ADR adapter: it passed `from` through verbatim, honoured an
 * author's `purpose: "transactional"` from anyone, and counted nothing. The
 * non-chain lane (no `lane`) is pinned unchanged in the last case.
 *
 * Tracker TST-BJA. Red when (probe-witnessed, w65): the sender match drops its
 * lower-casing, the root-org fallback or the unreadable-store refusal; a non-admin
 * or actorless `transactional` is honoured; the meter counts a refused send, checks
 * `used > limit`, or ignores `0`; the non-chain lane takes the chain policy.
 * The actorless leg is held twice (`!actingUserId` and `assertRunOrgScope` throwing
 * for an undefined actor, chainEmailPolicy.ts): each alone keeps it marketing.
 * The meter's hour window reads `Date.now()`, so the D3 cases fake Date mid-hour.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeEmailAdapter } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { __resetRecipientEgressGuardsForTests, registerRecipientEgressGuard } from '../src/host/recipientEgressGuard.js';
import { __resetChainEmailPolicyForTest, registerChainEmailSenderLookup } from '../src/host/chainEmailPolicy.js';
import { listVerifiedSenders, setSenderAddress } from '../src/features/email/emailService.js';
import { createMember, ensureWorkspaceRootOrg } from '../src/host/accessControlService.js';

const ADMIN_T = 'tchainadmin'; // `chainadmin` is an owner of the workspace root
const SHARED_T = 'tchainshared'; // `u2` is an editor there: no host:members:manage
const NO_SENDER_T = 'tchainnosender';

describe('ADR 0895 — chain-lane email policy', () => {
  let sg: http.Server;
  let storage: Storage;
  let bodies: Array<{ from?: { email?: string } }> = [];
  const purposes: string[] = [];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18951, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    sg = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(202, { 'x-message-id': `sg-${bodies.length}` }); res.end(); });
    });
    await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
    for (const [tenantId, userId] of [[ADMIN_T, 'chainadmin'], [SHARED_T, 'u2'], [NO_SENDER_T, 'nosender']] as const) {
      await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId });
      await storage.insertRun({ runId: `run-${tenantId}`, workflowId: 'w', tenantId, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    }
    await ensureWorkspaceRootOrg({ orgId: ADMIN_T, tenantId: ADMIN_T, name: 'A', createdBy: 'chainadmin' });
    await createMember({ orgId: ADMIN_T, tenantId: ADMIN_T, displayName: 'Admin', subject: 'chainadmin', roles: ['owner'] });
    await ensureWorkspaceRootOrg({ orgId: SHARED_T, tenantId: SHARED_T, name: 'S', createdBy: 'owner' });
    await createMember({ orgId: SHARED_T, tenantId: SHARED_T, displayName: 'Ed', subject: 'u2', roles: ['editor'] });
    await setSenderAddress(ADMIN_T, ADMIN_T, 'Hello@Acme.test', 'chainadmin');
    await setSenderAddress(ADMIN_T, 'org_sub', 'news@acme.test', 'chainadmin');
    await setSenderAddress(SHARED_T, SHARED_T, 'team@shared.test', 'owner');
  });
  afterAll(async () => {
    delete process.env.OPENWOP_SENDGRID_API_BASE;
    delete process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR;
    await new Promise<void>((r) => sg.close(() => r()));
  });
  beforeEach(() => {
    bodies = []; purposes.length = 0;
    delete process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR;
    __resetChainEmailPolicyForTest();
    registerChainEmailSenderLookup(listVerifiedSenders);
    __resetRecipientEgressGuardsForTests();
    registerRecipientEgressGuard('email', async ({ purpose }) => { purposes.push(purpose); return { ok: true }; });
  });

  const chain = (tenantId: string, actingUserId?: string) =>
    makeEmailAdapter({ storage, tenantId, runId: `run-${tenantId}`, ...(actingUserId ? { actingUserId } : {}), orgId: tenantId, lane: 'chain' });
  let seq = 0;
  const msg = (extra: Record<string, unknown> = {}) => ({ to: 'someone@x.test', subject: `s ${++seq}`, text: 'b', provider: 'sendgrid', from: '', ...extra });

  describe('D1 — sender binding', () => {
    it('a `from` that is not a configured sender is refused before any provider call', async () => {
      const out = await chain(ADMIN_T, 'chainadmin').send(msg({ from: 'ceo@bank.test' }));
      expect(out).toMatchObject({ sent: false, error: 'email_sender_not_verified' });
      expect(bodies).toHaveLength(0);
    });

    it('any org’s configured sender is accepted, case-insensitively', async () => {
      expect(await chain(ADMIN_T, 'chainadmin').send(msg({ from: 'NEWS@acme.test' }))).toMatchObject({ sent: true });
      expect(bodies[0]?.from?.email).toBe('NEWS@acme.test');
    });

    it('a blank `from` takes the workspace-root org’s sender', async () => {
      expect(await chain(ADMIN_T, 'chainadmin').send(msg())).toMatchObject({ sent: true });
      expect(bodies[0]?.from?.email).toBe('Hello@Acme.test');
    });

    it('with no sender configured, `from` passes as before (provider-side verification is the floor)', async () => {
      expect(await chain(NO_SENDER_T, 'nosender').send(msg({ from: 'me@own.test' }))).toMatchObject({ sent: true });
      expect(bodies[0]?.from?.email).toBe('me@own.test');
    });

    it('an unreadable sender store refuses', async () => {
      registerChainEmailSenderLookup(async () => { throw new Error('kv down'); });
      expect(await chain(ADMIN_T, 'chainadmin').send(msg())).toMatchObject({ sent: false, error: 'email_sender_unreadable' });
      expect(bodies).toHaveLength(0);
    });
  });

  describe('D2 — purpose authority', () => {
    it('the workspace owner’s `transactional` is honoured', async () => {
      await chain(ADMIN_T, 'chainadmin').send(msg({ purpose: 'transactional' }));
      expect(purposes).toEqual(['transactional']);
    });

    it('a non-admin’s `transactional` is demoted to marketing', async () => {
      await chain(SHARED_T, 'u2').send(msg({ purpose: 'transactional' }));
      expect(purposes).toEqual(['marketing']);
    });

    it('an actorless run’s `transactional` is demoted to marketing', async () => {
      await chain(ADMIN_T).send(msg({ purpose: 'transactional' }));
      expect(purposes).toEqual(['marketing']);
    });
  });

  describe('D3 — recipient meter', () => {
    // The window is a clock hour: pin Date mid-hour so the sends never straddle one.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 17, 12, 30) }); });
    afterEach(() => { vi.useRealTimers(); });
    it('refuses the send that would overrun the hourly budget, and a refusal spends nothing', async () => {
      process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR = '3';
      const a = chain(NO_SENDER_T, 'nosender');
      expect(await a.send(msg({ to: ['a@x.test', 'b@x.test'] }))).toMatchObject({ sent: true });
      expect(await a.send(msg({ to: ['c@x.test', 'd@x.test'] }))).toMatchObject({ sent: false, error: 'email_chain_rate_limited' });
      expect(await a.send(msg({ to: 'e@x.test' }))).toMatchObject({ sent: true });
      expect(bodies).toHaveLength(2);
    });

    it('`0` turns the meter off', async () => {
      process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR = '0';
      const a = chain(NO_SENDER_T, 'nosender');
      for (let i = 0; i < 4; i++) expect(await a.send(msg())).toMatchObject({ sent: true });
    });
  });

  it('the non-chain lane is unchanged: free `from`, declared purpose, no meter', async () => {
    process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR = '1';
    const a = makeEmailAdapter({ storage, tenantId: ADMIN_T, runId: `run-${ADMIN_T}`, actingUserId: 'chainadmin', orgId: ADMIN_T });
    expect(await a.send(msg({ from: 'ceo@bank.test', to: ['a@x.test', 'b@x.test'], purpose: 'transactional' }))).toMatchObject({ sent: true });
    expect(bodies[0]?.from?.email).toBe('ceo@bank.test');
    expect(purposes).toEqual(['transactional', 'transactional']); // the guard is asked per address
  });
});
