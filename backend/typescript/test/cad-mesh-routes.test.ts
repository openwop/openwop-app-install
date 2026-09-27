/**
 * ADR 0388 P1 — CAD mesh interchange routes. ROUTE-level: import (canonical
 * STL → content-addressed mesh asset + NEW canvas + disclosed drops), the
 * byte/format guards (413/422 typed failures, never lookalikes), export
 * (STL/GLB → capability URL that actually serves the bytes), mesh-meta read
 * (cross-tenant 404 — no existence leak), and the `mesh` solid kind in the
 * editor validator (assetRef required; mesh-only fields rejected elsewhere).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { emitCanonicalStl, parseStl } from '../src/features/cad/meshCodec.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const cad = getToggleDefault('cad');
  if (cad) await saveConfig({ ...cad, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = Record<string, unknown>> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as Record<string, unknown> };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    /** Raw fetch for byte downloads (the capability URL). */
    fetchRaw: (p: string) => fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {} }),
  };
}

let n = 0;
async function orgOwner() {
  const tenantId = `org:test-cadmesh-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cadm-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: String(org.body.orgId), tenantId };
}

const CAD = (orgId: string) => `/v1/host/openwop-app/cad/orgs/${encodeURIComponent(orgId)}`;

/** A 2-triangle canonical mesh, base64. */
const MESH_B64 = Buffer.from(
  emitCanonicalStl(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 0, 10, 5])),
).toString('base64');

describe('CAD mesh interchange (ADR 0388 P1)', () => {
  it('imports a canonical mesh → content-addressed asset + a NEW canvas with one mesh solid', async () => {
    const { c, orgId } = await orgOwner();
    const imp = await c.post(`${CAD(orgId)}/canvases/import`, {
      contentBase64: MESH_B64, name: 'Widget scan', sourceFormat: 'obj', dropped: ['materials'],
    });
    expect(imp.status).toBe(201);
    const mesh = imp.body.mesh as { meshId: string; triangleCount: number; serveUrl: string; dropped: string[] };
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.dropped).toEqual(['materials']); // disclosed, never silent
    const state = imp.body.state as { solids: Array<{ kind: string; assetRef: string }> };
    expect(state.solids[0]?.kind).toBe('mesh');
    expect(state.solids[0]?.assetRef).toBe(mesh.meshId);

    // content addressing: a re-import of the SAME bytes converges on the same meshId
    const again = await c.post(`${CAD(orgId)}/canvases/import`, { contentBase64: MESH_B64, name: 'Dup' });
    expect(again.status).toBe(201);
    expect((again.body.mesh as { meshId: string }).meshId).toBe(mesh.meshId);

    // mesh meta read
    const meta = await c.get(`${CAD(orgId)}/meshes/${encodeURIComponent(mesh.meshId)}`);
    expect(meta.status).toBe(200);
    expect((meta.body as { triangleCount: number }).triangleCount).toBe(2);

    // the serve URL actually yields the canonical bytes
    const raw = await c.fetchRaw(mesh.serveUrl);
    expect(raw.status).toBe(200);
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(parseStl(bytes).triangleCount).toBe(2);
  });

  it('typed failures: missing content 400, garbage 422, oversized 413', async () => {
    const { c, orgId } = await orgOwner();
    expect((await c.post(`${CAD(orgId)}/canvases/import`, {})).status).toBe(400);
    const garbage = Buffer.from('not a mesh at all, definitely not').toString('base64');
    const bad = await c.post(`${CAD(orgId)}/canvases/import`, { contentBase64: garbage });
    expect(bad.status).toBe(422);
    const huge = 'A'.repeat(6 * 1024 * 1024); // > the 4 MB decoded cap, < the 8 MB parser envelope
    expect((await c.post(`${CAD(orgId)}/canvases/import`, { contentBase64: huge })).status).toBe(413);
  });

  /**
   * `CADC-2`, CORRECTED. The row asked for a route test that an "external-referencing
   * mesh" is rejected across the HTTP boundary. **That test cannot exist as specified,
   * and finding out why is the point.**
   *
   * The external-buffer-URI refusal (the SSRF posture) lives in `parseGltf`. On the
   * SERVER that function has ZERO production callers: the browser parses OBJ/glTF with
   * its own copy of the codec and uploads CANONICAL STL, and `createMeshAsset` always
   * `parseStl`s (`meshAssets.ts:87`) whatever `sourceFormat` says — that field is
   * metadata recording what the client converted FROM, not a parser selector.
   *
   * So a glTF never reaches a server-side glTF parser, and the route has no URI to
   * dereference. My first version of this test sent glTF JSON and asserted a 422; it
   * passed — as a binary-STL LENGTH MISMATCH, never touching the guard it named.
   * Printing the refusal body is what exposed that.
   *
   * What is worth pinning is therefore the real contract, plus the fact that makes it
   * true: if someone later wires the server-side glTF parser into an import path, the
   * second leg reds and they must bring the guard's route coverage with it.
   */
  it('the server parses STL ONLY — a glTF payload is refused, never dereferenced', async () => {
    const { c, orgId } = await orgOwner();
    const before = await c.get(`${CAD(orgId)}/canvases`);
    const beforeCount = Array.isArray(before.body?.items) ? before.body.items.length : 0;

    const external = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'https://evil.example/mesh.bin', byteLength: 100 }],
      meshes: [], nodes: [], scenes: [{ nodes: [] }],
    });
    // `sourceFormat: 'gltf'` is accepted by the route as METADATA and changes no parse.
    const res = await c.post(`${CAD(orgId)}/canvases/import`, {
      contentBase64: Buffer.from(external).toString('base64'),
      sourceFormat: 'gltf',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(422);
    expect((res.body as { details?: { code?: string } }).details?.code,
      'refused by the STL parser — the server never interpreted the glTF, so the URI was never seen')
      .toBe('malformed');
    const after = await c.get(`${CAD(orgId)}/canvases`);
    expect(Array.isArray(after.body?.items) ? after.body.items.length : 0,
      'a refused import leaves no canvas behind').toBe(beforeCount);
  });

  it('STRUCTURAL: the server-side glTF/OBJ parsers have no production caller — wiring one must bring route coverage', () => {
    const root = new URL('../src/', import.meta.url);
    const files: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(child); }
        else if (e.name.endsWith('.ts')) files.push(fileURLToPath(child));
      }
    };
    walk(root);
    const callers = (fn: string): string[] => files
      .filter((f) => !f.endsWith('meshCodec.ts'))
      // A CALL site, not a substring: `parseObj(` never matches `parseObjective(`.
      .filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(readFileSync(f, 'utf8')));
    expect(callers('parseGltf'), 'a server-side glTF parse would put the SSRF guard on a live path').toEqual([]);
    expect(callers('parseMesh'), 'the format dispatcher is likewise server-dead').toEqual([]);
    // Control: the parser the server DOES use must be found, or this leg proves nothing.
    expect(callers('parseStl').length, 'control — parseStl is live on the import path').toBeGreaterThan(0);
  });

  it('exports STL and GLB from a parametric model; the URL serves real bytes', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${CAD(orgId)}/canvases`, { name: 'Block' });
    expect(created.status).toBe(201);
    const canvasId = String(created.body.canvasId);

    const stl = await c.post(`${CAD(orgId)}/canvases/${canvasId}/export`, { format: 'stl' });
    expect(stl.status).toBe(201);
    expect(String(stl.body.filename)).toMatch(/\.stl$/);
    const stlRaw = await c.fetchRaw(String(stl.body.url));
    expect(stlRaw.status).toBe(200);
    const parsed = parseStl(new Uint8Array(await stlRaw.arrayBuffer()));
    expect(parsed.triangleCount).toBe(12); // one box

    const glb = await c.post(`${CAD(orgId)}/canvases/${canvasId}/export`, { format: 'gltf' });
    expect(glb.status).toBe(201);
    expect(String(glb.body.filename)).toMatch(/\.glb$/);
    expect((await c.fetchRaw(String(glb.body.url))).status).toBe(200);

    expect((await c.post(`${CAD(orgId)}/canvases/${canvasId}/export`, { format: 'step' })).status).toBe(400);
  });

  it('export embeds a referenced mesh (posed) alongside parametric solids', async () => {
    const { c, orgId } = await orgOwner();
    const imp = await c.post(`${CAD(orgId)}/canvases/import`, { contentBase64: MESH_B64, name: 'Ref' });
    const canvasId = String(imp.body.canvasId);
    const stl = await c.post(`${CAD(orgId)}/canvases/${canvasId}/export`, { format: 'stl' });
    expect(stl.status).toBe(201);
    const raw = await c.fetchRaw(String(stl.body.url));
    expect(parseStl(new Uint8Array(await raw.arrayBuffer())).triangleCount).toBe(2);
  });

  it('BOM route (ADR 0388 P2): rows incl. a flagged mesh row; CSV capability URL serves', async () => {
    const { c, orgId } = await orgOwner();
    const imp = await c.post(`${CAD(orgId)}/canvases/import`, { contentBase64: MESH_B64, name: 'BomMesh' });
    const canvasId = String(imp.body.canvasId);
    const bomRes = await c.post(`${CAD(orgId)}/canvases/${canvasId}/bom`, {});
    expect(bomRes.status).toBe(201);
    const bom = bomRes.body.bom as { rows: Array<{ kind: string; volumeApprox?: boolean; quantity: number }>; totals: { parts: number; volumeApprox?: boolean } };
    expect(bom.rows).toHaveLength(1);
    expect(bom.rows[0]?.kind).toBe('mesh');
    expect(bom.rows[0]?.volumeApprox).toBe(true); // disclosed approximation
    expect(bom.totals.parts).toBe(1);
    // UX_UPGRADE-cad R2 (CAD2-B3) — the TOTAL inherits its parts' disclosure.
    // The row flag existed ("exact ONLY for a closed mesh — disclosed, never
    // silent") while the total summed approximate and exact volumes and carried
    // nothing, and the CSV wrote an EMPTY cell in the approx column for it —
    // an affirmative claim of exactness on the number a quoting spreadsheet
    // actually reads.
    expect(bom.totals.volumeApprox, 'an approximate part makes the total approximate').toBe(true);
    const csvRaw = await c.fetchRaw(String(bomRes.body.csvUrl));
    expect(csvRaw.status).toBe(200);
    const csv = await csvRaw.text();
    expect(csv.split('\n')[0]).toContain('label,kind,quantity');
    expect(csv).toContain('TOTAL');
    const totalLine = csv.trim().split('\n').at(-1)!;
    expect(totalLine.startsWith('TOTAL')).toBe(true);
    expect(totalLine.endsWith(',yes'), 'the TOTAL row discloses the approximation').toBe(true);
  });

  it('cross-tenant meshId reads as 404 (no existence leak)', async () => {
    const a = await orgOwner();
    const imp = await a.c.post(`${CAD(a.orgId)}/canvases/import`, { contentBase64: MESH_B64 });
    const meshId = (imp.body.mesh as { meshId: string }).meshId;
    const b = await orgOwner();
    expect((await b.c.get(`${CAD(b.orgId)}/meshes/${encodeURIComponent(meshId)}`)).status).toBe(404);
  });

  it('editor validator: mesh requires assetRef; mesh-only fields rejected on other kinds', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${CAD(orgId)}/canvases`, { name: 'V' });
    const canvasId = String(created.body.canvasId);
    const version = (created.body as { version?: number }).version ?? 1;

    const res1 = await c.patch(`${CAD(orgId)}/canvases/${canvasId}`, {
      state: { name: 'V', units: 'mm', solids: [{ kind: 'mesh' }] }, baseVersion: version,
    });
    expect(res1.status).toBe(422);
    const res2 = await c.patch(`${CAD(orgId)}/canvases/${canvasId}`, {
      state: { name: 'V', units: 'mm', solids: [{ kind: 'box', width: 10, assetRef: 'x' }] }, baseVersion: version,
    });
    expect(res2.status).toBe(422);
  });
});
