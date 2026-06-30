/**
 * Meta ads-dispatch adapter (ADR 0167 Phase 1) via the Connections broker. Proves
 * ctx.ads.publishAd resolves the acting user's Meta Connection, creates a
 * campaign→adset→ad pipeline ALL PAUSED with the OAuth token, stamps RFC 0079
 * provenance, is FORK-STABLE idempotent (a re-run with a NEW runId but the same
 * briefId reuses the recorded platform ids — no duplicate paid campaign), rolls
 * back a half-built campaign on a mid-pipeline failure, and reports no_connection
 * (→ the node's document fallback) when no Meta connection exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';

interface Hit { method: string; path: string; auth?: string; body: Record<string, unknown> }

describe('Meta ads-dispatch adapter (ADR 0167 Phase 1)', () => {
  let meta: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let idSeq = 0;
  let failOn: string | null = null; // an edge name to 500 (e.g. 'adsets') to exercise rollback

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18962, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    meta = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = req.url ?? '';
        hits.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
        const edge = path.split('/').pop() ?? '';
        if (failOn && path.endsWith(`/${failOn}`)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'platform rejected' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `${edge || 'obj'}-${++idSeq}` }));
      });
    });
    await new Promise<void>((r) => meta.listen(0, r));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tads', provider: 'meta-ads', kind: 'bearer', secret: 'META_TOKEN', scope: 'user', userId: 'u1' });
    // Register the meta-ads provider WITH apiHosts — exactly what the RFC 0120 connection-pack
    // loader does in production (#1006: meta-ads pack declares apiHosts:['facebook.com']). Here
    // it points at the loopback test host so the cascade-delete rollback's host-pinned
    // brokeredFetch DELETE actually reaches the recorder instead of failing closed. Create-path
    // tests use brokeredPost (which never pins), so they are unaffected by this.
    registerProvider({
      id: 'meta-ads', label: 'Meta Ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi',
      scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
    });
    await storage.insertRun({ runId: 'run-1', workflowId: 'w', tenantId: 'tads', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'run-2-fork', workflowId: 'w', tenantId: 'tads', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_META_API_BASE;
    await new Promise<void>((r) => meta.close(() => r()));
  });

  beforeEach(() => { hits = []; failOn = null; });

  const adapter = (runId: string, actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tads', runId, ...(actingUserId ? { actingUserId } : {}), orgId: 'tads' });

  const args = (briefId: string) => ({
    platform: 'meta' as const, briefId, adAccountId: '12345', campaignName: 'Summer Sale',
    copy: { headline: 'Pick faster', bodyText: '40% faster checkout', ctaText: 'LEARN_MORE' },
    dailyBudgetMinor: 5000,
  });

  it('creates campaign→adset→ad ALL PAUSED with the token, and stamps provenance', async () => {
    const out = await adapter('run-1').publishAd(args('brief-A'));
    expect(out.outcome).toBe('published');
    if (out.outcome !== 'published') return;
    expect(out.paused).toBe(true);
    expect(out.reviewStatus).toBe('pending_review');
    expect(out.reused).toBe(false);

    // Three creates, in order, ALL PAUSED, all Bearer-authed at the hardcoded host path.
    const creates = hits.filter((h) => h.method === 'POST' && /\/(campaigns|adsets|ads)$/.test(h.path));
    expect(creates.map((h) => h.path.split('/').pop())).toEqual(['campaigns', 'adsets', 'ads']);
    for (const c of creates) {
      expect(c.auth).toBe('Bearer META_TOKEN');
      expect(c.body.status).toBe('PAUSED'); // no auto-spend — the load-bearing safety invariant
      expect(c.path).toContain('/act_12345/');
    }
    // No token in the result.
    expect(JSON.stringify(out)).not.toContain('META_TOKEN');
    // RFC 0079 provenance stamped.
    const meta1 = (await storage.getRun('run-1'))?.metadata as Record<string, unknown> | undefined;
    expect((meta1?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'meta-ads')).toBe(true);
  });

  it('FORK-STABLE idempotency: a re-run with a NEW runId + same briefId reuses the ids, creates NO new campaign', async () => {
    const first = await adapter('run-1').publishAd(args('brief-FORK'));
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    hits = []; // reset the recorder

    // Simulate a :fork — different runId, identical business inputs.
    const forked = await adapter('run-2-fork').publishAd(args('brief-FORK'));
    expect(forked.outcome).toBe('published');
    if (forked.outcome !== 'published') return;
    expect(forked.reused).toBe(true);
    expect(forked.platformCampaignId).toBe(first.platformCampaignId);
    expect(forked.platformAdSetId).toBe(first.platformAdSetId);
    expect(forked.platformAdId).toBe(first.platformAdId);
    // The platform was NOT called again — no duplicate paid campaign.
    expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(0);
  });

  it('fails closed on a mid-pipeline error; the created campaign was PAUSED (no spend) and the cascade-delete rollback fires', async () => {
    failOn = 'adsets';
    const out = await adapter('run-1').publishAd(args('brief-ROLLBACK'));
    expect(out.outcome).toBe('failed');
    // The campaign was created (and PAUSED) before the adset failed.
    const campaignCreate = hits.find((h) => h.method === 'POST' && /\/campaigns$/.test(h.path));
    expect(campaignCreate).toBeTruthy();
    expect(campaignCreate?.body.status).toBe('PAUSED'); // no spend regardless of cleanup
    // END-TO-END cascade-delete (ADR 0167 × RFC 0120 #1006): now that meta-ads declares
    // apiHosts, the host-pinned brokeredFetch DELETE is permitted to the API host and ACTUALLY
    // fires — exactly ONE DELETE, targeting the orphaned campaign object (adset was never
    // created, so nothing else to clean). Pre-#1006 (no apiHosts) this no-op'd, PAUSED-safe.
    const deletes = hits.filter((h) => h.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.path).toMatch(/\/campaigns-\d+$/);
    expect(deletes[0]?.auth).toBe('Bearer META_TOKEN'); // the broker injected the token on the cleanup call too
    // A failed dispatch leaves NO idempotency record → a corrected retry can proceed.
    expect(out).not.toHaveProperty('platformCampaignId');
  });

  it('returns no_connection (→ document fallback) when the acting user has no Meta connection', async () => {
    const out = await adapter('run-1', 'u-no-conn').publishAd(args('brief-NONE'));
    expect(out.outcome).toBe('no_connection');
  });
});
