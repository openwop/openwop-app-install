/**
 * ADR 0765 — the v2 extension-family records (`extensions["openwop-app.<name>"]`).
 *
 * What makes a claim here honest, pinned three ways:
 *  1. CONTRACT — each record's `methods` equals every `ctx.<surface>.<method>`
 *     its vendored pack calls (read from the pack source, not restated);
 *  2. EXECUTION — the executor's own surface bundle (`buildHostSurfaceBundle`)
 *     provides every one of them, and a bundle missing one OMITS the record;
 *  3. WIRE — over HTTP, v2 discovery carries exactly the claimed families as
 *     well-formed records (the four rules the suite's `v2-ext-family-claims`
 *     applies: key pattern, registered org, not reserved, an object, no root
 *     copy), carries none of the withheld ones, and v1 discovery carries none.
 * Plus `rest-transport`: the advert equals the constant that serves it, and the
 * behaviour (304 on If-None-Match; every advertised encoding applied) holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createApp } from '../src/index.js';
import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { EXT_FAMILY_CLAIMS, extFamilyRecord, missingMethods } from '../src/host/extFamilyRecords.js';
import { SUPPORTED_RUN_ENCODINGS } from '../src/host/restTransport.js';
import { makeDataIntegrationAdapter } from '../src/host/dataIntegrationAdapter.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', '..', '..', 'packs');
const declaration = JSON.parse(readFileSync(join(locateRepoSchemasDir(HERE, 'run-event.schema.json'), 'v2', 'declaration.json'), 'utf8')) as {
  extensionsKeyPattern: string; reservedOrgs: string[]; extensions: Record<string, unknown>;
  families?: { key: string; anchor?: string; extensionName?: string }[];
};
const WITHHELD = ['brand', 'entities', 'coordination', 'a2ui-surface'];
const CLAIMED = [...EXT_FAMILY_CLAIMS.map((c) => c.extensionName), 'rest-transport'];

// One app for the whole file: it also runs initInMemorySurfaces(), which the
// executor's bundle (and so every record) needs.
let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0765 — contract: a record names every surface method its pack calls', () => {
  it.each(EXT_FAMILY_CLAIMS.map((c) => [c.extensionName, c] as const))('%s', (_name, claim) => {
    const src = readFileSync(join(PACKS, claim.nodePack, 'index.mjs'), 'utf8');
    const called = [...new Set([...src.matchAll(new RegExp(`ctx\\.${claim.surface}\\??\\.([A-Za-z0-9_]+)`, 'g'))].map((m) => m[1] as string))].sort();
    expect(called.length, `${claim.nodePack} calls ctx.${claim.surface}`).toBeGreaterThan(0);
    // A method the host does not serve is accounted for only by naming it in
    // `unavailable` (ADR 0783 D9): every call is either claimed or declared missing.
    const declaredMissing = (claim.unavailable ?? [])
      .map((u) => new RegExp(`^ctx\\.${claim.surface}\\.([A-Za-z0-9_]+)$`).exec(u.needs)?.[1])
      .filter((m): m is string => m !== undefined);
    expect([...claim.methods, ...declaredMissing].sort()).toEqual(called);
    for (const m of declaredMissing) expect(claim.methods, `${m} is both claimed and unavailable`).not.toContain(m);
    // A computed call (`ctx.<surface>[op]`) names no method this pin can see, so a
    // pack that dispatches that way cannot be claimed until the ops are enumerated.
    expect(src, `${claim.nodePack} dispatches ctx.${claim.surface}[…] dynamically`).not.toMatch(new RegExp(`ctx\\.${claim.surface}\\??\\.?\\[`));
  });
});

describe('ADR 0765 — execution: the executor\'s surface bundle provides every claimed method', () => {
  const bundleOf = () => buildHostSurfaceBundle({ tenantId: 'default', runId: 'adr0765-test' });
  it.each(EXT_FAMILY_CLAIMS.map((c) => [c.extensionName, c] as const))('%s', (_name, claim) => {
    const bundle = bundleOf();
    expect(missingMethods(claim, bundle)).toEqual([]);
    expect(extFamilyRecord(claim, bundle)).toMatchObject({ servedBy: { nodeContext: `ctx.${claim.surface}`, nodePack: claim.nodePack } });
  });
  it('data-integration: the adapter serves exactly the claimed methods, and the executor gives it a broker and a tenant (ADR 0783 D9)', () => {
    const claim = EXT_FAMILY_CLAIMS.find((c) => c.extensionName === 'data-integration')!;
    expect(Object.keys(makeDataIntegrationAdapter({ runId: 'adr0765-test' })).sort()).toEqual([...claim.methods].sort());
    // fetchRest/fetchGraphql fail host_capability_missing without these, so the
    // record would name methods no node could complete.
    const wiring = /ctx\.dataIntegration = makeDataIntegrationAdapter\(\{([\s\S]*?)\}\);/.exec(readFileSync(join(HERE, '..', 'src', 'executor', 'executor.ts'), 'utf8'))?.[1] ?? '';
    expect(wiring).toMatch(/\btenantId: run\.tenantId\b/);
    expect(wiring).toMatch(/\bconnectors: ctx\.connectors\b/);
    // ADR 0865 B17 — applyBinding fails host_capability_missing without a canvas
    // scope, and one without the run's person would skip the role floor.
    expect(wiring).toMatch(/\bcanvasScope: \{/);
    expect(wiring).toMatch(/\bactingUserId: bundleActingUserId\b/);
    expect(wiring).toMatch(/\borgScopeSubject: bundleOrgScopeSubject\b/);
  });
  it('a surface that loses a method loses its record (the claim cannot outlive the wiring)', () => {
    const claim = EXT_FAMILY_CLAIMS.find((c) => c.extensionName === 'kanban')!;
    const bundle = bundleOf();
    const broken = { ...bundle, kanban: { ...(bundle as unknown as { kanban: Record<string, unknown> }).kanban, taskGet: undefined } } as unknown as typeof bundle;
    expect(missingMethods(claim, broken)).toEqual(['taskGet']);
    expect(() => extFamilyRecord(claim, broken)).toThrow(/ctx\.kanban lacks taskGet/);
  });
});

describe('ADR 0765 — the executor hands each claimed surface to the node context', () => {
  // The record checks the bundle; the pack reads ctx. Both must hold, so pin the
  // hand-off line too: removing `<surface>: surfaces.<surface>` from the ctx the
  // executor builds would leave a record naming a context the nodes never get.
  const executorSrc = readFileSync(join(HERE, '..', 'src', 'executor', 'executor.ts'), 'utf8');
  it.each(EXT_FAMILY_CLAIMS.map((c) => [c.extensionName, c.surface, c.wiring] as const))('%s → ctx.%s', (_name, surface, wiring) => {
    const factory = `make${surface[0]!.toUpperCase()}${surface.slice(1)}Adapter\\(`;
    expect(executorSrc).toMatch(wiring === 'adapter'
      ? new RegExp(`(\\b${surface}: |\\bctx\\.${surface} = )${factory}`)
      : new RegExp(`\\b${surface}: surfaces\\.${surface}\\b`));
  });
});

describe('ADR 0765 — every claimed name is an ext family the declaration defines', () => {
  it('each record name is a declared `extensionName` (anchor: ext)', () => {
    const declared = new Set((declaration.families ?? []).filter((f) => f.anchor === 'ext' && typeof f.extensionName === 'string').map((f) => f.extensionName as string));
    // The vendored declaration gained `extensionName` at suite 2.42.7; skip only an older pin.
    if (declared.size === 0) return;
    for (const name of [...CLAIMED, ...WITHHELD]) expect(declared, `${name} is a declared ext family`).toContain(name);
  });
});

describe('ADR 0765 — wire: v2 discovery carries exactly the claimed families, well-formed', () => {

  const discovery = async () => (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Record<string, unknown> & { extensions?: Record<string, unknown> };

  it('each claimed family is present and passes the claims-check rules', async () => {
    const doc = await discovery();
    const ext = doc.extensions ?? {};
    const keyPattern = new RegExp(declaration.extensionsKeyPattern);
    for (const name of CLAIMED) {
      const key = `openwop-app.${name}`;
      const rec = ext[key];
      expect(rec, `${key} advertised`).toBeDefined();
      expect(keyPattern.test(key), `${key} matches extensionsKeyPattern`).toBe(true);
      expect(Object.keys(declaration.extensions), 'openwop-app is a registered org').toContain('openwop-app');
      expect(declaration.reservedOrgs).not.toContain('openwop-app');
      expect(rec !== null && typeof rec === 'object' && !Array.isArray(rec), `${key} is an object`).toBe(true);
    }
    for (const rootKey of ['canvas', 'chat', 'kanban', 'knowledge', 'launchStudio', 'webResearch', 'messaging', 'dataIntegration', 'restTransport']) {
      expect(Object.keys(doc), `family key ${rootKey} must not also sit at the v2 root`).not.toContain(rootKey);
    }
  });
  it('withheld families are NOT claimed (their packs cannot run here)', async () => {
    const ext = (await discovery()).extensions ?? {};
    for (const name of WITHHELD) expect(ext[`openwop-app.${name}`], `openwop-app.${name}`).toBeUndefined();
  });
  // ADR 0812 P3c-0: "the v1 representation carries none of them" was deleted with
  // the v1 discovery document (a header-less read is the v2 document once 1.x retires).

  it('rest-transport: the advert is the constant that serves it, and the behaviour holds', async () => {
    const rec = (await discovery()).extensions?.['openwop-app.rest-transport'] as { conditionalRunGet: boolean; contentEncodings: string[] };
    expect(rec.conditionalRunGet).toBe(true);
    expect(rec.contentEncodings).toEqual([...SUPPORTED_RUN_ENCODINGS]);
    const cookie = `__session=${signSession(mintAnonSession())}`;
    const created = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    const { runId } = (await created.json()) as { runId: string };
    const first = await fetch(`${base}/runs/${projectBoundId(runId)}`, { headers: { cookie, 'accept-encoding': 'identity' } });
    const etag = first.headers.get('etag');
    expect(first.status, 'the bound id resolves (an ETag on a 404 would pass the next line vacuously)').toBe(200);
    expect(etag, 'a run read carries an ETag').toBeTruthy();
    const again = await fetch(`${base}/runs/${projectBoundId(runId)}`, { headers: { cookie, 'if-none-match': etag! } });
    expect(again.status).toBe(304);
    for (const enc of rec.contentEncodings.filter((e) => e === 'gzip' || e === 'br')) {
      const res = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
        const u = new URL(`${base}/runs/${projectBoundId(runId)}`);
        http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { cookie, 'accept-encoding': enc } }, (r) => {
          const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      expect(res.encoding, `Accept-Encoding: ${enc}`).toBe(enc);
      const decoded = enc === 'gzip' ? gunzipSync(res.body) : brotliDecompressSync(res.body);
      expect(JSON.parse(decoded.toString('utf8')).runId).toBeDefined();
    }
  });
});

describe('restTransport — the advertised codings are the ones a client can RECEIVE', async () => {
  const { resolveRunEncodings } = await import('../src/host/restTransport.js');
  it('unset or blank: the runtime set stands', () => {
    expect(resolveRunEncodings(['zstd', 'br', 'gzip'], undefined)).toEqual(['zstd', 'br', 'gzip']);
    expect(resolveRunEncodings(['zstd', 'br', 'gzip'], '  ')).toEqual(['zstd', 'br', 'gzip']);
  });
  it('declared: the path set narrows it (the Firebase door passes br and gzip, not zstd — measured on prod)', () => {
    expect(resolveRunEncodings(['zstd', 'br', 'gzip'], 'br,gzip')).toEqual(['br', 'gzip']);
  });
  it('a declared coding the runtime cannot encode is dropped, never advertised; preference order is the runtime\'s', () => {
    expect(resolveRunEncodings(['br', 'gzip'], 'gzip, ZSTD ,br')).toEqual(['br', 'gzip']);
  });
});
