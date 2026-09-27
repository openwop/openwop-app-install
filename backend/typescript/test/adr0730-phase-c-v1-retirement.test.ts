/**
 * ADR 0730 Phase C — the two surfaces that had no v2 home now have one, and it
 * is reachable rather than merely registered.
 *
 * The failure this pins is the one a peer host shipped past 17 green tests
 * (bus `dc59`): a surface mounted at an address a middleware rewrites BEFORE
 * routing, so the boot log said "mounted", the route existed, and every request
 * 404'd while discovery advertised it. Registration is not reachability — these
 * assert the SERVED path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server; let base = ''; let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals['storage'] as Storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer dev-token', ...headers } });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

describe('ADR 0730 C.1 — debug-bundle has a host-extension twin', () => {
  const runId = `run-${randomUUID()}`;
  beforeAll(async () => {
    const now = new Date().toISOString();
    await storage.insertRun({ runId, workflowId: 'conformance-noop', tenantId: 'default', status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as RunRecord);
    await storage.appendEvent({ eventId: randomUUID(), runId, type: 'run.started', payload: { workflowId: 'conformance-noop' }, timestamp: now });
  });

  it('the TWIN path serves the bundle (not merely registered — this is the served response)', async () => {
    const r = await get(`/v1/host/openwop-app/runs/${encodeURIComponent(runId)}/debug-bundle`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.runId).toBe(runId);
    expect(Array.isArray(r.json.events), 'the bundle carries the event log').toBe(true);
    expect(r.json.metrics?.eventCount).toBeGreaterThan(0);
  });

  it('the v1 path still serves it identically — the twin ADDS an address, it does not move one', async () => {
    const twin = await get(`/v1/host/openwop-app/runs/${encodeURIComponent(runId)}/debug-bundle`);
    const v1 = await get(`/v1/runs/${encodeURIComponent(runId)}/debug-bundle`);
    expect(v1.status).toBe(200);
    expect(v1.json.runId).toBe(twin.json.runId);
    expect(v1.json.events.length).toBe(twin.json.events.length);
  });

  it('the bare-root major-2 path also answers — the manifest is a FLOOR, not a ceiling — and the SPA still uses the twin on purpose', async () => {
    // MEASURED, and it corrected my own expectation: I first asserted 404 here.
    // `spec/v2/core/versioning.md:21` says a host "MUST REACH, under that major,
    // every operation named in spec/v2/path-manifest.json" — a floor. Nothing
    // forbids serving MORE, and this host's major-2 routing is a rewrite onto
    // the v1 handlers (`req.url = '/v1' + req.url`), so every v1 path answers at
    // the bare root. That is permitted, so this pins the real behaviour.
    const r = await get(`/runs/${encodeURIComponent(runId)}/debug-bundle`, { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(200);
    // Why the SPA uses the TWIN rather than this: the bare-root spelling is an
    // artifact of the v1 rewrite and dies with it. The `/host/openwop-app/…`
    // address is host-extension surface by RFC 0181 and survives v1 retirement,
    // which is the whole point of moving the client off `v1Client`.
    // And the id comes back in the DIALECT OF THE ADDRESS: the major-2 protocol
    // path projects it tenant-bound (ADR 0723/0726), while the host-extension
    // twin — v1 dialect by RFC 0181 — returns it bare. One operation, two
    // addresses, two honest spellings. This is what the SPA's bare-id fetch on
    // the twin relies on.
    expect(r.json.runId, 'major-2 protocol path ⇒ tenant-bound').toBe(`default/${runId}`);
    const twin = await get(`/v1/host/openwop-app/runs/${encodeURIComponent(runId)}/debug-bundle`);
    expect(twin.json.runId, 'host-extension twin ⇒ bare').toBe(runId);
  });
});

describe('ADR 0730 C.2 — hostSurfaces travels in the v2 extensions hatch', () => {
  it('the v2 root carries `extensions["openwop-app.host-surfaces"]` with the LIVE registry, not an empty snapshot', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '2' });
    expect(r.status, r.text.slice(0, 160)).toBe(200);
    const rec = r.json?.extensions?.['openwop-app.host-surfaces'];
    expect(rec, 'the extension record is present on the v2 root').toBeDefined();
    expect(Array.isArray(rec.surfaces)).toBe(true);
    // Non-vacuity: the registrar runs after the seed, so a captured-at-registration
    // snapshot would be empty. The seed alone declares the full surface list.
    expect(rec.surfaces.length, 'the record reads the registry live').toBeGreaterThan(5);
    for (const s of rec.surfaces) expect(typeof s.name === 'string' && typeof s.supported === 'boolean').toBe(true);
  });

  it('the v2 root stays CLOSED — the record is under `extensions`, never a new top-level key', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '2' });
    expect(r.json?.hostSurfaces, 'a bare top-level hostSurfaces would fail the corpus root schema').toBeUndefined();
    expect(Object.keys(r.json?.extensions ?? {}).every((k) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(k)), 'every extensions key matches the corpus pattern').toBe(true);
  });

  it('the v1 read keeps serving `capabilities.hostSurfaces` — the v1 wire does not move mid-overlap', async () => {
    const r = await get('/.well-known/openwop');
    expect(Array.isArray(r.json?.capabilities?.hostSurfaces)).toBe(true);
  });
});

describe('ADR 0730 C.3a — the families the SPA reads are advertised on the v2 root', () => {
  it('auth / prompts / secrets / modelCapabilities / aiProviders are all present, and each is a FAMILY RECORD (status+since+witness), not a bare value', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(200);
    for (const fam of ['auth', 'prompts', 'secrets', 'modelCapabilities', 'aiProviders']) {
      const rec = r.json?.[fam];
      expect(rec, `${fam} must be advertised on the v2 root — the SPA reads it`).toBeDefined();
      expect(typeof rec.status, `${fam}.status`).toBe('string');
      expect(typeof rec.since, `${fam}.since`).toBe('string');
      expect(typeof rec.witness, `${fam}.witness`).toBe('string');
    }
  });

  it('auth carries LANES with every required field — a lane row is a claim, not a label', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '2' });
    const lanes = r.json?.auth?.lanes;
    expect(Array.isArray(lanes) && lanes.length > 0, 'at least the unconditional front doors').toBe(true);
    for (const l of lanes) {
      expect(typeof l.lane === 'string' && Array.isArray(l.issuers) && l.issuers.length > 0).toBe(true);
      expect(typeof l.minimumAssurance === 'string').toBe(true);
      // RFC 0170 owner ruling (2026-09-26): `anonymous` has no credential to
      // revoke and OMITS `revocation` (optional on exactly that lane, #1553);
      // every other lane still states its rule.
      if (l.lane === 'anonymous') expect('revocation' in l, 'anonymous claims no revocation').toBe(false);
      else expect(typeof l.revocation).toBe('string');
    }
    // The gated lanes must NOT appear on a deployment that does not configure
    // them — that is the difference between "absent" and "off", and advertising
    // a lane this host cannot honour is the dishonesty the family exists to avoid.
    const names = lanes.map((l: { lane: string }) => l.lane);
    expect(names, 'unconditional lanes').toEqual(expect.arrayContaining(['api-key']));
    // The session lane IS the cookie: advertised exactly when cookies are on.
    if (process.env.OPENWOP_AUTH_DISABLE_COOKIES === 'true') expect(names).not.toContain('session');
    else expect(names).toContain('session');
    if (!process.env.OPENWOP_TEST_SAML_IDP_URL) expect(names).not.toContain('saml');
  });

  it('the per-provider subscription map rides an EXTENSION, because the corpus family types authModes as a flat vocabulary', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '2' });
    expect(Array.isArray(r.json?.aiProviders?.authModes), 'the family carries the vocabulary').toBe(true);
    const rec = r.json?.extensions?.['openwop-app.ai-providers'];
    expect(rec, 'the host-scoped record carries the per-provider detail').toBeDefined();
    expect(Array.isArray(rec.subscriptionProviders)).toBe(true);
  });

  it('the v1 root is UNMOVED — the overlap contract is that v1 readers see no change', async () => {
    const r = await get('/.well-known/openwop');
    expect(Array.isArray(r.json?.auth?.profiles), 'v1 keeps profiles[]').toBe(true);
    expect(r.json?.aiProviders?.authModes, 'v1 keeps the per-provider map').toBeDefined();
  });
});
