/**
 * ADR 0906 P1 — release, retry and status over the provider port.
 *
 *  - D4: delete marks `releasing` first (the host stops serving at once),
 *    deletes the row only once the provider is clean, and a later attempt
 *    finishes a partial release; force-delete only after 3 failed releases,
 *    audited with the resource ids;
 *  - retry: a failed certificate is released and issued afresh; 429 within a
 *    minute; 409 while releasing;
 *  - status refreshes a stale busy row and not a fresh one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audits = vi.hoisted(() => [] as Array<{ kind: string; payload: Record<string, unknown> }>);
vi.mock('../src/host/auditChainService.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/auditChainService.js')>()),
  appendAudit: async (_t: string, kind: string, payload: Record<string, unknown>) => { audits.push({ kind, payload }); return {}; },
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetCustomDomains, addDomain, domainStatus, forceRemoveDomain, getDomain, listDomains, removeDomain,
  resolveCustomHost, retryDomainEdge, verifyDomain,
} from '../src/host/customDomains.js';
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

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
  audits.length = 0;
});

async function live(hostname: string, provider: EdgeCertificateProvider, tenantId = 't1') {
  await addDomain({ tenantId, orgId: 'o1', createdBy: 'u1', hostname });
  const [row] = (await listDomains(tenantId, 'o1')).filter((d) => d.hostname === hostname);
  return (await verifyDomain(tenantId, 'o1', hostname, async () => [[row!.verificationToken]], provider))!;
}

describe('ADR 0906 D4 — delete releases first', () => {
  it('a clean release deletes the row and leaves no resources', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    expect(state.resources.size).toBe(3);
    expect(await removeDomain('t1', 'o1', 'pages.example.com', provider)).toBe('deleted');
    expect(state.resources.size).toBe(0);
    expect(await getDomain('t1', 'o1', 'pages.example.com')).toBeNull();
  });

  it('a partial release keeps the row RELEASING, stops serving at once, and a retry finishes it', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    expect(await resolveCustomHost('pages.example.com')).not.toBeNull();
    state.releaseOk = false;
    expect(await removeDomain('t1', 'o1', 'pages.example.com', provider)).toBe('releasing');
    const row = await getDomain('t1', 'o1', 'pages.example.com');
    expect(row?.edge).toMatchObject({ tls: 'releasing', releaseIntent: 'delete', releaseAttempts: 1 });
    expect(await resolveCustomHost('pages.example.com')).toBeNull(); // not serving while it is removed
    state.releaseOk = true;
    expect(await removeDomain('t1', 'o1', 'pages.example.com', provider)).toBe('deleted');
    expect(await getDomain('t1', 'o1', 'pages.example.com')).toBeNull();
    expect(state.resources.size).toBe(0);
  });

  it('force-delete is refused before 3 failed releases, then allowed and audited with the resource ids', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    state.releaseOk = false;
    await removeDomain('t1', 'o1', 'pages.example.com', provider); // attempt 1
    await expect(forceRemoveDomain('t1', 'o1', 'pages.example.com', 'admin')).rejects.toThrow(/after 3/);
    await removeDomain('t1', 'o1', 'pages.example.com', provider); // attempt 2
    await removeDomain('t1', 'o1', 'pages.example.com', provider); // attempt 3
    expect((await getDomain('t1', 'o1', 'pages.example.com'))?.edge?.releaseAttempts).toBe(3);
    expect(await forceRemoveDomain('t1', 'o1', 'pages.example.com', 'admin')).toBe(true);
    expect(await getDomain('t1', 'o1', 'pages.example.com')).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.kind).toBe('custom-domain.force-released');
    expect(audits[0]!.payload).toMatchObject({ hostname: 'pages.example.com', attempts: 3, actor: 'admin' });
    expect(Object.keys(audits[0]!.payload.resources as object).sort()).toEqual(['auth', 'cert', 'entry']);
  });

  it('a domain without edge resources (manual) deletes immediately', async () => {
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'pages.example.com' });
    expect(await removeDomain('t1', 'o1', 'pages.example.com', null)).toBe('deleted');
  });
});

describe('ADR 0906 P3 — check again', () => {
  it('a failed certificate is released and issued afresh', async () => {
    const { provider, state } = fakeProvider();
    state.status = { tls: 'failed', issue: { reason: 'CAA', detail: 'CAA forbids' } };
    const row = await live('pages.example.com', provider);
    expect(row.edge?.tls).toBe('failed');
    state.status = { tls: 'awaiting_dns' };
    const after = await retryDomainEdge('t1', 'o1', 'pages.example.com', provider, Date.now() + 61_000);
    expect(state.calls.release).toBe(1);
    expect(state.calls.prepare).toBe(2);
    expect(after?.edge).toMatchObject({ tls: 'awaiting_dns' });
    expect(after?.edge?.issue).toBeUndefined();
    expect(state.resources.size).toBe(3);
  });

  it('is rate-limited to once a minute', async () => {
    const { provider } = fakeProvider();
    await live('pages.example.com', provider);
    await expect(retryDomainEdge('t1', 'o1', 'pages.example.com', provider, Date.now())).rejects.toThrow(/less than a minute/);
  });

  it('is refused while the domain is releasing', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    state.releaseOk = false;
    await removeDomain('t1', 'o1', 'pages.example.com', provider);
    await expect(retryDomainEdge('t1', 'o1', 'pages.example.com', provider, Date.now() + 120_000)).rejects.toThrow(/being removed/);
  });

  it('status refreshes a stale busy row, and not a fresh one', async () => {
    const { provider, state } = fakeProvider();
    await live('pages.example.com', provider);
    const before = state.calls.status;
    await domainStatus('t1', 'o1', 'pages.example.com', provider, Date.now());
    expect(state.calls.status).toBe(before);
    await domainStatus('t1', 'o1', 'pages.example.com', provider, Date.now() + 61_000);
    expect(state.calls.status).toBe(before + 1);
  });
});
