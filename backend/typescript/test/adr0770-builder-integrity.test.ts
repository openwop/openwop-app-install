/**
 * ADR 0770 — the workflow builder never loses or overwrites a user's workflow.
 * Route-level (createApp + real principals), because every decision here is only
 * observable at the HTTP boundary:
 *
 *   - D1 (`WBWF-3`): a VIEWER member is refused every write verb; an editor, a
 *     tenant-pinned env key and an `owk_` key in its issuer's personal workspace
 *     are not (the provenance classification — `requireTenantScope` alone refused
 *     the last two).
 *   - D3 (`WBWF-1`): re-instantiating a sub-chain template REUSES a child the
 *     tenant edited, REFRESHES a pristine one, and keeps an archived one archived.
 *   - D4 (`WBWF-4`): node `name` + `position` round-trip; a drag does not move the
 *     revision hash, a rename does.
 *   - D5 (`WBWF-6`): `If-Match` with a stale revision is a typed 409; the head read
 *     and every 201 carry the revision the next save must send.
 *
 * Red when (wave 60 probes, tracker TST-BRB-2): the D1 gate stops asserting
 * `workspace:write` for a subject, skips the tenant-owner branch or the personal
 * key branch; a drag moves the revision hash; `position` validation or the `name`
 * passthrough is dropped; the If-Match pre-check or the storage CAS is skipped; the
 * fresh read stops refreshing the cache or the head route reads the cache; a child
 * is refreshed although edited; a refreshed child loses its archived lifecycle.
 *
 * Every case seeds its own state, and the WBCD-2 case restores the tutorial child it
 * edits, so the file passes in any order (wave 60 shuffle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { readRegisteredWorkflowFresh, registerWorkflowIfUnchanged } from '../src/host/workflowsRegistry.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';

const TENANT = 'tenant-0770';
const TENANT_ENV_KEY = 'tenv0770-tenant-operator-key';
const EDITOR_SUBJECT = 'user:editor-0770';
const VIEWER_SUBJECT = 'user:viewer-0770';
const PERSONAL = 'user:solo-0770';
let EDITOR = '';
let VIEWER = '';
let PERSONAL_KEY = '';
const saved: Record<string, string | undefined> = {};
let BASE = '';
let server: http.Server;

interface WfNode { nodeId: string; name?: string; position?: { x: number; y: number } }
/** The workflow, list, head, from-chain and error bodies these cases read. */
interface WfBody {
  error?: string;
  details?: { reason?: string; requiredScope?: string };
  revision?: string;
  workflowId?: string;
  nodes?: WfNode[];
  metadata?: Record<string, unknown>;
  definition?: { nodes: WfNode[] };
  subChainWorkflowIds?: string[];
  reusedSubChainWorkflowIds?: string[];
  workflows?: Array<{ workflowId: string; archivedAt?: string }>;
}

async function call(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: WfBody; headers: Headers }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? TENANT_ENV_KEY}`, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: WfBody = {};
  try { json = JSON.parse(text) as WfBody; } catch { /* non-JSON body */ }
  return { status: res.status, json, headers: res.headers };
}
const host = (p: string) => `/host/openwop-app${p}`;

const def = (workflowId: string, over: { name?: string; x?: number } = {}) => ({
  workflowId,
  metadata: { name: 'Layout probe' },
  nodes: [
    { nodeId: 'a', typeId: 'core.noop', position: { x: over.x ?? 40, y: 80 }, ...(over.name ? { name: over.name } : {}) },
    { nodeId: 'b', typeId: 'core.noop', position: { x: 300, y: 80 } },
  ],
  edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
});

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${TENANT_ENV_KEY}:${TENANT}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await createOrg({ tenantId: TENANT, orgId: TENANT, name: 'Root', createdBy: 'test' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: EDITOR_SUBJECT, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: VIEWER_SUBJECT, displayName: 'Viewer', roles: ['viewer'] });
  EDITOR = (await issueApiKey({ tenantId: TENANT, name: 'editor', createdBy: EDITOR_SUBJECT })).token;
  VIEWER = (await issueApiKey({ tenantId: TENANT, name: 'viewer', createdBy: VIEWER_SUBJECT })).token;
  PERSONAL_KEY = (await issueApiKey({ tenantId: PERSONAL, name: 'solo', createdBy: 'user:solo-subject-0770' })).token;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0770 D1 — workflow writes require workspace:write', () => {
  it('a viewer is refused every write verb with forbidden_scope, before any id lookup', async () => {
    const id = 'wf.adr0770.owned-by-editor';
    expect((await call('POST', host('/workflows'), { key: EDITOR, body: def(id) })).status).toBe(201);
    const refused = [
      await call('POST', host('/workflows'), { key: VIEWER, body: def(id) }),
      await call('DELETE', host(`/workflows/${id}`), { key: VIEWER }),
      await call('POST', host(`/workflows/${id}/archive`), { key: VIEWER }),
      await call('POST', host(`/workflows/${id}/promote`), { key: VIEWER }),
      await call('POST', host(`/workflows/${id}/rollback`), { key: VIEWER, body: { revisionHash: 'x' } }),
      await call('POST', host('/workflows/from-chain'), { key: VIEWER, body: { chainId: 'market-intel.digest', params: { topic: 't' } } }),
      // an id that does not exist is refused the SAME way — no existence oracle
      await call('DELETE', host('/workflows/wf.adr0770.never-existed'), { key: VIEWER }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('forbidden_scope');
      expect(r.json.details?.requiredScope).toBe('workspace:write');
    }
    // …and the viewer can still READ.
    expect((await call('GET', host('/workflows'), { key: VIEWER })).status).toBe(200);
  });

  it('an editor, a tenant-pinned env key and an owk_ key in its issuer\'s personal workspace may write', async () => {
    expect((await call('POST', host('/workflows'), { key: EDITOR, body: def('wf.adr0770.editor') })).status).toBe(201);
    expect((await call('POST', host('/workflows'), { body: def('wf.adr0770.envkey') })).status).toBe(201);
    expect((await call('POST', host('/workflows'), { key: PERSONAL_KEY, body: def('wf.adr0770.personal') })).status).toBe(201);
    // …and each write landed: the writer reads it back.
    expect((await call('GET', `/workflows/wf.adr0770.editor`, { key: EDITOR })).json.workflowId).toBe('wf.adr0770.editor');
    expect((await call('GET', `/workflows/wf.adr0770.envkey`)).json.workflowId).toBe('wf.adr0770.envkey');
    expect((await call('GET', `/workflows/wf.adr0770.personal`, { key: PERSONAL_KEY })).json.workflowId).toBe('wf.adr0770.personal');
  });
});

describe('ADR 0770 D4 — node name + position round-trip; a drag is not an edit', () => {
  it('persists both fields, and only a rename moves the revision', async () => {
    const id = 'wf.adr0770.layout';
    const first = await call('POST', host('/workflows'), { body: def(id, { name: 'Fetch the brief' }) });
    expect(first.status).toBe(201);
    const got = await call('GET', `/workflows/${id}`);
    const nodeA = got.json.nodes?.find((n) => n.nodeId === 'a');
    expect(nodeA?.position).toEqual({ x: 40, y: 80 });
    expect(nodeA?.name).toBe('Fetch the brief');

    const moved = await call('POST', host('/workflows'), { body: def(id, { name: 'Fetch the brief', x: 999 }) });
    expect(moved.json.revision, 'a drag must not mint a new revision').toBe(first.json.revision);
    const renamed = await call('POST', host('/workflows'), { body: def(id, { name: 'Fetch the draft', x: 999 }) });
    expect(renamed.json.revision, 'a rename IS a content change').not.toBe(first.json.revision);
  });

  it('refuses a malformed position', async () => {
    const bad = def('wf.adr0770.bad-position');
    (bad.nodes[0] as Record<string, unknown>).position = { x: 'left', y: 1 };
    expect((await call('POST', host('/workflows'), { body: bad })).status).toBe(400);
  });
});

describe('ADR 0770 D5 — If-Match save precondition', () => {
  it('a stale base is a typed 409; the fresh head read and the 201 carry the next base', async () => {
    const id = 'wf.adr0770.cas';
    const v1 = await call('POST', host('/workflows'), { body: def(id) });
    expect(v1.status).toBe(201);
    expect(v1.headers.get('etag')).toBe(`"${v1.json.revision}"`);
    const head = await call('GET', host(`/workflows/${id}/head`));
    expect(head.json.revision).toBe(v1.json.revision);

    // Tab B saves a rename with the right base…
    const v2 = await call('POST', host('/workflows'), { body: def(id, { name: 'Tab B' }), headers: { 'if-match': `"${v1.json.revision}"` } });
    expect(v2.status).toBe(201);
    // …so tab A, still on v1, is refused instead of silently overwriting B.
    const stale = await call('POST', host('/workflows'), { body: def(id, { name: 'Tab A' }), headers: { 'if-match': `"${v1.json.revision}"` } });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('conflict');
    expect(stale.json.details?.reason).toBe('workflow_head_moved');
    // The current head rides the ETag, not the envelope: error details are
    // entropy-scrubbed (`sanitizeDetails`), which would redact a 64-hex hash.
    expect(stale.headers.get('etag')).toBe(`"${v2.json.revision}"`);
    const after = await call('GET', `/workflows/${id}`);
    expect(after.json.nodes?.find((n) => n.nodeId === 'a')?.name).toBe('Tab B');

    // The window the pre-read cannot see: two writers that both read the same head.
    // Sequential here (not a forced race): the second swap carries a stale raw and loses.
    const { raw, def: stored } = await readRegisteredWorkflowFresh(id);
    const a = await registerWorkflowIfUnchanged({ ...stored!, metadata: { name: "racer A" } }, raw);
    const b = await registerWorkflowIfUnchanged({ ...stored!, metadata: { name: "racer B" } }, raw);
    expect([a, b]).toEqual([true, false]);

    // No header ⇒ today's last-writer-wins (every other lane is unchanged).
    expect((await call('POST', host('/workflows'), { body: def(id, { name: 'Keep mine' }) })).status).toBe(201);
  });
});

describe('ADR 0770 D5 — the head read is one FRESH read (grade-code WBCD-1)', () => {
  it('serves the stored definition + its revision together, and refreshes a stale instance cache', async () => {
    const id = 'wf.adr0770.stale-cache';
    const v1 = await call('POST', host('/workflows'), { body: def(id, { name: 'v1 on this instance' }) });
    expect(v1.status).toBe(201);
    // Another instance saved v2: storage moved, THIS instance's cache did not.
    const stored = JSON.parse((await tryDurableStorage()!.kvGet(`wfreg:${id}`))!) as { nodes: WfNode[] };
    stored.nodes[0]!.name = 'v2 from another instance';
    await tryDurableStorage()!.kvSet(`wfreg:${id}`, JSON.stringify(stored));
    expect((await call('GET', `/workflows/${id}`)).json.nodes?.[0]?.name, 'fixture: the cache really is stale').toBe('v1 on this instance');

    const head = await call('GET', host(`/workflows/${id}/head`));
    expect(head.json.definition?.nodes[0]?.name).toBe('v2 from another instance');
    expect(head.json.revision).not.toBe(v1.json.revision);
    // …and the by-id read on this instance now agrees with it.
    expect((await call('GET', `/workflows/${id}`)).json.nodes?.[0]?.name).toBe('v2 from another instance');
    // A save built on the stale v1 canvas with the v1 base is refused, not waved through.
    const stale = await call('POST', host('/workflows'), { body: def(id, { name: 'stale edit' }), headers: { 'if-match': `"${v1.json.revision}"` } });
    expect(stale.status).toBe(409);
  });
});

describe('ADR 0770 D3 — re-instantiating a sub-chain template never overwrites an edited child', () => {
  it('reuses the edited child, refreshes the pristine ones, and keeps an archived child archived', async () => {
    const first = await call('POST', host('/workflows/from-chain'), { body: { chainId: 'tutorial.connect-your-ai' } });
    expect(first.status).toBe(201);
    const children: string[] = first.json.subChainWorkflowIds ?? [];
    expect(children.length).toBeGreaterThanOrEqual(2);
    const [edited, archived] = children as [string, string];

    // A second instantiation over pristine children refreshes them — nothing reused.
    const second = await call('POST', host('/workflows/from-chain'), { body: { chainId: 'tutorial.connect-your-ai' } });
    expect(second.status).toBe(201);
    expect(second.json.reusedSubChainWorkflowIds).toBeUndefined();

    // The user edits one child in the builder, and archives another.
    const childDef = (await call('GET', `/workflows/${edited}`)).json;
    const renamed = { ...childDef, metadata: { ...(childDef.metadata ?? {}), name: 'My phase, my edits' } };
    expect((await call('POST', host('/workflows'), { body: renamed })).status).toBe(201);
    expect((await call('POST', host(`/workflows/${archived}/archive`))).status).toBe(200);

    const third = await call('POST', host('/workflows/from-chain'), { body: { chainId: 'tutorial.connect-your-ai' } });
    expect(third.status).toBe(201);
    expect(third.json.subChainWorkflowIds, 'the parent still binds the same convergent ids').toEqual(children);
    expect(third.json.reusedSubChainWorkflowIds).toEqual([edited]);
    const after = (await call('GET', `/workflows/${edited}`)).json;
    expect(after.metadata?.name, 'the edit survived the re-instantiation').toBe('My phase, my edits');

    const list = (await call('GET', host('/workflows?includeArchived=true'))).json.workflows ?? [];
    expect(list.find((w) => w.workflowId === archived)?.archivedAt, 'a refreshed child keeps its lifecycle').toBeTruthy();
  });
});

// Restores the child it edits (in `finally`), so the pristine-refresh case above
// sees untouched children whichever order the two run in.
describe('ADR 0770 D3 — a child edited on ANOTHER instance is reused, not refreshed (grade-code WBCD-2)', () => {
  it('decides from fresh storage, not this instance\'s stale pristine cache', async () => {
    const first = await call('POST', host('/workflows/from-chain'), { body: { chainId: 'tutorial.connect-your-ai' } });
    expect(first.status).toBe(201);
    // The LAST child: the earlier D3 case edited the first and archived the
    // second, so this one is still pristine — the precondition this case needs.
    const ids = first.json.subChainWorkflowIds ?? [];
    const child = ids[ids.length - 1]!;
    expect(ids.length, 'fixture: a third, untouched child exists').toBeGreaterThanOrEqual(3);
    expect(first.json.reusedSubChainWorkflowIds ?? [], 'fixture: the child is pristine before the remote edit').not.toContain(child);
    // Another instance saved an edit to the child: storage moved, this
    // instance's cache still holds the pristine mint (exactly what the old
    // cache-based "pristine" decision read).
    const pristineRaw = (await tryDurableStorage()!.kvGet(`wfreg:${child}`))!;
    const stored = JSON.parse(pristineRaw) as { metadata?: Record<string, unknown> };
    stored.metadata = { ...(stored.metadata ?? {}), name: 'Edited on instance B' };
    await tryDurableStorage()!.kvSet(`wfreg:${child}`, JSON.stringify(stored));
    try {
      const again = await call('POST', host('/workflows/from-chain'), { body: { chainId: 'tutorial.connect-your-ai' } });
      expect(again.status).toBe(201);
      expect(again.json.reusedSubChainWorkflowIds).toContain(child);
      const after = JSON.parse((await tryDurableStorage()!.kvGet(`wfreg:${child}`))!) as { metadata?: Record<string, unknown> };
      expect(after.metadata?.name, 'the other instance\'s edit survived').toBe('Edited on instance B');
    } finally {
      // Put the pristine mint back, and refresh this instance's cache from it.
      await tryDurableStorage()!.kvSet(`wfreg:${child}`, pristineRaw);
      await readRegisteredWorkflowFresh(child);
    }
  });
});
