/**
 * ADR 0906 P2 — the edge lifecycle (D5): the 5-minute poll leased per
 * (hostname, slot), the 24 h `dns_not_configured` rule, one notification per
 * transition into active/failed, 14-day pending-claim expiry, and the poll
 * finishing a release that failed at delete time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/notifications/emitter.js', async (orig) => ({
  ...(await orig<typeof import('../src/notifications/emitter.js')>()),
  getNotificationEmitter: () => ({ emit: async (n: Record<string, unknown>) => { if (!emitted.some((e) => e.notificationId === n.notificationId)) emitted.push(n); return n; } }),
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetCustomDomains, addDomain, getDomain, listDomains, removeDomain,
  verifyDomain, PENDING_CLAIM_TTL_MS,
} from '../src/host/customDomains.js';
import { runCustomDomainEdgePoll } from '../src/host/customDomainSweep.js';
import type { EdgeCertificateProvider, EdgeStatus } from '../src/host/edgeCertificates/port.js';

/** An in-memory provider whose outcomes the test controls. */
function fakeProvider() {
  const state = {
    resources: new Set<string>(),
    status: { tls: 'awaiting_dns' } as EdgeStatus,
    releaseOk: true,
    calls: { prepare: 0, issue: 0, status: 0, release: 0 },
  };
  const provider: EdgeCertificateProvider = {
    id: 'gcp-certificate-manager',
    async prepare(h) {
      state.calls.prepare++; state.resources.add(`auth:${h}`);
      return { done: true, value: { handle: { dnsAuthName: `auth:${h}` }, dnsRecords: [{ type: 'CNAME', name: `_acme-challenge_x.${h}`, value: 'x.authorize.goog', purpose: 'certificate' }] } };
    },
    async issue(h, handle) {
      state.calls.issue++; state.resources.add(`cert:${h}`); state.resources.add(`entry:${h}`);
      return { done: true, value: { ...handle, certName: `cert:${h}`, mapEntryName: `entry:${h}` } };
    },
    async status() { state.calls.status++; return state.status; },
    async release(h) {
      state.calls.release++;
      if (!state.releaseOk) return 'partial';
      for (const r of [...state.resources]) if (r.endsWith(`:${h}`)) state.resources.delete(r);
      return 'released';
    },
  };
  return { provider, state };
}

const T0 = Date.parse('2026-10-17T12:00:00Z');

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
  emitted.length = 0;
});

async function live(hostname: string, provider: EdgeCertificateProvider, tenantId = 't1') {
  await addDomain({ tenantId, orgId: 'o1', createdBy: 'u1', hostname });
  const [row] = (await listDomains(tenantId, 'o1')).filter((d) => d.hostname === hostname);
  return (await verifyDomain(tenantId, 'o1', hostname, async () => [[row!.verificationToken]], provider))!;
}

describe('ADR 0906 D4/D5 — the poll finishes a partial release', () => {
  it('a release that failed at delete time is completed by the next poll', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    state.releaseOk = false;
    expect(await removeDomain('t1', 'o1', 'pages.example.com', provider)).toBe('releasing');
    state.releaseOk = true;
    const report = await runCustomDomainEdgePoll(provider, T0);
    expect(report.released).toEqual(['pages.example.com']);
    expect(await getDomain('t1', 'o1', 'pages.example.com')).toBeNull();
    expect(state.resources.size).toBe(0);
  });

  it('a failing release counts an attempt per poll slot', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    state.releaseOk = false;
    await removeDomain('t1', 'o1', 'pages.example.com', provider);
    await runCustomDomainEdgePoll(provider, T0);
    await runCustomDomainEdgePoll(provider, T0 + 1_000); // same slot: leased, no attempt
    await runCustomDomainEdgePoll(provider, T0 + 5 * 60_000);
    expect((await getDomain('t1', 'o1', 'pages.example.com'))?.edge?.releaseAttempts).toBe(3);
  });
});

describe('ADR 0906 D5 — the poll', () => {
  it('two instances in one slot advance a busy row once', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    const before = state.calls.status;
    const a = await runCustomDomainEdgePoll(provider, T0);
    const b = await runCustomDomainEdgePoll(provider, T0 + 1_000);
    expect(a.advanced).toEqual(['pages.example.com']);
    expect(b.advanced).toEqual([]);
    expect(state.calls.status).toBe(before + 1);
  });

  it('an authorization still failing after 24 h becomes failed/dns_not_configured, notified once', async () => {
    const { provider, state } = fakeProvider();
    state.status = { tls: 'awaiting_dns', issue: { reason: 'CONFIG', detail: 'no CNAME' } };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T0);
      await live('pages.example.com', provider);
      vi.setSystemTime(T0 + 23 * 3600_000);
      await runCustomDomainEdgePoll(provider, T0 + 23 * 3600_000);
      expect((await getDomain('t1', 'o1', 'pages.example.com'))?.edge?.tls).toBe('awaiting_dns');
      vi.setSystemTime(T0 + 25 * 3600_000);
      await runCustomDomainEdgePoll(provider, T0 + 25 * 3600_000);
      const row = await getDomain('t1', 'o1', 'pages.example.com');
      expect(row?.edge).toMatchObject({ tls: 'failed', issue: { reason: 'dns_not_configured' } });
      // failed rows are not polled again, and a re-advance does not re-notify
      await runCustomDomainEdgePoll(provider, T0 + 26 * 3600_000);
    } finally { vi.useRealTimers(); }
    const tls = emitted.filter((e) => (e.metadata as { kind?: string }).kind === 'custom-domain.tls');
    expect(tls).toHaveLength(1);
    expect(tls[0]).toMatchObject({ recipientUserId: 'u1', tenantId: 't1', priority: 'high', actionUrl: '/domains' });
  });

  it('an ACTIVE certificate notifies the creator once', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    state.status = { tls: 'active' };
    await runCustomDomainEdgePoll(provider, T0);
    await runCustomDomainEdgePoll(provider, T0 + 10 * 60_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.title).toContain('HTTPS is ready');
  });

  it('a pending claim older than 14 days is released; a younger one is kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T0);
      await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'old.example.com' });
      vi.setSystemTime(T0 + 2 * 24 * 3600_000);
      await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'young.example.com' });
    } finally { vi.useRealTimers(); }
    const report = await runCustomDomainEdgePoll(null, T0 + PENDING_CLAIM_TTL_MS + 3600_000);
    expect(report.expired).toEqual(['old.example.com']);
    expect((await listDomains('t1', 'o1')).map((d) => d.hostname)).toEqual(['young.example.com']);
  });
});
