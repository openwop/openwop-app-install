/**
 * ADR 1033 — RFC 0253 on this host for `workflow-chain-pack`: a client-submitted
 * chain pack is inert until applied, installs into its tenant only, and reads
 * back through `GET /installed-packs/{packName}` byte for byte.
 *
 * Driven through the real routes with an env key per tenant, as the conformance
 * suite drives them.
 *
 * Guards, and the double guards a one-edit sabotage cannot see (each broken in
 * ONE edit by the w86 probes):
 *  - readback isolation is held twice in `host/tenantInstalledPacks.ts`: the
 *    `${tenant}::${name}` key AND the `row.tenantId === tenant` re-check in
 *    `getTenantInstalledPack`. Either alone reads vacuous.
 *  - the gallery is held twice: `listForTenantIndexed(tenant)` AND its
 *    `r.tenantId === tenant` filter. `from-chain` reads through
 *    `getTenantInstalledChain`, so the instantiate leg is probed on its own.
 *  - each refusal is asserted by its `details.rule`, so a refusal from an
 *    EARLIER check (a different rule with the same 422) does not satisfy it.
 *  - "inert until applied" (the 404s before apply) is an absence claim with no
 *    reasonable sabotage short of installing at submit: an honest ceiling, with
 *    the 200 after apply as its positive control. The malformed-name 404 is a
 *    smoke check only (the name pattern and the store miss both answer it).
 *
 * Sabotage-witnessed (w86 grade-tests, 2026-11-05): dropping `readback` for the
 * kind, rewriting the stored manifest, `<= 0` → `< 0` on the version gate,
 * both readback isolation halves, both gallery halves, the `from-chain` tenant
 * lookup, each of the four 422 rules, both `read-only` ownership checks, and the
 * rollback delete each turn the named case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { canonicalJSON } from '../src/host/jcs.js';
import { resetRfc0249WireCache } from '../src/features/proposals/installedPrompts.js';
import { workflowChainPackInstaller } from '../src/features/proposals/installedPacks.js';
import { listChains } from '../src/host/workflowChainPackLoader.js';
import type { Proposal } from '../src/features/proposals/types.js';

const TENANT_A = 'rfc0253-tenant-a';
const TENANT_B = 'rfc0253-tenant-b';
const KEY_A = 'rfc0253-key-a-0123456789abcdef';
const KEY_B = 'rfc0253-key-b-0123456789abcdef';
let server: http.Server;
let ORIGIN = '';
let n = 0;

interface Res { status: number; body: unknown }
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => (isRec(v) ? v[key] : undefined);
const details = (v: unknown): Rec => {
  const d = field(v, 'details') ?? field(field(v, 'error'), 'details');
  return isRec(d) ? d : {};
};

async function call(key: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openwop-version': '2' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function chainPack(version = '1.0.0', name = `private.adr1033.p${Date.now()}x${n++}`): Rec {
  return {
    name, version, kind: 'workflow-chain', engines: { openwop: '>=2.0 <3.0.0' },
    chains: [{
      chainId: `${name}.passthrough`, version: '1.0.0', label: 'Pass through', description: 'Passes its input through.',
      parameters: { type: 'object', properties: {} },
      dag: { nodes: [{ id: 'n1', typeId: 'core.noop@1.0.0' }] },
    }],
  };
}
const packPath = (name: string): string => `/installed-packs/${encodeURIComponent(name)}`;

async function submit(key: string, artifact: Rec): Promise<{ id: string; artifactDigest: string }> {
  const s = await call(key, 'POST', '/proposals', { kind: 'workflow-chain-pack', artifact, title: 'A chain pack' });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { id: field(s.body, 'id') as string, artifactDigest: field(s.body, 'artifactDigest') as string };
}
const apply = (key: string, p: { id: string; artifactDigest: string }): Promise<Res> =>
  call(key, 'POST', `/proposals/${encodeURIComponent(p.id)}:apply`, { artifactDigest: p.artifactDigest });
const stateOf = async (id: string): Promise<unknown> => field((await call(KEY_A, 'GET', `/proposals/${encodeURIComponent(id)}`)).body, 'state');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = `${KEY_A}:${TENANT_A},${KEY_B}:${TENANT_B}`;
  resetRfc0249WireCache(true);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  resetRfc0249WireCache();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1033 — advertisement', () => {
  it('advertises workflow-chain-pack in artifactKinds and readback', async () => {
    const r = await call(KEY_A, 'GET', '/.well-known/openwop');
    const facet = field(field(r.body, 'agents'), 'proposals');
    expect(field(facet, 'artifactKinds')).toContain('workflow-chain-pack');
    expect(field(facet, 'readback')).toContain('workflow-chain-pack');
  });
});

describe('ADR 1033 — the lifecycle', () => {
  it('is inert until applied, then reads back the reviewed revision verbatim', async () => {
    const p = chainPack();
    const name = p['name'] as string;
    const first = await submit(KEY_A, p);
    expect((await call(KEY_A, 'GET', packPath(name))).status).toBe(404);

    const p2 = { ...p, description: 'A one-node chain that passes its input through.' };
    const revised = await call(KEY_A, 'PATCH', `/proposals/${encodeURIComponent(first.id)}`, { artifact: p2 });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect((await call(KEY_A, 'GET', packPath(name))).status).toBe(404);

    const applied = await apply(KEY_A, { id: first.id, artifactDigest: field(revised.body, 'artifactDigest') as string });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(field(field(applied.body, 'activation'), 'installedArtifact'))
      .toEqual({ kind: 'workflow-chain-pack', operationId: 'getInstalledPack', id: name, version: '1.0.0' });

    const back = await call(KEY_A, 'GET', packPath(name));
    expect(back.status).toBe(200);
    expect(canonicalJSON(back.body)).toBe(canonicalJSON(p2));
    expect(canonicalJSON(back.body)).not.toBe(canonicalJSON(p));
  });

  it('refuses a second apply at the installed version, and replaces on a higher one', async () => {
    const p = chainPack();
    const name = p['name'] as string;
    expect((await apply(KEY_A, await submit(KEY_A, p))).status).toBe(200);

    const again = await submit(KEY_A, p);
    const conflict = await apply(KEY_A, again);
    expect(conflict.status).toBe(409);
    expect(field(conflict.body, 'error') ?? field(conflict.body, 'code')).toBe('proposal_install_conflict');
    expect(details(conflict.body)['reason']).toBe('version-not-greater');
    expect(await stateOf(again.id)).toBe('draft');

    const higher = { ...chainPack('1.1.0', name) };
    expect((await apply(KEY_A, await submit(KEY_A, higher))).status).toBe(200);
    expect(canonicalJSON((await call(KEY_A, 'GET', packPath(name))).body)).toBe(canonicalJSON(higher));
  });

  it('is invisible to another tenant: the same 404 as an unknown name', async () => {
    const p = chainPack();
    const name = p['name'] as string;
    expect((await apply(KEY_A, await submit(KEY_A, p))).status).toBe(200);
    const foreign = await call(KEY_B, 'GET', packPath(name));
    const unknown = await call(KEY_B, 'GET', packPath(`private.adr1033.unknown${n++}`));
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(unknown);
    expect((await call(KEY_A, 'GET', packPath('not a pack name'))).status).toBe(404);
  });
});

describe('ADR 1033 — refusals install nothing', () => {
  // [what, mutate, the `details.rule` of the ONE check that must refuse it]
  const cases: Array<[string, (p: Rec) => Rec, string]> = [
    ['a name outside private.*', (p) => ({ ...p, name: `vendor.adr1033.v${n++}` }), 'private-namespace'],
    ['signing', (p) => ({ ...p, signing: { keyId: 'k', scheme: 'ed25519-canonical-json' } }), 'no-signing'],
    ['an unpinned node reference', (p) => ({ ...p, chains: [{ ...(p['chains'] as Rec[])[0], dag: { nodes: [{ id: 'n1', typeId: 'core.noop' }] } }] }), 'workflow_chain_unpinned'],
    ['a graduation skeleton, not a manifest', () => ({ toolSequence: ['a', 'b'], occurrences: 3 }), 'required'],
  ];
  for (const [what, mutate, rule] of cases) {
    it(`refuses ${what} with 422`, async () => {
      const artifact = mutate(chainPack());
      const p = await submit(KEY_A, artifact);
      const r = await apply(KEY_A, p);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(field(r.body, 'error')).toBe('validation_error');
      expect(details(r.body)['rule']).toBe(rule);
      expect(await stateOf(p.id)).toBe('draft');
      if (typeof artifact['name'] === 'string') expect((await call(KEY_A, 'GET', packPath(artifact['name']))).status).toBe(404);
    });
  }

  it('refuses a chain id the host owns as read-only', async () => {
    const owned = listChains()[0];
    expect(owned, 'the test boot loads the vendored chain packs').toBeDefined();
    const p = chainPack();
    const artifact = { ...p, chains: [{ ...(p['chains'] as Rec[])[0], chainId: owned!.chain.chainId }] };
    const r = await apply(KEY_A, await submit(KEY_A, artifact));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(field(r.body, 'error')).toBe('proposal_install_conflict');
    expect(details(r.body)['reason']).toBe('read-only');
  });

  it('refuses a chain id another installed pack in the tenant contributes', async () => {
    const a = chainPack();
    expect((await apply(KEY_A, await submit(KEY_A, a))).status).toBe(200);
    const b = chainPack();
    const artifact = { ...b, chains: [{ ...(b['chains'] as Rec[])[0], chainId: (a['chains'] as Rec[])[0]!['chainId'] }] };
    const r = await apply(KEY_A, await submit(KEY_A, artifact));
    expect(r.status).toBe(409);
    expect(field(r.body, 'error')).toBe('proposal_install_conflict');
    expect(details(r.body)['reason']).toBe('read-only');
  });

  it('an install undone by rollback leaves nothing to read', async () => {
    const p = chainPack();
    const proposal: Proposal = { id: `p:rb${n++}`, kind: 'workflow-chain-pack', state: 'draft', artifact: p, provenance: { sourceRunIds: [] }, owner: { tenant: TENANT_A }, createdAt: new Date().toISOString() };
    const out = await workflowChainPackInstaller.install(TENANT_A, proposal);
    const installed = await call(KEY_A, 'GET', packPath(p['name'] as string));
    expect(installed.status).toBe(200);
    expect(canonicalJSON(installed.body)).toBe(canonicalJSON(p));
    expect(out.rollback).toBeTypeOf('function');
    await out.rollback?.();
    const gone = await call(KEY_A, 'GET', packPath(p['name'] as string));
    expect(gone.status).toBe(404);
    expect(field(gone.body, 'error')).toBe('not_found');
  });
});

describe('ADR 1033 D5 — an installed chain is a template in its tenant only', () => {
  it('lists and instantiates in the applying tenant; another tenant cannot', async () => {
    const p = chainPack();
    const chainId = (p['chains'] as Rec[])[0]!['chainId'] as string;
    expect((await apply(KEY_A, await submit(KEY_A, p))).status).toBe(200);

    const listed = (r: Res): unknown[] => ((field(r.body, 'chains') as Rec[] | undefined) ?? []).map((c) => c['chainId']);
    expect(listed(await call(KEY_A, 'GET', '/host/openwop-app/workflow-chains'))).toContain(chainId);
    expect(listed(await call(KEY_B, 'GET', '/host/openwop-app/workflow-chains'))).not.toContain(chainId);

    const made = await call(KEY_A, 'POST', '/host/openwop-app/workflows/from-chain', { chainId });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(typeof field(made.body, 'workflowId')).toBe('string');
    // Another tenant gets exactly the refusal an unknown chain id gets.
    const foreign = await call(KEY_B, 'POST', '/host/openwop-app/workflows/from-chain', { chainId });
    const unknown = await call(KEY_B, 'POST', '/host/openwop-app/workflows/from-chain', { chainId: `private.adr1033.unknown${n++}.passthrough` });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(field(foreign.body, 'error')).toBe('not_found');
    expect(field(foreign.body, 'message')).toBe(field(unknown.body, 'message'));
  });
});
