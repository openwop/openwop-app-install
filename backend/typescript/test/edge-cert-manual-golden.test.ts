/**
 * ADR 0906 P1 — the `manual` provider is today's behaviour, byte for byte, and
 * an unready configuration makes no calls (golden). The full fake-server
 * harness is shared with `edge-cert-gcp-adapter.test.ts`.
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
import { loadEdgeConfig } from '../src/host/edgeCertificates/config.js';
import { manualEdgeProvider } from '../src/host/edgeCertificates/manual.js';
import { resolveEdgeProvider } from '../src/host/edgeCertificates/index.js';

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

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
});

async function liveDomain(hostname: string, edge: Parameters<typeof verifyDomain>[4]): Promise<CustomDomain> {
  await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname });
  const [row] = (await listDomains('t1', 'o1')).filter((d) => d.hostname === hostname);
  return (await verifyDomain('t1', 'o1', hostname, async () => [[row!.verificationToken]], edge))!;
}

describe('ADR 0906 D1 — configuration fails closed', () => {
  it.each([
    [{}, 'manual'],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'manual' }, 'manual'],
  ])('%j → %s', (env, provider) => {
    expect(loadEdgeConfig(env as NodeJS.ProcessEnv)).toEqual({ provider });
  });

  it.each([
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'cloudflare' }, /not a known provider/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager' }, /CERT_MAP is not set/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: 'Bad/Map' }, /not a valid/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: 'm1', OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT: 'X' }, /project id/],
  ])('%j is not ready, and resolves to no provider', (env, reason) => {
    const cfg = loadEdgeConfig(env as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ ready: false });
    expect((cfg as { reason: string }).reason).toMatch(reason);
    expect(resolveEdgeProvider(cfg)).toBeNull();
  });

  it('a complete gcp configuration is ready', () => {
    const cfg = loadEdgeConfig({ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: MAP, OPENWOP_CUSTOM_DOMAIN_LB_IP: '203.0.113.7' } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ provider: 'gcp-certificate-manager', ready: true, certMap: MAP, lbIp: '203.0.113.7' });
    expect(resolveEdgeProvider(cfg)?.id).toBe('gcp-certificate-manager');
  });
});

describe('ADR 0906 D1 — manual is today, byte for byte', () => {
  it('verify under manual writes no edge field and makes no call', async () => {
    const cm = fakeCertificateManager();
    const row = await liveDomain('pages.example.com', manualEdgeProvider);
    expect(row.status).toBe('live');
    expect('edge' in row).toBe(false);
    const again = await advanceDomainEdge('pages.example.com', manualEdgeProvider);
    expect(again).toEqual(row);
    expect(cm.calls).toBe(0);
  });

  it('a configured-but-unready provider (null) makes no call and writes nothing', async () => {
    const row = await liveDomain('pages.example.com', null);
    expect('edge' in row).toBe(false);
  });
});

