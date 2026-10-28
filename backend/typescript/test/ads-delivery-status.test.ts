/**
 * ADR 0952 P0 — `AdsAdapter.setDeliveryStatus` (pause / activate) for Meta and
 * Google, against a local fixture server. No real ad platform, no real token.
 *
 * Pins:
 *  - PAUSE is never governance-gated, and it is idempotent: already paused ⇒
 *    `unchanged` with NO write. A pause still goes through when the policy
 *    cannot be read.
 *  - ACTIVATE is a LAUNCH: it requires a campaign-spend approval by default
 *    (spendKind `launch`) and claims it BEFORE a write. Confirmed completion
 *    permits a fresh approval; an ambiguous attempt remains fenced.
 *  - An unreadable policy refuses a launch (`policy_unreadable`), `disabled`
 *    refuses (`policy_disabled`), and `draft-only` returns a preview.
 *  - The writers are `unsupported` until sandbox-verified, and a dry run makes
 *    zero calls.
 *  - Writes are platform-native: Meta `status: PAUSED|ACTIVE`; Google
 *    `campaigns:mutate` `status: PAUSED|ENABLED`, `updateMask: status`.
 *  - A successful write emits host.campaign.ads.paused / .activated.
 *
 * Sabotage that turns it red: gate the pause path; drop the pre-write claim;
 * skip the read-first no-op check; drop the writer-verified gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerCurrencyRead, fixtureCurrency } from './adsCurrencyFixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const gov = vi.hoisted(() => ({ fail: false }));
const emitted = vi.hoisted(() => ({ types: [] as string[] }));
vi.mock('../src/host/hostEventDispatcher.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/hostEventDispatcher.js')>();
  return { ...actual, emitHostEvent: async (e: { type: string }) => { emitted.types.push(e.type); } };
});
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
import { makeAdsAdapter, setAdsCapChecker, type SetDeliveryStatusArgs } from '../src/host/adsAdapter.js';
import { checkLaunchAgainstCaps } from '../src/features/campaign-intel/spendCaps.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { getApproval, resolveApproval } from '../src/host/approvalService.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { buildMetaStatusBody, buildGoogleStatusBody, type DeliveryStatus } from '../src/host/adsWire.js';

interface Hit { method: string; path: string; body: Record<string, unknown> }
const T = 'deliv-t';
let srv: http.Server;
let storage: Storage;
let hits: Hit[] = [];
const state: Record<string, string> = {}; // campaignId → platform-native status
let readBarrier: { key: string; arrivals: Array<() => void> } | undefined;
const malformedWrites = new Set<string>();
function respondToStatus(key: string, send: () => void): void {
  if (readBarrier?.key !== key) { send(); return; }
  readBarrier.arrivals.push(send);
  if (readBarrier.arrivals.length === 2) {
    const ready = readBarrier.arrivals;
    readBarrier = undefined;
    for (const response of ready) response();
  }
}
const spendCaps: Record<string, number> = {}; // campaignId → spend_cap (Meta units)

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await __resetConnectionsStore();
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (answerCurrencyRead(req.url ?? '', raw, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      hits.push({ method: req.method ?? '', path: url.pathname, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      // Meta: GET /meta/{id}?fields=status → {status}; POST /meta/{id} {status} → {success:true}
      const meta = /^\/meta\/(\d+)$/.exec(url.pathname);
      if (meta) {
        const id = meta[1]!;
        // ADR 0952 P2 — a spend_cap write (rejected below Meta's minimum, modelled as < 10000).
        if (req.method === 'POST' && body.spend_cap !== undefined) {
          if (Number(body.spend_cap) < 10_000) { res.end(JSON.stringify({ error: { message: 'spend cap below minimum' } })); return; }
          spendCaps[id] = Number(body.spend_cap); res.end(JSON.stringify({ success: true })); return;
        }
        if (req.method === 'POST') { state[id] = String(body.status); res.end(malformedWrites.has(id) ? '{bad' : JSON.stringify({ success: true })); return; }
        const status = state[id] ?? 'PAUSED';
        respondToStatus(id, () => res.end(JSON.stringify({ id, status, account_id: '1' }))); return;
      }
      // Google: search → campaign.status; campaigns:mutate → resourceName
      if (url.pathname.endsWith('googleAds:search')) {
        const id = /campaign\.id = (\d+)/.exec(String(body.query))?.[1] ?? '';
        const status = state[`g${id}`] ?? 'PAUSED';
        respondToStatus(`g${id}`, () => res.end(JSON.stringify({ results: [{ campaign: { status } }] }))); return;
      }
      if (url.pathname.endsWith('campaigns:mutate')) {
        const op = (body.operations as Array<{ update: { resourceName: string; status: string } }>)[0]!;
        const id = op.update.resourceName.split('/').pop()!;
        state[`g${id}`] = op.update.status;
        res.end(malformedWrites.has(`g${id}`) ? '{bad' : JSON.stringify({ results: [{ resourceName: op.update.resourceName }] })); return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_META_API_BASE = `${base}/meta`;
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
  for (const id of ['meta-ads', 'google-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: id, kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  }
  await storage.insertRun({ runId: 'deliv-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  for (const k of ['OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_ADS_API_BASE', 'OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN', 'OPENWOP_ADS_VERIFIED_STATUS_WRITERS']) delete process.env[k];
  await new Promise<void>((r) => srv.close(() => r()));
});
beforeEach(() => { vi.restoreAllMocks(); hits = []; gov.fail = false; readBarrier = undefined; malformedWrites.clear(); process.env.OPENWOP_ADS_VERIFIED_STATUS_WRITERS = 'meta,google'; });

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'deliv-run', actingUserId: 'u1', orgId: T });
const meta = (campaignId: string, status: 'paused' | 'active'): SetDeliveryStatusArgs => ({ platform: 'meta', adAccountId: 'act_1', campaignId, status, reason: { kind: 'operator' } });
const google = (campaignId: string, status: 'paused' | 'active'): SetDeliveryStatusArgs => ({ platform: 'google', adAccountId: '123-456-7890', campaignId, status, reason: { kind: 'cap', ref: 'cap-1' } });
const writes = () => hits.filter((h) => h.method === 'POST' && !h.path.endsWith('googleAds:search'));
async function approveLaunch(args: SetDeliveryStatusArgs): Promise<{ approvalId: string; mapKey: string }> {
  const first = await adapter().setDeliveryStatus(args);
  expect(first.outcome).toBe('requires_approval');
  if (first.outcome !== 'requires_approval') throw new Error('fixture did not create a launch approval');
  const row = await getApproval(first.approvalId);
  if (!row?.spendIdemKey) throw new Error('launch approval has no spend key');
  await resolveApproval(first.approvalId, { status: 'approved' });
  return { approvalId: first.approvalId, mapKey: `hostext:ads:spend-approval:${row.spendIdemKey}` };
}

describe('ADR 0952 P0 — setDeliveryStatus', () => {
  it('pause is idempotent: already paused ⇒ unchanged, no write', async () => {
    state['101'] = 'PAUSED';
    expect(await adapter().setDeliveryStatus(meta('101', 'paused'))).toEqual({ outcome: 'unchanged', platform: 'meta', status: 'paused' });
    expect(writes()).toHaveLength(0);
  });

  it('pause of a running campaign writes the platform-native body, emits host.campaign.ads.paused, and is never gated — even with the policy unreadable', async () => {
    state['102'] = 'ACTIVE';
    state['g202'] = 'ENABLED';
    gov.fail = true;
    emitted.types = [];
    expect(await adapter().setDeliveryStatus(meta('102', 'paused'))).toEqual({ outcome: 'updated', platform: 'meta', status: 'paused' });
    expect(await adapter().setDeliveryStatus(google('202', 'paused'))).toEqual({ outcome: 'updated', platform: 'google', status: 'paused' });
    const [m, g] = writes();
    expect(m).toMatchObject({ path: '/meta/102', body: { status: 'PAUSED' } });
    expect(g!.path).toBe('/google/customers/1234567890/campaigns:mutate');
    expect(g!.body).toEqual({ operations: [{ update: { resourceName: 'customers/1234567890/campaigns/202', status: 'PAUSED' }, updateMask: 'status' }] });
    expect(emitted.types.filter((t) => t === 'host.campaign.ads.paused')).toHaveLength(2);
  });

  it('activate is a LAUNCH: requires approval, proceeds once approved, then CONSUMES the approval so a re-launch asks again', async () => {
    state['g303'] = 'PAUSED';
    const first = await adapter().setDeliveryStatus(google('303', 'active'));
    expect(first.outcome).toBe('requires_approval');
    if (first.outcome !== 'requires_approval') return;
    expect(writes()).toHaveLength(0);
    const approval = await getApproval(first.approvalId);
    expect(approval).toMatchObject({ kind: 'campaign-spend', spendKind: 'launch', platformCampaignId: '303' });
    expect(approval?.proposal).toMatch(/STARTS SPEND/);
    await resolveApproval(first.approvalId, { status: 'approved' });

    expect(await adapter().setDeliveryStatus(google('303', 'active'))).toEqual({ outcome: 'updated', platform: 'google', status: 'active' });
    expect(state['g303']).toBe('ENABLED');

    // Pause (ungated), then launch again: a NEW approval is required.
    expect((await adapter().setDeliveryStatus(google('303', 'paused'))).outcome).toBe('updated');
    const again = await adapter().setDeliveryStatus(google('303', 'active'));
    expect(again.outcome).toBe('requires_approval');
    if (again.outcome === 'requires_approval') expect(again.approvalId).not.toBe(first.approvalId);
  });

  it('ADR 0952 P1 — a cap refuses a launch BEFORE any approval opens; a throwing cap check refuses; pause ignores caps', async () => {
    state['g404'] = 'PAUSED';
    state['g405'] = 'ENABLED';
    try {
      setAdsCapChecker(async () => ({ verdict: 'cap_exceeded', capId: 'cap-9' }));
      expect(await adapter().setDeliveryStatus(google('404', 'active'))).toEqual({ outcome: 'refused', error: 'cap_exceeded', capId: 'cap-9' });
      setAdsCapChecker(async () => ({ verdict: 'cap_unenforceable', capId: 'cap-8' }));
      expect(await adapter().setDeliveryStatus(google('404', 'active'))).toEqual({ outcome: 'refused', error: 'cap_unenforceable', capId: 'cap-8' });
      setAdsCapChecker(async () => { throw new Error('storage down'); });
      expect(await adapter().setDeliveryStatus(google('404', 'active'))).toEqual({ outcome: 'refused', error: 'policy_unreadable' });
      expect(writes()).toHaveLength(0);
      // Stopping spend never consults caps.
      expect(await adapter().setDeliveryStatus(google('405', 'paused'))).toEqual({ outcome: 'updated', platform: 'google', status: 'paused' });
    } finally {
      setAdsCapChecker((tenantId, target) => checkLaunchAgainstCaps(tenantId, target));
    }
  });

  it('ADR 0952 P2 × P0 — the launch claim is taken BEFORE the spend_cap write: a lost claim writes neither', async () => {
    process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS = 'meta';
    setAdsCapChecker(async () => ({ verdict: 'ok', ceiling: { limitMinor: 50_000, currency: 'USD', capId: 'cap-C' } }));
    try {
      const args = meta('505', 'active');
      state['505'] = 'PAUSED';
      const { mapKey } = await approveLaunch(args);
      hits = [];
      const original = storage.kvCompareAndSwap.bind(storage);
      vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
        if (key === mapKey && next.includes('"state":"claimed"')) return { swapped: false, actual: expected };
        return original(key, expected, next);
      });
      expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'refused', error: 'launch_approval_changed' });
      expect(writes()).toHaveLength(0);
      expect(spendCaps['505']).toBeUndefined();
    } finally {
      delete process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS;
      setAdsCapChecker((tenantId, target) => checkLaunchAgainstCaps(tenantId, target));
    }
  });

  it('ADR 0952 P2 × P1 — a cap without a current snapshot refuses the launch before the ceiling or status write', async () => {
    process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS = 'meta';
    // checkLaunchAgainstCaps answers cap_unenforceable for a stale/never-read cap.
    setAdsCapChecker(async () => ({ verdict: 'cap_unenforceable', capId: 'cap-stale' }));
    try {
      state['506'] = 'PAUSED';
      hits = [];
      expect(await adapter().setDeliveryStatus(meta('506', 'active'))).toEqual({ outcome: 'refused', error: 'cap_unenforceable', capId: 'cap-stale' });
      expect(writes()).toHaveLength(0);
      expect(spendCaps['506']).toBeUndefined();
    } finally {
      delete process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS;
      setAdsCapChecker((tenantId, target) => checkLaunchAgainstCaps(tenantId, target));
    }
  });

  it('activating an already-active campaign is a no-op that needs no approval', async () => {
    state['104'] = 'ACTIVE';
    expect(await adapter().setDeliveryStatus(meta('104', 'active'))).toEqual({ outcome: 'unchanged', platform: 'meta', status: 'active' });
  });

  it('launch: an unreadable policy refuses (policy_unreadable); disabled refuses; draft-only previews — all with no write', async () => {
    state['105'] = 'PAUSED';
    gov.fail = true;
    expect(await adapter().setDeliveryStatus(meta('105', 'active'))).toEqual({ outcome: 'refused', error: 'policy_unreadable' });
    gov.fail = false;
    const T2 = 'deliv-t2';
    await createSecretConnection({ tenantId: T2, provider: 'meta-ads', kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
    const a2 = makeAdsAdapter({ storage, tenantId: T2, runId: 'deliv-run', actingUserId: 'u1', orgId: T2 });
    await setGovernancePolicy(T2, { actionPolicy: { 'ads.launch': 'disabled' } }, 'test');
    expect(await a2.setDeliveryStatus(meta('105', 'active'))).toEqual({ outcome: 'refused', error: 'policy_disabled' });
    await setGovernancePolicy(T2, { actionPolicy: { 'ads.launch': 'draft-only' } }, 'test');
    expect((await a2.setDeliveryStatus(meta('105', 'active'))).outcome).toBe('preview');
    expect(writes()).toHaveLength(0);
  });

  it('a dry run returns the exact write with zero calls; the writers are unsupported until sandbox-verified', async () => {
    const dry = await adapter().setDeliveryStatus({ ...google('9', 'active'), dryRun: true });
    expect(dry).toMatchObject({ outcome: 'preview', plan: [{ body: { operations: [{ update: { resourceName: 'customers/1234567890/campaigns/9', status: 'ENABLED' } }] } }] });
    // A non-numeric Google id is refused, never stripped into a DIFFERENT campaign.
    expect(await adapter().setDeliveryStatus(google('9x1', 'paused'))).toEqual({ outcome: 'failed', error: 'invalid_ids' });
    delete process.env.OPENWOP_ADS_VERIFIED_STATUS_WRITERS;
    expect(await adapter().setDeliveryStatus(meta('101', 'paused'))).toEqual({ outcome: 'unsupported', platform: 'meta', reason: 'not_sandbox_verified' });
    expect(hits).toHaveLength(0);
  });

  it('a removed campaign fails, it is never re-enabled', async () => {
    state['g606'] = 'REMOVED';
    expect(await adapter().setDeliveryStatus(google('606', 'active'))).toEqual({ outcome: 'failed', error: 'campaign_removed' });
  });

  it('invalid runtime status refuses before preview, reads or approval creation; literal builders also refuse', async () => {
    const put = vi.spyOn(storage, 'kvSet');
    for (const status of ['', 'ACTIVE', 'removed', null, undefined]) {
      // Deliberately cross the typed boundary with malformed external input.
      const invalid = status as DeliveryStatus;
      for (const dryRun of [true, false]) {
        expect(await adapter().setDeliveryStatus({ ...meta('701', 'paused'), status: invalid, dryRun })).toEqual({ outcome: 'failed', error: 'invalid_status' });
        expect(await adapter().setDeliveryStatus({ ...google('701', 'paused'), status: invalid, dryRun })).toEqual({ outcome: 'failed', error: 'invalid_status' });
      }
      expect(() => buildMetaStatusBody(invalid)).toThrow('invalid_delivery_status');
      expect(() => buildGoogleStatusBody('123', '701', invalid)).toThrow('invalid_delivery_status');
    }
    expect(hits).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it.each(['meta', 'google'] as const)('%s claims one approved launch before two concurrent writes can use it', async (platform) => {
    const args = platform === 'meta' ? meta('702', 'active') : google('702', 'active');
    const key = platform === 'meta' ? '702' : 'g702';
    state[key] = 'PAUSED';
    const approved = await approveLaunch(args);
    hits = [];
    readBarrier = { key, arrivals: [] };
    // Both callers must also observe the SAME approved map, before either
    // claims it; a slow caller arriving after completion legitimately asks anew.
    const get = storage.kvGet.bind(storage);
    let mapReads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'kvGet').mockImplementation(async (storageKey) => {
      const raw = await get(storageKey);
      if (storageKey === approved.mapKey && mapReads < 2) {
        mapReads++;
        if (mapReads === 2) release();
        await bothRead;
      }
      return raw;
    });
    const results = await Promise.all([adapter().setDeliveryStatus(args), adapter().setDeliveryStatus(args)]);
    expect(results.filter((r) => r.outcome === 'updated')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    expect(JSON.parse((await storage.kvGet(approved.mapKey))!)).toMatchObject({ approvalId: approved.approvalId, launchClaim: { state: 'completed' } });
  });

  it('a stale claim cannot overwrite or delete a newer approval mapping', async () => {
    const args = meta('703', 'active');
    const { mapKey } = await approveLaunch(args);
    const original = storage.kvCompareAndSwap.bind(storage);
    let replacement = '';
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === mapKey && next.includes('"state":"claimed"')) {
        replacement = JSON.stringify({ ...JSON.parse(expected!), approvalId: 'newer-approval' });
        await storage.kvSet(key, replacement);
      }
      return original(key, expected, next);
    });
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'refused', error: 'launch_approval_changed' });
    expect(writes()).toHaveLength(0);
    expect(await storage.kvGet(mapKey)).toBe(replacement);
  });

  it('claim storage failure refuses before any launch mutation', async () => {
    const args = meta('704', 'active');
    const { mapKey } = await approveLaunch(args);
    const original = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === mapKey && next.includes('"state":"claimed"')) throw new Error('claim store unavailable');
      return original(key, expected, next);
    });
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'refused', error: 'launch_claim_unreadable' });
    expect(writes()).toHaveLength(0);
  });

  it('an approved mapping for a different campaign cannot authorize this launch', async () => {
    const a = await approveLaunch(meta('707', 'active'));
    const b = await approveLaunch(meta('708', 'active'));
    const mapped = JSON.parse((await storage.kvGet(a.mapKey))!);
    await storage.kvSet(a.mapKey, JSON.stringify({ ...mapped, approvalId: b.approvalId }));
    expect(await adapter().setDeliveryStatus(meta('707', 'active'))).toEqual({ outcome: 'refused', error: 'policy_unreadable' });
    expect(writes()).toHaveLength(0);
  });

  it('an applied launch with an ambiguous response cannot reuse its approval after a pause', async () => {
    const args = meta('705', 'active');
    const { mapKey } = await approveLaunch(args);
    malformedWrites.add('705');
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'failed', error: 'bad_response' });
    expect(state['705']).toBe('ACTIVE');
    expect(JSON.parse((await storage.kvGet(mapKey))!)).toMatchObject({ launchClaim: { state: 'claimed' } });
    malformedWrites.clear();
    gov.fail = true;
    expect(await adapter().setDeliveryStatus(meta('705', 'paused'))).toEqual({ outcome: 'updated', platform: 'meta', status: 'paused' });
    gov.fail = false;
    const before = writes().length;
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'refused', error: 'launch_outcome_unknown' });
    expect(writes()).toHaveLength(before);
  });

  it('a confirmed write whose completion CAS fails stays claimed and cannot authorize a later launch', async () => {
    const args = google('706', 'active');
    const { mapKey } = await approveLaunch(args);
    const original = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === mapKey && next.includes('"state":"completed"')) throw new Error('completion store unavailable');
      return original(key, expected, next);
    });
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'updated', platform: 'google', status: 'active' });
    state['g706'] = 'PAUSED';
    expect(await adapter().setDeliveryStatus(args)).toEqual({ outcome: 'refused', error: 'launch_outcome_unknown' });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse((await storage.kvGet(mapKey))!)).toMatchObject({ launchClaim: { state: 'claimed' } });
  });

  it('activation refuses a target belonging to a different accessible account before any status write', async () => {
    state['991'] = 'PAUSED';
    expect(await adapter().setDeliveryStatus({ ...meta('991', 'active'), adAccountId: 'act_2' })).toEqual({ outcome: 'failed', error: 'campaign_account_mismatch' });
    expect(writes()).toHaveLength(0);
    expect(state['991']).toBe('PAUSED');
  });

  it('ADR 0952 P2 — a lifetime single-target cap sets Meta spend_cap BEFORE the launch; unverified ⇒ watchdog only, said so; a rejected cap refuses the launch', async () => {
    const approveLaunch = async (id: string): Promise<void> => {
      const first = await adapter().setDeliveryStatus(meta(id, 'active'));
      if (first.outcome !== 'requires_approval') throw new Error(`expected an approval, got ${first.outcome}`);
      await resolveApproval(first.approvalId, { status: 'approved' });
    };
    try {
      setAdsCapChecker(async () => ({ verdict: 'ok', ceiling: { limitMinor: 50_000, currency: 'USD', capId: 'cap-L' } }));
      // Unverified ceiling writer: launches, says no native ceiling, writes none.
      state['501'] = 'PAUSED';
      await approveLaunch('501');
      expect(await adapter().setDeliveryStatus(meta('501', 'active'))).toEqual({ outcome: 'updated', platform: 'meta', status: 'active', ceiling: 'not_set:not_sandbox_verified' });
      expect(spendCaps['501']).toBeUndefined();

      process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS = 'meta';
      fixtureCurrency.value = 'USD';
      state['502'] = 'PAUSED';
      await approveLaunch('502');
      hits = [];
      expect(await adapter().setDeliveryStatus(meta('502', 'active'))).toMatchObject({ outcome: 'updated', ceiling: 'set' });
      expect(spendCaps['502']).toBe(50_000);
      // Order: the ceiling write precedes the ACTIVE write.
      const posts = hits.filter((h) => h.method === 'POST' && h.path === '/meta/502').map((h) => Object.keys(h.body)[0]);
      expect(posts).toEqual(['spend_cap', 'status']);

      // Below the platform minimum: the launch is refused with Meta's words; the campaign stays paused.
      setAdsCapChecker(async () => ({ verdict: 'ok', ceiling: { limitMinor: 5_000, currency: 'USD', capId: 'cap-S' } }));
      state['503'] = 'PAUSED';
      await approveLaunch('503');
      expect(await adapter().setDeliveryStatus(meta('503', 'active'))).toEqual({ outcome: 'failed', error: 'ceiling_rejected:spend cap below minimum' });
      expect(state['503']).toBe('PAUSED');
      // The refusal came before the status write, so no launch was attempted:
      // the claim goes back to the approved mapping, and once the cap is fixed
      // the SAME approval launches (no second approval, no fenced claim).
      setAdsCapChecker(async () => ({ verdict: 'ok', ceiling: { limitMinor: 50_000, currency: 'USD', capId: 'cap-S' } }));
      expect(await adapter().setDeliveryStatus(meta('503', 'active'))).toMatchObject({ outcome: 'updated', ceiling: 'set' });
      expect(state['503']).toBe('ACTIVE');

      // A cap in another currency than the account cannot be set natively: refused.
      setAdsCapChecker(async () => ({ verdict: 'ok', ceiling: { limitMinor: 50_000, currency: 'EUR', capId: 'cap-E' } }));
      state['504'] = 'PAUSED';
      await approveLaunch('504');
      expect(await adapter().setDeliveryStatus(meta('504', 'active'))).toEqual({ outcome: 'refused', error: 'cap_unenforceable', capId: 'cap-E' });
    } finally {
      delete process.env.OPENWOP_ADS_VERIFIED_CEILING_WRITERS;
      setAdsCapChecker((tenantId, target) => checkLaunchAgainstCaps(tenantId, target));
    }
  });
});
