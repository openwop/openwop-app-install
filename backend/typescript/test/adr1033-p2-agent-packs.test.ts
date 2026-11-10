/**
 * ADR 1033 P2 — RFC 0253 for `agent-pack`, and a tenant chain that composes a
 * sibling sub-chain.
 *
 * An applied agent pack installs tenant-owned agents: unresolvable while the
 * proposal is a draft, resolvable and listed in the applying tenant after apply,
 * the same 404 as an unknown id in any other tenant. The pack reads back byte for
 * byte. Driven through the real routes with an env key per tenant.
 *
 * Guards: tenant visibility is the projected agent's `ownerTenant`; the pack
 * readback is held twice (`${tenant}::${name}` key AND the `row.tenantId`
 * re-check in `getTenantInstalledPack`); a second instance resolves through the
 * `hydrateInstalledPackAgent` miss path. Each refusal is asserted by its
 * `details.rule`, so an EARLIER check's 422 does not satisfy it. `systemPromptRef`
 * is held twice by design: `no-file-ref`, and `inline-prompt` (the ref replaces
 * the inline prompt), so the rule pin is what tells them apart.
 *
 * Sabotage-witnessed (w86 grade-tests, 2026-11-05): dropping `readback` for the
 * kind, rewriting the stored manifest, dropping `ownerTenant`, both readback
 * isolation halves, the hydrate lookup, the dropped-agent removal, the rollback
 * delete, each refusal rule, the agent-id collision check, `<= 0` → `< 0` on the
 * version gate, and the sibling resolver each turn the named case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { canonicalJSON } from '../src/host/jcs.js';
import { resetRfc0249WireCache } from '../src/features/proposals/installedPrompts.js';
import { agentPackInstaller } from '../src/features/proposals/installedPacks.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { Proposal } from '../src/features/proposals/types.js';

const TENANT_A = 'adr1033p2-tenant-a';
const TENANT_B = 'adr1033p2-tenant-b';
const KEY_A = 'adr1033p2-key-a-0123456789abcdef';
const KEY_B = 'adr1033p2-key-b-0123456789abcdef';
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

function agentPack(version = '1.0.0', name = `private.adr1033.a${Date.now()}x${n++}`): Rec {
  return {
    name, version, kind: 'node', engines: { openwop: '>=2.0 <3.0.0' },
    runtime: { language: 'remote', entry: 'https://conformance.invalid/agents' },
    agents: [{ agentId: `${name}.triage`, persona: 'Triage', modelClass: 'general', systemPrompt: 'You triage the input.' }],
  };
}
const agent0 = (p: Rec): Rec => (p['agents'] as Rec[])[0]!;
const agentIdOf = (p: Rec): string => agent0(p)['agentId'] as string;
const packPath = (name: string): string => `/installed-packs/${encodeURIComponent(name)}`;
const agentPath = (id: string): string => `/agents/${encodeURIComponent(id)}`;
const listed = async (key: string, id: string): Promise<boolean> =>
  ((field((await call(key, 'GET', '/agents')).body, 'agents') as Rec[] | undefined) ?? []).some((a) => a['agentId'] === id);

async function submit(key: string, kind: string, artifact: Rec): Promise<{ id: string; artifactDigest: string }> {
  const s = await call(key, 'POST', '/proposals', { kind, artifact, title: 'A pack' });
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

describe('ADR 1033 P2 — advertisement', () => {
  it('advertises agent-pack in artifactKinds and readback', async () => {
    const facet = field(field((await call(KEY_A, 'GET', '/.well-known/openwop')).body, 'agents'), 'proposals');
    expect(field(facet, 'artifactKinds')).toContain('agent-pack');
    expect(field(facet, 'readback')).toContain('agent-pack');
  });
});

describe('ADR 1033 P2 — the agent-pack lifecycle', () => {
  it('is inert until applied, then installs tenant-owned agents and reads back the revision', async () => {
    const p = agentPack();
    const name = p['name'] as string;
    const agentId = agentIdOf(p);
    const first = await submit(KEY_A, 'agent-pack', p);
    expect((await call(KEY_A, 'GET', packPath(name))).status).toBe(404);
    expect((await call(KEY_A, 'GET', agentPath(agentId))).status).toBe(404);
    expect(await listed(KEY_A, agentId)).toBe(false);

    const p2 = { ...p, agents: [{ ...agent0(p), systemPrompt: 'You triage the input into exactly one of three queues.' }] };
    const revised = await call(KEY_A, 'PATCH', `/proposals/${encodeURIComponent(first.id)}`, { artifact: p2 });
    expect(revised.status).toBe(200);
    const applied = await apply(KEY_A, { id: first.id, artifactDigest: field(revised.body, 'artifactDigest') as string });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(field(field(applied.body, 'activation'), 'installedArtifact'))
      .toEqual({ kind: 'agent-pack', operationId: 'getInstalledPack', id: name, version: '1.0.0' });

    const back = await call(KEY_A, 'GET', packPath(name));
    expect(canonicalJSON(back.body)).toBe(canonicalJSON(p2));
    expect((await call(KEY_A, 'GET', agentPath(agentId))).status).toBe(200);
    expect(await listed(KEY_A, agentId)).toBe(true);
    expect(getAgentRegistry().get(agentId, TENANT_A)?.systemPrompt).toBe('You triage the input into exactly one of three queues.');

    const foreignAgent = await call(KEY_B, 'GET', agentPath(agentId));
    const unknownAgent = await call(KEY_B, 'GET', agentPath(`${name}.unknown`));
    expect(foreignAgent.status).toBe(404);
    expect(foreignAgent.body).toEqual({ ...(unknownAgent.body as Rec), message: (foreignAgent.body as Rec)['message'] });
    expect(await listed(KEY_B, agentId)).toBe(false);
    expect((await call(KEY_B, 'GET', packPath(name))).status).toBe(404);
  });

  it('an instance that did not run the apply resolves the agent from the store', async () => {
    const p = agentPack();
    const agentId = agentIdOf(p);
    expect((await apply(KEY_A, await submit(KEY_A, 'agent-pack', p))).status).toBe(200);
    getAgentRegistry().remove(agentId, TENANT_A); // as on a second instance
    expect(getAgentRegistry().get(agentId, TENANT_A)).toBeNull();
    expect(await listed(KEY_A, agentId)).toBe(true);
    expect((await call(KEY_A, 'GET', agentPath(agentId))).status).toBe(200);
  });

  it('a higher version replaces the agents; the dropped agent stops resolving', async () => {
    const name = `private.adr1033.r${n++}`;
    const v1 = { ...agentPack('1.0.0', name), agents: [
      { agentId: `${name}.keep`, persona: 'Keep', modelClass: 'general', systemPrompt: 'v1 keep' },
      { agentId: `${name}.drop`, persona: 'Drop', modelClass: 'general', systemPrompt: 'v1 drop' },
    ] };
    expect((await apply(KEY_A, await submit(KEY_A, 'agent-pack', v1))).status).toBe(200);
    const v2 = { ...v1, version: '1.1.0', agents: [{ agentId: `${name}.keep`, persona: 'Keep', modelClass: 'general', systemPrompt: 'v2 keep' }] };
    expect((await apply(KEY_A, await submit(KEY_A, 'agent-pack', v2))).status).toBe(200);
    expect((await call(KEY_A, 'GET', agentPath(`${name}.drop`))).status).toBe(404);
    expect(getAgentRegistry().get(`${name}.keep`, TENANT_A)?.systemPrompt).toBe('v2 keep');
  });

  it('a rollback removes the agents it installed', async () => {
    const p = agentPack();
    const proposal: Proposal = { id: `p:rb${n++}`, kind: 'agent-pack', state: 'draft', artifact: p, provenance: { sourceRunIds: [] }, owner: { tenant: TENANT_A }, createdAt: new Date().toISOString() };
    const out = await agentPackInstaller.install(TENANT_A, proposal);
    const installed = await call(KEY_A, 'GET', agentPath(agentIdOf(p)));
    expect(installed.status).toBe(200);
    expect(field(installed.body, 'agentId')).toBe(agentIdOf(p));
    expect(out.rollback).toBeTypeOf('function');
    await out.rollback?.();
    const agentGone = await call(KEY_A, 'GET', agentPath(agentIdOf(p)));
    expect(agentGone.status).toBe(404);
    expect(field(agentGone.body, 'error')).toBe('not_found');
    const packGone = await call(KEY_A, 'GET', packPath(p['name'] as string));
    expect(packGone.status).toBe(404);
    expect(field(packGone.body, 'error')).toBe('not_found');
  });
});

describe('ADR 1033 P2 — refusals install nothing', () => {
  // [what, mutate, the `details.rule` of the ONE check that must refuse it]
  const cases: Array<[string, (p: Rec) => Rec, string]> = [
    ['an agent carrying systemPromptRef', (p) => { const { systemPrompt: _s, ...a } = agent0(p); return { ...p, agents: [{ ...a, systemPromptRef: 'prompts/a.md' }] }; }, 'no-file-ref'],
    ['an agent carrying evalSuiteRef', (p) => ({ ...p, agents: [{ ...agent0(p), evalSuiteRef: 'evals/a.json' }] }), 'no-file-ref'],
    ['a handoff schema ref', (p) => ({ ...p, agents: [{ ...agent0(p), handoff: { taskSchemaRef: 'schemas/t.json' } }] }), 'no-file-ref'],
    ['a pack with nodes', (p) => ({ ...p, nodes: [{ typeId: `${String(p['name'])}.n`, version: '1.0.0', category: 'data', role: 'pure' }] }), 'no-nodes'],
    ['a non-remote runtime', (p) => ({ ...p, runtime: { language: 'javascript', entry: 'index.mjs' } }), 'remote-runtime'],
    ['an agent outside the pack namespace', (p) => ({ ...p, agents: [{ ...agent0(p), agentId: 'private.elsewhere.agent' }] }), 'agent-namespace'],
    // The agent id stays INSIDE the renamed pack's namespace, so the private-name
    // check is the one that refuses (an id built from a different counter value
    // used to be refused by the namespace check first).
    ['a name outside private.*', (p) => { const name = `vendor.adr1033.v${n++}`; return { ...p, name, agents: [{ ...agent0(p), agentId: `${name}.triage` }] }; }, 'private-namespace'],
    ['signing', (p) => ({ ...p, signing: { keyId: 'k', scheme: 'ed25519-canonical-json' } }), 'no-signing'],
    ['an oversized system prompt', (p) => ({ ...p, agents: [{ ...agent0(p), systemPrompt: 'x'.repeat(16_001) }] }), 'prompt-length'],
  ];
  for (const [what, mutate, rule] of cases) {
    it(`refuses ${what}`, async () => {
      const artifact = mutate(agentPack());
      const s = await call(KEY_A, 'POST', '/proposals', { kind: 'agent-pack', artifact });
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      const r = await apply(KEY_A, { id: field(s.body, 'id') as string, artifactDigest: field(s.body, 'artifactDigest') as string });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(field(r.body, 'error')).toBe('validation_error');
      expect(details(r.body)['rule']).toBe(rule);
      expect(await stateOf(field(s.body, 'id') as string)).toBe('draft');
      expect((await call(KEY_A, 'GET', packPath(artifact['name'] as string))).status).toBe(404);
      expect((await call(KEY_A, 'GET', agentPath(agentIdOf(artifact)))).status).toBe(404);
    });
  }

  it('refuses an agent id another installed pack in the tenant already resolves', async () => {
    const a = agentPack();
    expect((await apply(KEY_A, await submit(KEY_A, 'agent-pack', a))).status).toBe(200);
    // Same agent id, a different (sibling-named) pack: the id must be in the pack's
    // namespace, so the colliding pack's name is the agent id itself.
    const b = { ...agentPack('1.0.0', agentIdOf(a)), agents: [{ ...agent0(a) }] };
    const r = await apply(KEY_A, await submit(KEY_A, 'agent-pack', b));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(field(r.body, 'error')).toBe('proposal_install_conflict');
    expect(details(r.body)['reason']).toBe('read-only');
  });

  it('refuses a second apply at the installed version', async () => {
    const p = agentPack();
    expect((await apply(KEY_A, await submit(KEY_A, 'agent-pack', p))).status).toBe(200);
    const r = await apply(KEY_A, await submit(KEY_A, 'agent-pack', p));
    expect(r.status).toBe(409);
    expect(field(r.body, 'error')).toBe('proposal_install_conflict');
    expect(details(r.body)['reason']).toBe('version-not-greater');
  });
});

describe('ADR 1033 P2 — a tenant chain composes a sibling sub-chain', () => {
  it('instantiates with the child resolved inside the installed pack', async () => {
    const name = `private.adr1033.s${n++}`;
    const child = { chainId: `${name}.child`, version: '1.0.0', label: 'Child', description: 'Child.', parameters: { type: 'object', properties: {} }, dag: { nodes: [{ id: 'c1', typeId: 'core.noop@1.0.0' }] } };
    const parent = {
      chainId: `${name}.parent`, version: '1.0.0', label: 'Parent', description: 'Parent.', parameters: { type: 'object', properties: {} },
      subChains: [{ ref: `${name}.child` }],
      dag: { nodes: [{ id: 'p1', typeId: 'core.subWorkflow@1.0.0', config: { subChainRef: `${name}.child` }, inputs: {} }], edges: [] },
    };
    const pack = { name, version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=2.0 <3.0.0' }, chains: [child, parent] };
    const r = await apply(KEY_A, await submit(KEY_A, 'workflow-chain-pack', pack));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const made = await call(KEY_A, 'POST', '/host/openwop-app/workflows/from-chain', { chainId: `${name}.parent` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const childIds = (field(made.body, 'subChainWorkflowIds') as unknown[] | undefined) ?? [];
    expect(childIds).toHaveLength(1);
    // The co-registered child IS the installed sibling: its one node is the
    // child chain's noop, not the parent's sub-workflow node.
    const childWf = await call(KEY_A, 'GET', `/workflows/${encodeURIComponent(String(childIds[0]))}`);
    expect(childWf.status, JSON.stringify(childWf.body)).toBe(200);
    const childNodes = (field(childWf.body, 'nodes') as Rec[] | undefined) ?? [];
    expect(childNodes).toHaveLength(1);
    expect(String(childNodes[0]!['typeId'])).toMatch(/^core\.noop(@1\.0\.0)?$/);
  });
});
