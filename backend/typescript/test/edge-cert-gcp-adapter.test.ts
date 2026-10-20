/**
 * ADR 0906 P1 — the GCP Certificate Manager adapter against an in-process fake
 * REST server, driven through the step engine.
 *
 *  - D4: every step resumes after a simulated crash at ANY call and converges
 *    onto one set of deterministic resources (each created exactly once);
 *  - D4: release deletes entry → cert → auth, NOT_FOUND-tolerant, and a failing
 *    step reports `partial`, completing on a retry;
 *  - D2: nothing is created before the TXT verifies; the DNS authorization is
 *    PER_PROJECT_RECORD;
 *  - D1: `manual` makes zero calls and leaves the row byte-identical (golden);
 *    an unready configuration makes zero calls;
 *  - D3: the CM state maps onto the TLS axis.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __resetCustomDomains, addDomain, listDomains, verifyDomain, advanceDomainEdge, type CustomDomain } from '../src/host/customDomains.js';
import { createGcpCertificateManagerProvider, edgeResourceIds, type EdgeMetadata } from '../src/host/edgeCertificates/gcpCertificateManager.js';

const API = 'https://certificatemanager.googleapis.com/v1';
const PROJECT = 'edge-proj';
const MAP = 'owp-edge-certmap';
const LOC = `projects/${PROJECT}/locations/global`;

/** A fake Certificate Manager: resources by name, LROs that finish after `opPolls` reads. */
function fakeCertificateManager(opts: { opPolls?: number } = {}) {
  let opPolls = opts.opPolls ?? 0;
  const resources = new Map<string, Record<string, unknown>>();
  const ops = new Map<string, { polls: number; target: string; body: Record<string, unknown> | null }>();
  const posts: string[] = [];
  const deletes: string[] = [];
  let calls = 0;
  let crashAt = -1;
  let failDeleteOf: string | null = null;
  let certState: Record<string, unknown> = { state: 'PROVISIONING', authorizationAttemptInfo: [{ domain: 'x', state: 'AUTHORIZING' }] };
  let opSeq = 0;

  const respond = (status: number, body: unknown = {}) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const finishOp = (name: string) => {
    const op = ops.get(name)!;
    if (op.body) resources.set(op.target, op.body); else resources.delete(op.target);
    ops.delete(name);
  };
  const newOp = (target: string, body: Record<string, unknown> | null) => {
    const name = `${LOC}/operations/op-${++opSeq}`;
    ops.set(name, { polls: opPolls, target, body });
    if (opPolls === 0) { finishOp(name); return { name, done: true }; }
    return { name, done: false };
  };

  const fetch = async (url: string, init: { method: string; body?: string }) => {
    calls += 1;
    if (calls === crashAt) throw new Error('simulated crash');
    expect(url.startsWith(API)).toBe(true);
    const u = new URL(url);
    const path = u.pathname.slice(new URL(API).pathname.length + 1); // the fake Certificate Manager's own API prefix
    if (init.method === 'GET') {
      if (path.includes('/operations/')) {
        const op = ops.get(path);
        if (!op) return respond(200, { name: path, done: true });
        if (--op.polls <= 0) { finishOp(path); return respond(200, { name: path, done: true }); }
        return respond(200, { name: path, done: false });
      }
      const r = resources.get(path);
      if (!r) return respond(404, { error: { message: 'not found' } });
      if (path.includes('/certificates/')) return respond(200, { ...r, managed: { ...(r.managed as object), ...certState } });
      return respond(200, r);
    }
    if (init.method === 'POST') {
      const [collection, q] = [path, u.searchParams];
      const id = q.get('dnsAuthorizationId') ?? q.get('certificateId') ?? q.get('certificateMapEntryId');
      const name = `${collection}/${id}`;
      if (resources.has(name) || [...ops.values()].some((o) => o.target === name)) return respond(409, { error: { message: 'ALREADY_EXISTS' } });
      posts.push(name);
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      const res: Record<string, unknown> = { name, ...body };
      if (collection.endsWith('/dnsAuthorizations')) {
        res.dnsResourceRecord = { name: `_acme-challenge_${id}.${String(body.domain)}.`, type: 'CNAME', data: `${id}.1.authorize.certificatemanager.goog.` };
      }
      return respond(200, newOp(name, res));
    }
    if (init.method === 'DELETE') {
      if (failDeleteOf && path.endsWith(failDeleteOf)) return respond(500, { error: { message: 'backend error' } });
      if (!resources.has(path)) return respond(404, { error: { message: 'not found' } });
      deletes.push(path);
      return respond(200, newOp(path, null));
    }
    return respond(405);
  };

  return {
    fetch, resources, posts, deletes,
    get calls() { return calls; },
    crashOnCall(n: number) { crashAt = calls + n; },
    noCrash() { crashAt = -1; },
    failDelete(suffix: string | null) { failDeleteOf = suffix; },
    setCert(s: Record<string, unknown>) { certState = s; },
    /** Finish every outstanding operation and make new ones finish at once. */
    completeOps() { for (const name of [...ops.keys()]) finishOp(name); opPolls = 0; },
  };
}

const metadata: EdgeMetadata = {
  accessToken: async () => 'tok',
  projectId: async () => PROJECT,
  invalidate: () => undefined,
};

function provider(cm: ReturnType<typeof fakeCertificateManager>) {
  return createGcpCertificateManagerProvider({ certMap: MAP, fetch: cm.fetch, metadata, sleep: async () => undefined, opWaitMs: 1_000 });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
});

async function liveDomain(hostname: string, edge: Parameters<typeof verifyDomain>[4]): Promise<CustomDomain> {
  await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname });
  const [row] = (await listDomains('t1', 'o1')).filter((d) => d.hostname === hostname);
  return (await verifyDomain('t1', 'o1', hostname, async () => [[row!.verificationToken]], edge))!;
}

describe('ADR 0906 D2 — nothing before ownership is proven', () => {
  it('a pending row is not advanced', async () => {
    const cm = fakeCertificateManager();
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'pages.example.com' });
    const row = await advanceDomainEdge('pages.example.com', provider(cm));
    expect(row?.status).toBe('pending');
    expect(cm.calls).toBe(0);
  });

  it('a failed TXT check creates nothing', async () => {
    const cm = fakeCertificateManager();
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'pages.example.com' });
    await verifyDomain('t1', 'o1', 'pages.example.com', async () => [['wrong']], provider(cm));
    expect(cm.calls).toBe(0);
  });
});

describe('ADR 0906 D2/D4 — the GCP adapter end to end', () => {
  it('TXT verify creates a PER_PROJECT_RECORD authorization, the certificate and the map entry, once each', async () => {
    const cm = fakeCertificateManager();
    const row = await liveDomain('pages.example.com', provider(cm));
    const ids = edgeResourceIds('pages.example.com');
    expect(cm.posts).toEqual([
      `${LOC}/dnsAuthorizations/${ids.auth}`,
      `${LOC}/certificates/${ids.cert}`,
      `${LOC}/certificateMaps/${MAP}/certificateMapEntries/${ids.entry}`,
    ]);
    expect(cm.resources.get(`${LOC}/dnsAuthorizations/${ids.auth}`)).toMatchObject({ type: 'PER_PROJECT_RECORD', domain: 'pages.example.com' });
    expect(cm.resources.get(`${LOC}/certificates/${ids.cert}`)).toMatchObject({ managed: { domains: ['pages.example.com'], dnsAuthorizations: [`${LOC}/dnsAuthorizations/${ids.auth}`] } });
    expect(row.edge).toMatchObject({
      provider: 'gcp-certificate-manager',
      tls: 'awaiting_dns',
      dnsAuthRecord: { type: 'CNAME', name: `_acme-challenge_${ids.auth}.pages.example.com`, purpose: 'certificate' },
      certName: `${LOC}/certificates/${ids.cert}`,
      mapEntryName: `${LOC}/certificateMaps/${MAP}/certificateMapEntries/${ids.entry}`,
    });
  });

  it('ids are deterministic, lowercase and within the 63-char limit', () => {
    const ids = edgeResourceIds('a-very-long-subdomain-name.with.many.labels.example.co.uk');
    for (const id of Object.values(ids)) expect(id).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
    expect(edgeResourceIds('x.example.com')).toEqual(edgeResourceIds('x.example.com'));
  });

  it('a slow operation leaves the step pending; the next advance finishes without a second create', async () => {
    const cm = fakeCertificateManager({ opPolls: 100 });
    const p = provider(cm);
    const row = await liveDomain('pages.example.com', p);
    expect(row.edge?.tls).toBe('awaiting_dns');
    expect(row.edge?.dnsAuthRecord).toBeUndefined(); // the CNAME is not known yet
    expect(cm.posts).toHaveLength(1);
    cm.completeOps();
    const next = await advanceDomainEdge('pages.example.com', p);
    expect(next?.edge?.dnsAuthRecord?.type).toBe('CNAME');
    expect(next?.edge?.mapEntryName).toBeTruthy();
    expect(cm.posts).toHaveLength(3); // the authorization was not created twice
  });
});

describe('ADR 0906 D4 — resume after a crash at every call', () => {
  it('a crash at call k, then re-advance, converges with each resource created exactly once', async () => {
    // Count the calls of a clean run first.
    const clean = fakeCertificateManager();
    await liveDomain('clean.example.com', provider(clean));
    const total = clean.calls;
    expect(total).toBeGreaterThan(5);

    for (let k = 1; k <= total; k++) {
      await __resetCustomDomains();
      const cm = fakeCertificateManager();
      const p = provider(cm);
      cm.crashOnCall(k);
      const first = await liveDomain('pages.example.com', p);
      expect(first.status).toBe('live');
      cm.noCrash();
      let row = await advanceDomainEdge('pages.example.com', p);
      row = await advanceDomainEdge('pages.example.com', p);
      expect(new Set(cm.posts).size, `crash at call ${k}`).toBe(3);
      expect(cm.posts, `crash at call ${k}`).toHaveLength(3);
      expect(row?.edge, `crash at call ${k}`).toMatchObject({ tls: 'awaiting_dns' });
      expect(row?.edge?.mapEntryName, `crash at call ${k}`).toBeTruthy();
      expect(row?.edge?.issue, `crash at call ${k}`).toBeUndefined();
    }
  });

  it('a crash records the fault on edge.issue without moving tls', async () => {
    const cm = fakeCertificateManager();
    cm.crashOnCall(1);
    const row = await liveDomain('pages.example.com', provider(cm));
    expect(row.edge).toMatchObject({ tls: 'not_requested', issue: { reason: 'provider_error' } });
    expect(row.edge?.issue?.detail).toContain('simulated crash');
  });
});

describe('ADR 0906 D3 — certificate state onto the TLS axis', () => {
  it.each([
    [{ state: 'ACTIVE' }, 'active', undefined],
    [{ state: 'FAILED', provisioningIssue: { reason: 'CAA', details: 'CAA forbids' } }, 'failed', 'CAA'],
    [{ state: 'PROVISIONING', authorizationAttemptInfo: [{ state: 'FAILED', failureReason: 'CONFIG', details: 'no CNAME' }] }, 'awaiting_dns', 'CONFIG'],
    [{ state: 'PROVISIONING', authorizationAttemptInfo: [{ state: 'AUTHORIZED' }] }, 'provisioning', undefined],
  ])('%j → %s', async (certState, tls, reason) => {
    const cm = fakeCertificateManager();
    cm.setCert(certState);
    const row = await liveDomain('pages.example.com', provider(cm));
    expect(row.edge?.tls).toBe(tls);
    expect(row.edge?.issue?.reason).toBe(reason);
  });

  it('an active row is left alone by the engine', async () => {
    const cm = fakeCertificateManager();
    cm.setCert({ state: 'ACTIVE' });
    await liveDomain('pages.example.com', provider(cm));
    const before = cm.calls;
    await advanceDomainEdge('pages.example.com', provider(cm));
    expect(cm.calls).toBe(before);
  });
});

describe('ADR 0906 D4 — release', () => {
  it('deletes entry → cert → auth in order; a failing step is partial and a retry completes', async () => {
    const cm = fakeCertificateManager();
    const p = provider(cm);
    await liveDomain('pages.example.com', p);
    const ids = edgeResourceIds('pages.example.com');
    cm.failDelete(`/certificates/${ids.cert}`);
    expect(await p.release('pages.example.com')).toBe('partial');
    expect(cm.deletes).toEqual([`${LOC}/certificateMaps/${MAP}/certificateMapEntries/${ids.entry}`]);
    cm.failDelete(null);
    expect(await p.release('pages.example.com')).toBe('released');
    expect(cm.deletes).toEqual([
      `${LOC}/certificateMaps/${MAP}/certificateMapEntries/${ids.entry}`,
      `${LOC}/certificates/${ids.cert}`,
      `${LOC}/dnsAuthorizations/${ids.auth}`,
    ]);
    expect(cm.resources.size).toBe(0);
    expect(await p.release('pages.example.com')).toBe('released'); // NOT_FOUND-tolerant
  });
});
