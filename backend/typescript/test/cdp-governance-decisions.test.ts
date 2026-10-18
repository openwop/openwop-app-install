/**
 * CDP-F — unified governance decision log (ADR 0268). recordGovernanceDecision
 * writes to the ONE governance.decision.* audit namespace; listGovernanceDecisions
 * queries it tenant-filtered; the cdp console route surfaces it. Consent denials
 * are wired to flow into the same stream.
 *
 * Sabotage that reds it (w38 probes): dropping the payload-tenantId filter; a wrong
 * action namespace; the route reading another tenant; ending the page walk after one
 * page; reading only `want * 4` rows (the old over-read — case R2.1 gives the buried
 * tenant's rows strictly OLDER timestamps so the newest-first window genuinely misses
 * them; with same-millisecond rows the DESC tie order put them back in the window and
 * the probe went vacuous in round 1); an unconditional exhaustive flag; and the merge
 * read listing every tenant.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { recordGovernanceDecision, listGovernanceDecisions, listGovernanceDecisionsWithBound, type GovernanceDecisionRow } from '../src/host/governanceDecisionLog.js';
import { recordMergeEvent } from '../src/features/crm/crmMergeEventsService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
interface DecisionsBody { decisions: GovernanceDecisionRow[]; exhaustive: boolean; limit: number }
const payloadOf = (d: GovernanceDecisionRow): { tenantId?: string; subject?: string; reason?: string } => (d.payload ?? {}) as { tenantId?: string; subject?: string; reason?: string };
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function owner() {
  const c = client();
  const tenantId = `org:f-${Date.now()}-${n++}`;
  const r = await c.post('/host/openwop-app/test/login', { email: `f-${Date.now()}-${n++}@a.test`, tenantId });
  expect(r.status).toBe(201);
  return { c, tenantId };
}
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

describe('CDP-F governance decision log', () => {
  it('records + queries decisions, tenant-filtered', async () => {
    await recordGovernanceDecision({ tenantId: 't-alpha', kind: 'consent', outcome: 'deny', subject: 's1', reason: 'category:marketing.email' });
    await recordGovernanceDecision({ tenantId: 't-beta', kind: 'purpose', outcome: 'allow', subject: 's2' });

    const alpha = await listGovernanceDecisions('t-alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0].action).toBe('governance.decision.consent');
    expect(alpha[0].outcome).toBe('deny');
    expect(payloadOf(alpha[0])).toMatchObject({ tenantId: 't-alpha', subject: 's1', reason: 'category:marketing.email' });
    // tenant isolation — t-beta's decision is not in t-alpha's view
    expect(alpha.find((d) => payloadOf(d).subject === 's2')).toBeUndefined();
  });

  it('surfaces the decision log via the toggle-gated cdp console route', async () => {
    await setToggle('cdp', 'on');
    const { c, tenantId } = await owner();
    await recordGovernanceDecision({ tenantId, kind: 'firewall', outcome: 'deny', reason: 'read+egress' });
    // a REAL row in another tenant — the route must not surface it
    await recordGovernanceDecision({ tenantId: `org:f-foreign-${Date.now()}-${n++}`, kind: 'firewall', outcome: 'deny', reason: 'foreign-marker' });
    const r = await c.get('/host/openwop-app/cdp/governance-decisions');
    expect(r.status).toBe(200);
    const body = r.body as DecisionsBody;
    const own = body.decisions.filter((d) => d.action === 'governance.decision.firewall');
    expect(own).toHaveLength(1);
    expect(payloadOf(own[0]!)).toMatchObject({ tenantId, reason: 'read+egress' });
    expect(body.decisions.find((d) => payloadOf(d).reason === 'foreign-marker')).toBeUndefined();
    expect(body.exhaustive).toBe(true);
  });
});

describe('R2 CD-SP-2 — the escalating tenant read', () => {
  it('finds a tenant\'s rows buried past the old 4x over-read, and reports exhaustive honestly', async () => {
    // Tenant A writes 2 rows, then tenant B floods 60 STRICTLY newer rows. With
    // limit=5, the OLD fixed 4x over-read (20 rows) saw only tenant B and
    // returned [] for A — a false "no governance decisions yet".
    // Only Date is faked (distinct, ordered timestamps, relative to the real now so
    // the clock-shift lane still applies); sqlite I/O is synchronous, no timers.
    // An hour in the PAST: older than every other row this file writes, so no case
    // reads a future-stamped row on top of its own (and A stays buried under B).
    const base = Date.now() - 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 2; i += 1) {
        vi.setSystemTime(base + i);
        await recordGovernanceDecision({ tenantId: 'tA-r2', kind: 'firewall', outcome: 'deny', resource: `r${i}` });
      }
      for (let i = 0; i < 60; i += 1) {
        vi.setSystemTime(base + 1_000 + i);
        await recordGovernanceDecision({ tenantId: 'tB-r2', kind: 'firewall', outcome: 'allow', resource: `b${i}` });
      }
    } finally {
      vi.useRealTimers();
    }
    const { rows, exhaustive } = await listGovernanceDecisionsWithBound('tA-r2', { limit: 5 });
    expect(rows.map((r) => r.resource).sort()).toEqual(['r0', 'r1']);
    expect(exhaustive).toBe(true); // the stream ended within the scan budget
  });

  it('pages PAST the storage adapters\' 500-row clamp — buried tenant rows are FOUND, not reported exhaustive-empty', async () => {
    // Tenant C writes 3 rows, then 600 newer foreign rows bury them past the
    // single-read clamp. The review caught the first fix hitting the clamp on
    // its FIRST page and reporting `exhaustive: true` with zero rows — the
    // false "no decisions yet" with an honesty flag vouching for it.
    for (let i = 0; i < 3; i += 1) {
      await recordGovernanceDecision({ tenantId: 'tC-r2', kind: 'firewall', outcome: 'deny', resource: `c${i}` });
    }
    for (let i = 0; i < 600; i += 1) {
      await recordGovernanceDecision({ tenantId: 'tD-r2', kind: 'firewall', outcome: 'allow', resource: `d${i}` });
    }
    const { rows, exhaustive } = await listGovernanceDecisionsWithBound('tC-r2', { limit: 200 });
    expect(rows.length).toBe(3);
    expect(exhaustive).toBe(true); // stream fully walked within budget
    expect(rows.every((r) => (r.payload as { tenantId?: string }).tenantId === 'tC-r2')).toBe(true);
  });
});


describe('R3 — merge-history audit read (/cdp/merge-events)', () => {
  it('serves the tenant\'s merge events newest-capable, tenant-isolated; unmerged rows stay listed', async () => {
    await setToggle('cdp', 'on');
    const { c, tenantId } = await owner();
    const other = `org:f-other-${Date.now()}`;
    await recordMergeEvent({
      tenantId, survivorId: 'ct-a', sourceId: 'ct-b',
      filledFields: { phone: '+15550001' },
      absorbedIdentifiers: [{ type: 'email', value: 'b@x.test', source: 'manual' }],
      refIds: { deals: [], tasks: [], activities: [] },
      actor: 'user:me',
    });
    await recordMergeEvent({
      tenantId: other, survivorId: 'zz-a', sourceId: 'zz-b',
      filledFields: {}, absorbedIdentifiers: [],
      refIds: { deals: [], tasks: [], activities: [] },
      actor: 'user:other',
    });
    const r = await c.get('/host/openwop-app/cdp/merge-events');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const events = (r.body as { events: unknown }).events as Array<{ survivorId: string; sourceId: string; filledFields: Record<string, string>; unmergedAt?: string }>;
    expect(events.length).toBe(1); // tenant isolation — the other tenant's merge is absent
    expect(events[0]!.survivorId).toBe('ct-a');
    expect(events[0]!.filledFields.phone).toBe('+15550001');
    expect(events[0]!.unmergedAt).toBeUndefined();
  });
});
