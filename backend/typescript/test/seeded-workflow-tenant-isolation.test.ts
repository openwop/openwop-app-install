/**
 * ADR 0789 — seeded workflows are ONE global definition shared by every seeded
 * tenant (`wf.seed.*` — `host/seedWorkflows.ts`; `openwop-app.authored.*` —
 * `host/workflowAuthorSeed.ts`; two demo walkthroughs — `host/demoWalkthroughsSeed.ts`).
 * Only OWNERSHIP is per tenant. So any write a tenant makes to "its" seeded
 * workflow must never reach the shared row: otherwise one tenant's builder save
 * changes the steps every other seeded tenant runs, with that tenant's own keys.
 *
 * Route-level, two real tenant sessions: the authorization boundary is only
 * observable through the HTTP surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import type { RunRecord } from '../src/types.js';
import { getSetCookies } from './headerCookies.js';
import { seedZeroConfigWorkflows, retractInternalSeedOwnership, seedWorkflowId } from '../src/host/seedWorkflows.js';
import { seedWorkflowAuthorShowcase, WORKFLOW_AUTHOR_SHOWCASE } from '../src/host/workflowAuthorSeed.js';
import { seedDemoWalkthroughs, DEMO_WALKTHROUGHS } from '../src/host/demoWalkthroughsSeed.js';
import { listOwned, getOwned, recordOwnership, isSharedWorkflowId, setPublishedRevision, purgeTenantOwnedWorkflowDefs } from '../src/host/workflowOwnership.js';
import { putWorkflowBudget, getWorkflowBudget } from '../src/host/workflowBudgets.js';
import { putDebugPin, listDebugPins } from '../src/host/workflowDebugPins.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { listRevisions, recordRevision, getRevision } from '../src/host/workflowRevisions.js';
import { registerJob, listJobs } from '../src/host/schedulingService.js';
import { createBoard, createCard, listCards } from '../src/host/kanbanService.js';
import { createRosterEntry, getRosterEntry } from '../src/host/rosterService.js';
import { workflowForkHookIds, getRegisteredWorkflowAsync, registerWorkflowDurable, onWorkflowForked, deleteRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { listChains, expandChain } from '../src/host/workflowChainPackLoader.js';

type Json = Record<string, unknown>;
interface Node { nodeId: string; typeId: string; config?: Json }

describe('ADR 0789 — a tenant write never reaches a shared (seeded) definition', () => {
  let server: http.Server;
  let BASE: string;

  const cookies = new WeakMap<object, () => string>();
  async function cookieOf(c: ReturnType<typeof client>): Promise<string> { return cookies.get(c)!(); }
  function client() {
    let cookie = '';
    const fn = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers) as string[]) {
        const m = /(__session=[^;]+)/.exec(ck);
        if (m) cookie = m[1];
      }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as Json | undefined };
    };
    cookies.set(fn, () => cookie);
    return fn;
  }

  let alice: ReturnType<typeof client>;
  let bob: ReturnType<typeof client>;
  const A = 'org:seed-alice';
  const B = 'org:seed-bob';
  /** Distinct seeded ids both tenants own, one per destructive leg. */
  let ids: string[] = [];

  const markerOf = (def: Json | undefined): unknown =>
    (def?.nodes as Node[] | undefined)?.map((n) => n.config?.injected).find((v) => v !== undefined);

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    alice = client();
    bob = client();
    expect((await alice('POST', '/host/openwop-app/test/login', { email: 'alice@seed.test', tenantId: A })).status).toBe(201);
    expect((await bob('POST', '/host/openwop-app/test/login', { email: 'bob@seed.test', tenantId: B })).status).toBe(201);
    for (const t of [A, B]) {
      await seedZeroConfigWorkflows(t);
      await seedWorkflowAuthorShowcase(t);
      await seedDemoWalkthroughs(t);
    }
    const aIds = new Set((await listOwned(A)).map((r) => r.workflowId));
    ids = (await listOwned(B)).map((r) => r.workflowId).filter((id) => id.startsWith('wf.seed.') && aIds.has(id)).sort();
    expect(ids.length, 'both tenants must share ≥15 seeded ids for this test to mean anything').toBeGreaterThanOrEqual(15);
  }, 60_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  /** Alice edits her seeded copy exactly the way the builder autosave does. */
  async function aliceSaves(id: string, marker: string) {
    const got = await alice('GET', `/workflows/${id}`);
    expect(got.status).toBe(200);
    const def = got.body as Json;
    const nodes = (def.nodes as Node[]).map((n, i) => (i === 0 ? { ...n, config: { ...(n.config ?? {}), injected: marker } } : n));
    return alice('POST', '/host/openwop-app/workflows', { ...def, nodes });
  }

  it('every seeder\'s ids are SHARED ids — a new seeder cannot drift out of the predicate', () => {
    for (const { chain } of listChains()) expect(isSharedWorkflowId(seedWorkflowId(chain.chainId))).toBe(true);
    for (const s of WORKFLOW_AUTHOR_SHOWCASE) expect(isSharedWorkflowId(s.definition.workflowId), s.definition.workflowId).toBe(true);
    for (const d of DEMO_WALKTHROUGHS) expect(isSharedWorkflowId(d.workflowId), d.workflowId).toBe(true);
    // A tenant's own recorded tour is NOT shared (one owner, random id).
    expect(isSharedWorkflowId('walkthrough.authored.0f3a')).toBe(false);
  });

  it('a builder save of a seeded workflow does NOT change what another seeded tenant reads', async () => {
    const id = ids[0]!;
    const save = await aliceSaves(id, 'ALICE-EDIT');
    expect(save.status).toBe(201);
    const bobRead = await bob('GET', `/workflows/${id}`);
    expect(bobRead.status).toBe(200);
    expect(markerOf(bobRead.body), 'Alice\'s save leaked into the definition Bob runs').toBeUndefined();
  });

  it('the save forks Alice onto her OWN id: recorded ownership, listed, hers alone, and editable in place', async () => {
    const id = ids[1]!;
    const save = await aliceSaves(id, 'ALICE-FORK');
    expect(save.status).toBe(201);
    const forkId = save.body?.workflowId as string;
    expect(forkId).not.toBe(id);
    expect(isSharedWorkflowId(forkId)).toBe(false);
    expect(save.body?.forkedFrom).toBe(id);
    expect(markerOf((await alice('GET', `/workflows/${forkId}`)).body)).toBe('ALICE-FORK');
    // ce requirement 1 — through recordOwnership, so /builder + the `/` picker list it.
    expect((await getOwned(A, forkId))?.forkedFrom).toBe(id);
    const list = await alice('GET', '/host/openwop-app/workflows');
    const listed = (list.body?.workflows as Array<{ workflowId: string }>).map((w) => w.workflowId);
    expect(listed).toContain(forkId);
    expect(listed, 'no "X" beside the edited "X"').not.toContain(id);
    expect(await getOwned(A, id)).toBeNull();
    // Hers alone.
    expect((await bob('GET', `/workflows/${forkId}`)).status).toBe(404);
    // The next autosave on the fork is an ordinary self-overwrite (same id back).
    const again = await alice('POST', '/host/openwop-app/workflows', (await alice('GET', `/workflows/${forkId}`)).body);
    expect(again.status).toBe(201);
    expect(again.body?.workflowId).toBe(forkId);
    // Bob still owns and runs the pristine shared one.
    expect(await getOwned(B, id)).not.toBeNull();
    expect(markerOf((await bob('GET', `/workflows/${id}`)).body)).toBeUndefined();
    // And a re-seed does not hand Alice the shared copy back.
    await seedZeroConfigWorkflows(A);
    expect(await getOwned(A, id)).toBeNull();
  });

  it('an UNCHANGED save (a Run re-registering an untouched seeded workflow) is a same-id no-op — no fork', async () => {
    const id = ids[2]!;
    const def = (await alice('GET', `/workflows/${id}`)).body;
    const save = await alice('POST', '/host/openwop-app/workflows', def);
    expect(save.status).toBe(201);
    expect(save.body?.workflowId).toBe(id);
    expect(save.body?.forkedFrom).toBeUndefined();
    expect(await getOwned(A, id)).not.toBeNull();
  });

  it('DELETE drops only the caller\'s ownership — the shared definition AND its revisions survive', async () => {
    const id = ids[3]!;
    const revsBefore = (await listRevisions(id)).length;
    const del = await alice('DELETE', `/host/openwop-app/workflows/${id}`);
    expect(del.status).toBe(200);
    expect(await getOwned(A, id)).toBeNull();
    expect((await bob('GET', `/workflows/${id}`)).status, 'Alice\'s delete removed the definition Bob runs').toBe(200);
    // Give a fire-and-forget deletion cascade the chance to run before asserting it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect((await listRevisions(id)).length, 'the delete cascaded away every tenant\'s revision history').toBe(revsBefore);
  });

  it('archive is per-tenant — it never archives the shared definition', async () => {
    const id = ids[4]!;
    expect((await alice('POST', `/host/openwop-app/workflows/${id}/archive`)).status).toBe(200);
    expect((await getOwned(A, id))?.archivedAt).toBeTruthy();
    const lc = ((((await bob('GET', `/workflows/${id}`)).body?.metadata) as Json | undefined)?.lifecycle as Json | undefined);
    expect(lc?.archivedAt, 'Alice\'s archive rewrote the shared definition\'s lifecycle').toBeUndefined();
    expect((await getOwned(B, id))?.archivedAt).toBeUndefined();
    expect((await alice('POST', `/host/openwop-app/workflows/${id}/unarchive`)).status).toBe(200);
    expect((await getOwned(A, id))?.archivedAt).toBeUndefined();
  });

  it('PROMOTE of an archived seeded workflow keeps THIS tenant\'s archive (it never rebuilds from the shared row)', async () => {
    const id = ids[14]!;
    const now = new Date().toISOString();
    await tryDurableStorage()!.insertRun({
      runId: 'run-seeded-promote', workflowId: id, tenantId: A, status: 'completed',
      inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    } as RunRecord);
    expect((await alice('POST', `/host/openwop-app/workflows/${id}/archive`)).status).toBe(200);
    const promote = await alice('POST', `/host/openwop-app/workflows/${id}/promote`);
    expect(promote.status).toBe(200);
    expect((await getOwned(A, id))?.archivedAt, 'promote silently un-archived this tenant\'s copy').toBeTruthy();
    const lc = ((((await bob('GET', `/workflows/${id}`)).body?.metadata) as Json | undefined)?.lifecycle as Json | undefined);
    expect(lc?.archivedAt).toBeUndefined();
  });

  it('rollback of a seeded workflow forks — it never re-heads the shared definition', async () => {
    const id = ids[5]!;
    const shared = (await getRegisteredWorkflowAsync(id))!;
    // A revision Alice authored of this id (the pre-ADR-0789 world let her save one).
    const edited = { ...shared, nodes: shared.nodes.map((n, i) => (i === 0 ? { ...n, config: { ...(n.config ?? {}), injected: 'ALICE-OLD' } } : n)) };
    const hash = await recordRevision(A, edited, { createdBy: 'alice' });
    expect(hash).toBeTruthy();
    const rb = await alice('POST', `/host/openwop-app/workflows/${id}/rollback`, { revisionHash: hash });
    expect(rb.status).toBe(200);
    expect(rb.body?.workflowId).not.toBe(id);
    expect(rb.body?.forkedFrom).toBe(id);
    expect(markerOf((await bob('GET', `/workflows/${id}`)).body)).toBeUndefined();
  });

  it('ce requirement 2 — this tenant\'s schedule, card, lane trigger and roster portfolio follow the fork; the other tenant\'s do not', async () => {
    const id = ids[6]!;
    for (const [t, jobId] of [[A, 'job-alice'], [B, 'job-bob']] as const) {
      const r = await registerJob({ jobId, tenantId: t, cronExpr: '0 * * * *', workflowId: id, timezone: 'UTC' });
      expect(r.ok).toBe(true);
    }
    const board = await createBoard({ tenantId: A, name: 'Alice board', triggerWorkflowId: id } as never);
    const card = await createCard({ boardId: board.id, columnId: board.columns[0]!.id, title: 'c', workflowId: id } as never);
    const bobBoard = await createBoard({ tenantId: B, name: 'Bob board' } as never);
    const bobCard = await createCard({ boardId: bobBoard.id, columnId: bobBoard.columns[0]!.id, title: 'c', workflowId: id } as never);
    await createRosterEntry({ tenantId: A, persona: 'Forky', agentRef: { agentId: 'a.b.c.d' }, workflows: [id, 'other'] });

    const save = await aliceSaves(id, 'ALICE-REPOINT');
    const forkId = save.body?.workflowId as string;
    expect(forkId).not.toBe(id);
    expect(save.body?.repointFailed).toBeUndefined();

    const jobs = [...(await listJobs(A)), ...(await listJobs(B))];
    expect(jobs.find((j) => j.jobId === 'job-alice')?.workflowId).toBe(forkId);
    expect(jobs.find((j) => j.jobId === 'job-bob')?.workflowId, 'a fork re-pointed ANOTHER tenant\'s schedule').toBe(id);
    expect((await listCards(board.id)).find((c) => c.id === card.id)?.workflowId).toBe(forkId);
    expect((await listCards(bobBoard.id)).find((c) => c.id === bobCard.id)?.workflowId).toBe(id);
    const { listBoards } = await import('../src/host/kanbanService.js');
    const aliceBoard = (await listBoards(A)).find((b) => b.id === board.id)!;
    expect(aliceBoard.columns.some((c) => c.triggerWorkflowId === forkId)).toBe(true);
    expect(aliceBoard.columns.some((c) => c.triggerWorkflowId === id)).toBe(false);
    expect((await getRosterEntry(A, 'host:forky'))?.workflows).toEqual([forkId, 'other']);
  });

  it('every store that holds a live per-tenant workflow reference registers a fork hook', () => {
    expect(workflowForkHookIds().sort()).toEqual([
      'connections:inbound', 'host-event:binding', 'kanban', 'messaging:routing-rule', 'profiles:profile',
      'projects', 'roster', 'schedchat:config', 'scheduler:job', 'trigger-bridge:subscription',
      'workflow:budget', 'workflow:debug-pin', 'workflow:eval-set',
    ].sort());
  });

  it('PARTIAL FAILURE — one fork hook throwing mid-fork: the save still returns the fork, the other hooks still ran, the failure is NAMED', async () => {
    // The deliberate answer (ADR 0789 § Partial failure): the fork is already
    // durable and owned when the hooks run, so the save succeeds with the fork's
    // id and `repointFailed` names the hook that threw. Every other hook still
    // runs (per-hook isolation), and the caller's shared ownership is still
    // dropped — keeping it would make the NEXT save fork a second copy. A
    // reference the failed hook missed stays on the shared id, which is unchanged
    // and still resolves: stale, never unsafe.
    let boomCalls = 0;
    onWorkflowForked('test:boom', async () => { boomCalls += 1; if (boomCalls === 1) throw new Error('boom'); return 0; });
    const id = ids[7]!;
    await registerJob({ jobId: 'job-alice-partial', tenantId: A, cronExpr: '0 * * * *', workflowId: id, timezone: 'UTC' });
    const save = await aliceSaves(id, 'ALICE-PARTIAL');
    expect(save.status).toBe(201);
    const forkId = save.body?.workflowId as string;
    expect(forkId).not.toBe(id);
    expect(save.body?.repointFailed).toEqual(['test:boom']);
    expect((await listJobs(A)).find((j) => j.jobId === 'job-alice-partial')?.workflowId, 'a later hook was skipped after one threw').toBe(forkId);
    expect((await getOwned(A, forkId))?.forkedFrom).toBe(id);
    expect(await getOwned(A, id)).toBeNull();
    expect(markerOf((await bob('GET', `/workflows/${id}`)).body)).toBeUndefined();
    // The failure is PERSISTED on the fork, not only logged — and the fork's next
    // save re-runs exactly the owed hook, clearing it once it succeeds.
    expect((await getOwned(A, forkId))?.repointPending).toEqual(['test:boom']);
    const next = await alice('POST', '/host/openwop-app/workflows', (await alice('GET', `/workflows/${forkId}`)).body);
    expect(next.status).toBe(201);
    expect(next.body?.repointFailed).toBeUndefined();
    expect(boomCalls).toBe(2);
    expect((await getOwned(A, forkId))?.repointPending).toBeUndefined();
  });

  it('the showcase ids (openwop-app.authored.*) and seeded walkthroughs get the same protection', async () => {
    for (const id of ['openwop-app.authored.lead-triage', DEMO_WALKTHROUGHS[0]!.workflowId]) {
      expect(await getOwned(A, id), id).not.toBeNull();
      const save = await aliceSaves(id, 'ALICE-SHOWCASE');
      expect(save.status).toBe(201);
      expect(save.body?.workflowId).not.toBe(id);
      expect(markerOf((await bob('GET', `/workflows/${id}`)).body), id).toBeUndefined();
    }
  });

  it('a tenant cannot PRE-SQUAT a shared-namespace id the seeder has not minted yet', async () => {
    const squat = await alice('POST', '/host/openwop-app/workflows', {
      workflowId: 'wf.seed.not-yet-shipped-chain',
      metadata: { name: 'squat' },
      nodes: [{ nodeId: 'a', typeId: 'core.noop', config: { injected: 'SQUAT' } }],
      edges: [],
    });
    expect(squat.status).toBe(404);
    expect(await getRegisteredWorkflowAsync('wf.seed.not-yet-shipped-chain')).toBeNull();
  });

  it('a non-owner of a seeded id still gets the indistinguishable 404 on write', async () => {
    const id = ids[8]!;
    const C = 'org:seed-carol';
    const carol = client();
    expect((await carol('POST', '/host/openwop-app/test/login', { email: 'carol@seed.test', tenantId: C })).status).toBe(201);
    const def = (await bob('GET', `/workflows/${id}`)).body;
    expect((await carol('POST', '/host/openwop-app/workflows', def)).status).toBe(404);
  });

  it('a tenant\'s own recorded / authored tours are NOT shared — the recorder\'s first save is an ordinary create', async () => {
    const recorded = 'walkthrough.recorded.my-tour.1a2b3c4d';
    expect(isSharedWorkflowId(recorded)).toBe(false);
    const res = await alice('POST', '/host/openwop-app/workflows', {
      workflowId: recorded, metadata: { name: 'my tour' },
      nodes: [{ nodeId: 'a', typeId: 'core.noop', config: {} }], edges: [],
    });
    expect(res.status).toBe(201);
    expect(res.body?.workflowId).toBe(recorded);
  });

  it('a builder save marked PRISTINE is a same-id no-op even though the serializer dropped defaults', async () => {
    const id = ids[9]!;
    const got = (await alice('GET', `/workflows/${id}`)).body as Json;
    // What the builder sends for an untouched canvas: default trigger rules and
    // empty configs dropped (serialize.ts) — NOT hash-equal to the stored row.
    const builderShaped = {
      ...got,
      nodes: (got.nodes as Node[]).map(({ config, ...n }) => (config && Object.keys(config).length > 0 ? { ...n, config } : n)),
      edges: ((got.edges ?? []) as Json[]).map(({ triggerRule, ...e }) => (triggerRule && triggerRule !== 'all_success' ? { ...e, triggerRule } : e)),
    };
    const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwop-canvas-pristine': '1', cookie: await cookieOf(alice) },
      body: JSON.stringify(builderShaped),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Json).workflowId).toBe(id);
    expect(await getOwned(A, id)).not.toBeNull();
    // And the marker can only SUPPRESS a write: a lying client's edit is simply not saved.
    const lie = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwop-canvas-pristine': '1', cookie: await cookieOf(alice) },
      body: JSON.stringify({ ...got, nodes: (got.nodes as Node[]).map((n, i) => (i === 0 ? { ...n, config: { ...(n.config ?? {}), injected: 'LIE' } } : n)) }),
    });
    expect(((await lie.json()) as Json).workflowId).toBe(id);
    expect(markerOf((await bob('GET', `/workflows/${id}`)).body)).toBeUndefined();
  });

  it('two CONCURRENT first saves converge on ONE fork', async () => {
    const id = ids[10]!;
    const [a, b] = await Promise.all([aliceSaves(id, 'TAB-1'), aliceSaves(id, 'TAB-2')]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body?.workflowId).toBe(b.body?.workflowId);
    expect((await listOwned(A)).filter((r) => r.forkedFrom === id)).toHaveLength(1);
  });

  it('a stale canvas of the SHARED original cannot silently overwrite the fork (If-Match judged against the fork head)', async () => {
    const id = ids[1]!; // forked by Alice in the fork leg
    const sharedHead = revisionHashOf((await getRegisteredWorkflowAsync(id))!);
    const got = (await bob('GET', `/workflows/${id}`)).body as Json;
    const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${sharedHead}"`, cookie: await cookieOf(alice) },
      body: JSON.stringify({ ...got, nodes: (got.nodes as Node[]).map((n, i) => (i === 0 ? { ...n, config: { ...(n.config ?? {}), injected: 'STALE' } } : n)) }),
    });
    expect(res.status).toBe(409);
    const forkId = (await listOwned(A)).find((r) => r.forkedFrom === id)!.workflowId;
    expect(markerOf((await alice('GET', `/workflows/${forkId}`)).body)).toBe('ALICE-FORK');
  });

  it('a PUBLISHED seeded workflow keeps its published content pinned on the fork (production launches do not jump to the draft)', async () => {
    const id = ids[11]!;
    const shared = (await getRegisteredWorkflowAsync(id))!;
    const pubHash = revisionHashOf(shared);
    await recordRevision(A, shared);
    expect(await setPublishedRevision(A, id, pubHash)).toBe(true);
    const save = await aliceSaves(id, 'ALICE-DRAFT');
    const forkId = save.body?.workflowId as string;
    const pinned = (await getOwned(A, forkId))?.publishedRevision;
    expect(pinned).toBeTruthy();
    const rev = await getRevision(forkId, pinned!);
    expect(markerOf(rev?.definition as unknown as Json), 'the pin followed the draft edit').toBeUndefined();
  });

  it('budgets and debug pins MOVE with the fork (key-embedded stores)', async () => {
    const id = ids[12]!;
    const shared = (await getRegisteredWorkflowAsync(id))!;
    await putWorkflowBudget(A, id, { dailyUsd: 5, hardCap: true });
    await putDebugPin({ tenantId: A, workflowId: id, nodeId: shared.nodes[0]!.nodeId, output: { v: 1 } });
    await putWorkflowBudget(B, id, { dailyUsd: 9, hardCap: false });
    const forkId = (await aliceSaves(id, 'ALICE-MOVE')).body?.workflowId as string;
    expect((await getWorkflowBudget(A, forkId))?.dailyUsd).toBe(5);
    expect(await getWorkflowBudget(A, id)).toBeNull();
    expect((await listDebugPins(A, forkId)).map((p) => p.nodeId)).toEqual([shared.nodes[0]!.nodeId]);
    expect(await listDebugPins(A, id)).toEqual([]);
    expect((await getWorkflowBudget(B, id))?.dailyUsd, 'another tenant\'s budget moved').toBe(9);
  });

  it('rollback to content identical to the shared head is a no-op, not a fork', async () => {
    const id = ids[13]!;
    const shared = (await getRegisteredWorkflowAsync(id))!;
    const hash = await recordRevision(A, shared);
    const rb = await alice('POST', `/host/openwop-app/workflows/${id}/rollback`, { revisionHash: hash });
    expect(rb.status).toBe(200);
    expect(rb.body?.workflowId).toBe(id);
    expect(await getOwned(A, id)).not.toBeNull();
  });

  it('the LAST owner\'s teardown never deletes a shared definition or its history', async () => {
    const id = 'wf.seed.lonely-last-owner';
    const def = { workflowId: id, metadata: { name: 'lonely' }, nodes: [{ nodeId: 'a', typeId: 'core.noop', config: {} }], edges: [] };
    await registerWorkflowDurable(def as never);
    await recordRevision('org:lonely', def as never);
    await recordOwnership('org:lonely', id, { name: 'lonely', nodeCount: 1 });
    const r = await purgeTenantOwnedWorkflowDefs('org:lonely', deleteRegisteredWorkflow);
    expect(r.defsDeleted).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(await getRegisteredWorkflowAsync(id)).not.toBeNull();
    expect((await listRevisions(id)).length).toBeGreaterThan(0);
  });

  it('migration 22 retracts ownership of seeded copies of INTERNAL chains — keeping edited and scheduled ones', async () => {
    const internal = listChains().filter(({ chain }) => chain.internal === true
      && !(((chain.parameters as { required?: unknown[] }).required ?? []).length > 0));
    expect(internal.length, 'the ADR 0788 projection chains must be loaded for this leg to mean anything').toBeGreaterThan(0);
    const { chain } = internal[0]!;
    const id = seedWorkflowId(chain.chainId);
    // Recreate the pre-0788 state: the shared def + three tenants owning it.
    const expanded = expandChain(chain, { deferred: true });
    const name = (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim()) ? expanded.metadata.name : chain.label;
    const def = { ...expanded, workflowId: id, metadata: { ...expanded.metadata, name } };
    await registerWorkflowDurable(def);
    await recordRevision('org:r-plain', def);
    for (const t of ['org:r-plain', 'org:r-edited', 'org:r-sched']) await recordOwnership(t, id, { name: 'p', nodeCount: def.nodes.length });
    await recordRevision('org:r-edited', { ...def, metadata: { ...def.metadata, name: 'edited' } }, { createdBy: 'x' });
    await registerJob({ jobId: 'job-r-sched', tenantId: 'org:r-sched', cronExpr: '0 * * * *', workflowId: id, timezone: 'UTC' });

    const r = await retractInternalSeedOwnership();
    expect(r.internalSeedIds).toBeGreaterThan(0);
    expect(await getOwned('org:r-plain', id)).toBeNull();
    expect(await getOwned('org:r-edited', id)).not.toBeNull();
    expect(await getOwned('org:r-sched', id)).not.toBeNull();
    expect(r.failed).toBe(0);
    // Non-destructive: the definition and its history stay for replay.
    expect(await getRegisteredWorkflowAsync(id)).not.toBeNull();
    expect((await listRevisions(id)).length).toBeGreaterThan(0);
    // Idempotent.
    const again = await retractInternalSeedOwnership();
    expect(again.retracted).toBe(0);
  });
});
