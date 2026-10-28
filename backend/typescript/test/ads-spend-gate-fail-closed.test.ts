/**
 * The ads spend gate FAILS CLOSED when the governance policy cannot be read.
 *
 * Before: `evaluateSpendGate` caught a `getGovernancePolicy` error and treated
 * the policy as UNSET. Unset means no threshold, so the verdict was `allow` and
 * the LIVE platform write went out, even for a tenant whose policy disables the
 * action or requires approval above a threshold. The audience gate did the same
 * and could fall through to a stored approval. Now every live mutation
 * (publishAd, updateBudget, syncAudience) returns `policy_unreadable` and makes
 * no platform call; a dry-run preview still works.
 *
 * Sabotage that turns it red: restore "treat as unset" in either catch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerCurrencyRead } from './adsCurrencyFixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const gov = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/host/governanceService.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/governanceService.js')>();
  return {
    ...actual,
    getGovernancePolicy: async (tenantId: string) => {
      if (gov.fail) throw new Error('storage unavailable');
      return actual.getGovernancePolicy(tenantId);
    },
  };
});

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';

const T = 'gate-fail-t';
let srv: http.Server;
let storage: Storage;
let hits = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await __resetConnectionsStore();
  // ADR 0952 defect P9 — the account-currency read a live budget write makes first (not counted as a write).
  srv = http.createServer((req, res) => { if (answerCurrencyRead(req.url ?? '', '', res)) { req.resume(); return; } hits++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'x', results: [{ resourceName: 'customers/1/x/1' }] })); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_META_API_BASE = `${base}/meta`;
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
  for (const id of ['meta-ads', 'google-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: id, kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  }
  await storage.insertRun({ runId: 'gate-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  gov.fail = false;
  for (const k of ['OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_ADS_API_BASE', 'OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN']) delete process.env[k];
  await new Promise<void>((r) => srv.close(() => r()));
});
beforeEach(() => { hits = 0; gov.fail = true; });

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'gate-run', actingUserId: 'u1', orgId: T });
const publish = { platform: 'meta' as const, briefId: 'b-gate', adAccountId: 'act_1', campaignName: 'Gate', copy: { headline: 'H' }, dailyBudgetMinor: 5000, pageId: 'pg', landingUrl: 'https://x.test' };

describe('ads spend gate: an unreadable governance policy fails CLOSED', () => {
  it('a live publishAd is refused with policy_unreadable and makes no platform call', async () => {
    expect(await adapter().publishAd(publish)).toEqual({ outcome: 'failed', error: 'policy_unreadable' });
    expect(hits).toBe(0);
  });

  it('a dry-run preview still works (it makes no write either way)', async () => {
    const out = await adapter().publishAd({ ...publish, dryRun: true });
    expect(out.outcome).toBe('preview');
    expect(hits).toBe(0);
  });

  it('a live updateBudget is refused with policy_unreadable and makes no platform call', async () => {
    expect(await adapter().updateBudget({ platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 9000 })).toEqual({ outcome: 'failed', error: 'policy_unreadable' });
    expect(hits).toBe(0);
  });

  it('syncAudience is refused with policy_unreadable and makes no platform call', async () => {
    const out = await adapter().syncAudience({ platform: 'meta', adAccountId: 'act_1', audienceName: 'A', memberHashes: ['a'.repeat(64)], membersKey: 'k'.repeat(64) });
    expect(out).toEqual({ outcome: 'failed', error: 'policy_unreadable' });
    expect(hits).toBe(0);
  });

  it('with the policy readable again, a below-threshold publish is allowed (no regression)', async () => {
    gov.fail = false;
    const out = await adapter().publishAd({ ...publish, briefId: 'b-ok' });
    expect(out.outcome, JSON.stringify(out)).toBe('published');
    expect(hits).toBeGreaterThan(0);
  });
});
