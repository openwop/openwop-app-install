/**
 * ADR 0458 CRITICAL-3 — the Challenge Author's tools fail CLOSED without an
 * acting human holding KickTodo manage authority, through the SAME predicate the
 * authoring routes use (`hasKicktodoManageAuthority`). A participant who reaches
 * the agent cannot read the factory pipeline or drive the Factory.
 *
 *   - the READ tool fails EMPTY (no candidates) without authority;
 *   - the ACTION tool returns a typed error (`acting_user_required` /
 *     `forbidden`) without authority, and starts a run WITH it.
 *
 * NO NETWORK (w41 grade-tests ruling 5): a started factory run executes in the
 * background (`startWorkflowRun` → `setImmediate(executeRun)`) and its second node
 * (`core.web.search`) would egress through the SSRF-guarded undici dispatcher — NOT
 * the global `fetch`, so a `fetch` stub would not intercept it. MEASURED: this
 * harness registers no pack nodes, so every started run fails at `research-frame`
 * and never searches. As insurance the search endpoint is still pointed at a
 * LOOPBACK stub (`OPENWOP_WEBSEARCH_BASE_URL` + `OPENWOP_WEBHOOK_ALLOW_PRIVATE`)
 * that answers 503 (a durable search then refuses, ADR 0502, before any LLM node),
 * and the create-and-run case asserts the stub saw NO request. Every dispatching
 * case waits for its runs to settle (`settle`) so no run outlives its case.
 */
import { getDefaultModel, listSelectableProviderIds } from '../src/providers/catalog.js';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked } from '../src/features/index.js';
import { createCandidate, getCandidate, listCandidates } from '../src/features/kicktodo-creator/creatorService.js';
import { kicktodoCreatorBuiltinWorkflows } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import { runCandidatesTool, runFactoryRunTool, type ToolScope } from '../src/features/kicktodo-creator/agentTools.js';
import { createTurnRunDispatchCollector } from '../src/host/turnRunDispatch.js';
import { randomBytes } from 'node:crypto';
import { configureSecretResolver, setSecret, removeSecret, clearTenantSecretCache } from '../src/byok/secretResolver.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';
import { setHeadlessAiDefault, clearHeadlessAiDefault, resolveIgnitionAiBinding } from '../src/host/headlessAi.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
const dataDir = mkdtempSync(join(tmpdir(), 'openwop-kt-author-tools-'));
initInMemorySurfaces({ dataDir });
// ADR 0706 — the run tool pre-flights the AI credential through the REAL resolver
// (signed-in `user:` tenants store secrets KMS-wrapped; a local AES client stands in).
configureSecretResolver({ storage, dataDir });
const kmsClient = createLocalAesKmsClient(randomBytes(32), 'test/local-aes');
configureKmsClient(kmsClient);
const hostSuite = createHostAdapterSuite({ storage });
const deps = { storage, hostSuite };

// A MANAGER's own personal workspace (tenantId === subject ⇒ implicit owner).
const MGR = 'user:kt-manager';
// A participant in a SHARED tenant with no manage scope.
const SHARED = 'tenant-kt-shared';
const PARTICIPANT = 'user:kt-participant';

/** The loopback search stub: every request the factory's search node makes lands
 *  here (and nowhere else) and is refused with a 503. */
const searchHits: string[] = [];
let searchStub: http.Server;
const ENV_KEYS = ['OPENWOP_WEBSEARCH_API_KEY', 'OPENWOP_WEBSEARCH_BASE_URL', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

/** A tool result's JSON content as a plain record — no cast (w41 typing rule). */
function contentOf(r: { content: string }): Record<string, unknown> {
  const v: unknown = JSON.parse(r.content);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`tool content is not an object: ${r.content}`);
  return { ...v };
}
/** The object rows of an untyped array field. */
function rowsOf(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : [];
}

/** Runs this file started; each case drains its own before it ends. */
const started: string[] = [];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
async function settle(): Promise<void> {
  for (const runId of started.splice(0)) {
    await vi.waitFor(async () => {
      expect(TERMINAL.has((await storage.getRun(runId))?.status ?? '')).toBe(true);
    }, { timeout: 15_000, interval: 25 });
  }
}

beforeAll(async () => {
  // Boot parity (src/index.ts): the factory is registered CHAIN-BACKED — the
  // chain packs load through the real loader and the boot registrar binds the
  // same-id definitions. ADR 0706's run tool reads the chain's pinned
  // provider/model from that definition's `variables[]`, which the raw legacy
  // def this harness used to register never carried.
  searchStub = http.createServer((req, res) => {
    searchHits.push(req.url ?? '');
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"search stub refuses"}');
  });
  await new Promise<void>((resolve) => searchStub.listen(0, '127.0.0.1', () => resolve()));
  const addr = searchStub.address();
  process.env.OPENWOP_WEBSEARCH_BASE_URL = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/search`;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  registerLegacyDefsChainBacked(kicktodoCreatorBuiltinWorkflows);
  // The Factory refuses to start without a live search adapter (its dossier is
  // fail-closed on demo sources), so the dispatch cases need one configured.
  process.env.OPENWOP_WEBSEARCH_API_KEY = 'test-search-key';
  // ADR 0706 — and it refuses without a Secrets Vault key for the provider it
  // resolved (the host catalog default, `anthropic` here, no workspace default), so the
  // dispatch cases need that too. The 2026-07-29 run died at `extract-claims`
  // for exactly this; now it never starts.
  await setSecret('anthropic', 'test-anthropic-key', { tenantId: MGR });
});
afterEach(async () => { await settle(); });
afterAll(async () => {
  await settle();
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((resolve) => searchStub.close(() => resolve()));
});

describe('openwop:kicktodo.candidates (READ) — fail EMPTY without authority', () => {
  it('a system turn (no acting user) reads nothing', async () => {
    // The tenant MUST hold a candidate, or "reads nothing" holds with no guard at all.
    await createCandidate({ tenantId: MGR, createdBy: MGR, topic: 'System-turn control', audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 });
    const owner = contentOf(await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR }));
    expect(rowsOf(owner.candidates).map((c) => c.topic)).toContain('System-turn control'); // positive control
    const r = await runCandidatesTool({}, { tenantId: MGR });
    expect(contentOf(r)).toEqual({ candidates: [] });
  });

  it('a non-manage participant reads nothing', async () => {
    await createCandidate({ tenantId: SHARED, createdBy: 'user:owner', topic: 'Watercolor basics', audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 });
    const scope: ToolScope = { tenantId: SHARED, actingUserId: PARTICIPANT };
    const r = await runCandidatesTool({}, scope);
    expect(contentOf(r)).toEqual({ candidates: [] });
  });

  it('a manager reads their workspace candidates with stage + dossier state', async () => {
    const created = await createCandidate({ tenantId: MGR, createdBy: MGR, topic: 'Manager read', audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 });
    const r = await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR });
    const body = contentOf(r);
    // Found by id, not by position: other cases add MGR candidates in any order.
    expect(rowsOf(body.candidates).find((c) => c.id === created.id)).toEqual({
      id: created.id, topic: 'Manager read', audience: 'beginners',
      // XCH-CA-2 — the agreed intake is read back, so the agent never re-asks it.
      transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15,
      state: 'intake', riskTier: 'general',
      hasDossier: false, sourceCount: 0, unsupportedClaimIds: [],
    });
  });
});

describe('openwop:kicktodo.factory.run (ACTION) — typed error without authority', () => {
  it('no acting user ⇒ acting_user_required', async () => {
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics' }, { tenantId: MGR });
    expect(r.isError).toBe(true);
    expect(contentOf(r)).toMatchObject({ error: 'acting_user_required' });
  });

  it('a non-manage participant ⇒ forbidden', async () => {
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics' }, { tenantId: SHARED, actingUserId: PARTICIPANT });
    expect(r.isError).toBe(true);
    expect(contentOf(r)).toMatchObject({ error: 'forbidden' });
  });

  it('a manager can create-and-run: returns a runId + candidateId', async () => {
    const hitsBefore = searchHits.length;
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics', audience: 'beginners' }, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBeUndefined();
    const body = contentOf(r);
    const runId = String(body.runId);
    const candidateId = String(body.candidateId);
    started.push(runId);
    expect(candidateId).toMatch(/^cand:/);
    // The run and the candidate are REAL, persisted, and bound to each other.
    const rec = await storage.getRun(runId);
    expect(rec?.workflowId).toBe('openwop-app.kicktodo.challenge-factory');
    expect(rec?.inputs).toMatchObject({ candidateId, topic: 'Watercolor basics', audience: 'beginners', authorSubject: MGR });
    expect((await getCandidate(MGR, candidateId))?.topic).toBe('Watercolor basics');
    // …and it performs NO search egress. MEASURED (w41): this harness registers no
    // pack nodes, so the run fails at its first node (`research-frame`: node module
    // not registered) before `core.web.search`. Were that to change, the search
    // would land on the loopback stub (never the network) and this line goes red to
    // say the file now drives egress.
    await settle();
    expect((await storage.getRun(runId))?.status).toBe('failed');
    expect(searchHits.length).toBe(hitsBefore);
  });

  // KTFAC-1 — no per-CALL id reaches a tool, so the chat TURN's run id is the
  // stable key: a retried call in the same turn converges on ONE candidate (red
  // when the tool stops passing the run-keyed idempotency key). A new turn is a
  // new ask and mints fresh.
  it('a retried factory.run in the SAME turn reuses its candidate; a new turn does not', async () => {
    const scope = { tenantId: MGR, actingUserId: MGR, runId: 'turn-kt4b-1' };
    const input = { topic: 'Retry-safe sketching', audience: 'beginners' };
    const first = contentOf(await runFactoryRunTool(deps, input, scope));
    const retry = contentOf(await runFactoryRunTool(deps, input, scope));
    const nextTurn = contentOf(await runFactoryRunTool(deps, input, { ...scope, runId: 'turn-kt4b-2' }));
    started.push(String(first.runId), String(retry.runId), String(nextTurn.runId));
    expect(retry.candidateId).toBe(first.candidateId);
    expect(nextTurn.candidateId).not.toBe(first.candidateId);
    expect((await listCandidates(MGR)).filter((c) => c.topic === 'Retry-safe sketching')).toHaveLength(2);
  });

  // XCH-CA-1 / XCH-CA-2 — what the intake collects reaches the candidate, and the
  // cadence the creator chose reaches the run (it used to be dropped for
  // hard-coded defaults and an unset cadence).
  it('carries the intake (transformation, duration, daily minutes) to the candidate and the cadence to the run', async () => {
    const r = await runFactoryRunTool(deps, {
      topic: 'Watercolor basics', audience: 'beginners', transformation: 'Paint a finished landscape from a photo',
      durationDays: 21, dailyMinutes: 30, checkpointEvery: 'outline-only',
    }, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBeUndefined();
    const body = contentOf(r);
    started.push(String(body.runId));
    expect(body.checkpointEvery).toBe('outline-only');
    const cand = await getCandidate(MGR, String(body.candidateId));
    expect(cand).toMatchObject({ transformation: 'Paint a finished landscape from a photo', durationDaysTarget: 21, dailyMinutesTarget: 30 });
    expect((await storage.getRun(String(body.runId)))?.inputs).toMatchObject({ checkpointEvery: 'outline-only' });
  });

  it('out-of-bounds intake or an unknown cadence ⇒ validation_error, nothing created', async () => {
    const before = (await listCandidates(MGR)).length;
    for (const bad of [{ durationDays: 2 }, { durationDays: 61 }, { dailyMinutes: 4 }, { dailyMinutes: 12.5 }, { checkpointEvery: 'every-lesson' }]) {
      const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics', ...bad }, { tenantId: MGR, actingUserId: MGR });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(contentOf(r)).toMatchObject({ error: 'validation_error' });
    }
    expect((await listCandidates(MGR)).length).toBe(before);
  });

  it('neither a candidateId nor a topic ⇒ validation_error', async () => {
    const r = await runFactoryRunTool(deps, {}, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBe(true);
    expect(contentOf(r)).toMatchObject({ error: 'validation_error' });
  });

  // 2026-07-25 incident: the tool dispatched a REAL run, the agent narrated "the
  // run is active", and the chat rendered nothing — the run turn was written
  // out-of-band, after the exchange had already built its response. The tool now
  // RECORDS the dispatch on the turn scope so the exchange materializes the
  // bubble into that response. See host/turnRunDispatch.ts.
  it('records the ignited run on the turn scope so the exchange can render its bubble', async () => {
    const collector = createTurnRunDispatchCollector();
    const r = await runFactoryRunTool(
      deps,
      { topic: 'Sourdough from scratch', audience: 'busy parents' },
      { tenantId: MGR, actingUserId: MGR, conversationId: 'conv:kt-1', onRunDispatched: collector.sink },
    );
    expect(r.isError).toBeUndefined();
    const runId = String(contentOf(r).runId);
    started.push(runId);
    // The workflow identity rides the dispatch so the bubble/rail render a real
    // title instead of a blank header (code-review fix).
    expect(collector.drain()).toEqual([{
      runId,
      agentId: expect.any(String),
      workflowId: 'openwop-app.kicktodo.challenge-factory',
      workflowName: 'Challenge Factory',
    }]);
  });

  // The 2026-07-25 root cause: with no live search adapter every source is
  // `engine:'demo'`, which `recordDossier` refuses (StubSourceError) — so the run
  // was DOA. It burned a candidate, died a node in, and the agent narrated an
  // approval gate that could never arrive. The tool now refuses up front.
  it('no live search adapter ⇒ research_adapter_unconfigured, and NOTHING is started', async () => {
    const saved = process.env.OPENWOP_WEBSEARCH_API_KEY;
    delete process.env.OPENWOP_WEBSEARCH_API_KEY;
    try {
      const hitsBefore = searchHits.length;
      const before = rowsOf(contentOf(await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR })).candidates);
      const collector = createTurnRunDispatchCollector();
      const r = await runFactoryRunTool(
        deps,
        { topic: 'Ultramarathon base building', audience: 'runners' },
        { tenantId: MGR, actingUserId: MGR, conversationId: 'conv:kt-2', onRunDispatched: collector.sink },
      );
      expect(r.isError).toBe(true);
      expect(contentOf(r)).toMatchObject({ error: 'research_adapter_unconfigured' });
      // No run recorded, no search egress, and no candidate burned by the refused call.
      expect(collector.drain()).toEqual([]);
      expect(searchHits.length).toBe(hitsBefore);
      const after = rowsOf(contentOf(await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR })).candidates);
      expect(after.length).toBe(before.length);
    } finally {
      if (saved !== undefined) process.env.OPENWOP_WEBSEARCH_API_KEY = saved;
    }
  });

  it('dispatch OUTSIDE a conversation records nothing (no bubble to render)', async () => {
    const collector = createTurnRunDispatchCollector();
    const r = await runFactoryRunTool(
      deps,
      { topic: 'Trail running', audience: 'beginners' },
      { tenantId: MGR, actingUserId: MGR, onRunDispatched: collector.sink },
    );
    expect(r.isError).toBeUndefined();
    started.push(String(contentOf(r).runId));
    expect(collector.drain()).toEqual([]);
  });
});

// ── ADR 0706 — the factory runs on the workspace's chosen AI provider ──────────
//
// The run tool resolves creator choice → the ADR 0110 workspace default → the
// chain's pinned defaults, pre-flights the provider's `structured-output`
// capability and its Secrets Vault credential through the SAME ladder the
// dispatcher runs, and freezes what it resolved onto the run record: three run
// inputs (`provider`/`model`/`credentialRef`) plus the ref registered on
// `configurable.credentialRefs` (an input alone never reaches dispatch —
// host/runCredentials.ts). Every refusal is typed, creator-facing, and creates
// nothing. A separate personal workspace keeps this state out of the cases above.
describe('openwop:kicktodo.factory.run — ADR 0706 provider binding + pre-flight', () => {
  const T = 'user:kt-manager-0706';
  const scope: ToolScope = { tenantId: T, actingUserId: T };
  const candidateCount = async (): Promise<number> =>
    rowsOf(contentOf(await runCandidatesTool({}, scope)).candidates).length;
  const run = async (input: Record<string, unknown>) => {
    const collector = createTurnRunDispatchCollector();
    const r = await runFactoryRunTool(deps, input, { ...scope, conversationId: 'conv:kt-0706', onRunDispatched: collector.sink });
    const body = contentOf(r);
    if (typeof body.runId === 'string') started.push(body.runId);
    return { r, body, dispatched: collector.drain() };
  };

  beforeAll(async () => {
    // Two Google keys, so a first-prefixed-ref guess (`google:one`) is visibly
    // NOT the bound one (`google:two`) — ADR 0517's duplicate-keys case.
    await setSecret('google:one', 'gemini-key-one', { tenantId: T });
    await setSecret('google:two', 'gemini-key-two', { tenantId: T });
  });
  afterEach(async () => { await clearHeadlessAiDefault(T); });

  it('resolveIgnitionAiBinding: creator choice → workspace default → null, and the creator\'s model falls back to the catalog default', async () => {
    expect(await resolveIgnitionAiBinding(T)).toBeNull();
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' }, new Date().toISOString());
    expect(await resolveIgnitionAiBinding(T)).toEqual({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two', source: 'workspace-default' });
    // An explicit creator choice wins over the default; a missing model is filled
    // from the catalog, never left empty for the node to guess.
    const chosen = await resolveIgnitionAiBinding(T, { provider: 'openai' });
    expect(chosen).toMatchObject({ provider: 'openai', source: 'creator' });
    expect(chosen?.model.length).toBeGreaterThan(0);
    expect(chosen).not.toHaveProperty('credentialRef');
  });

  it('a Gemini workspace default resolves and is STAMPED on the run: inputs + configurable carry the BOUND ref, not the first prefixed one', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' }, new Date().toISOString());
    const { r, body, dispatched } = await run({ topic: 'Sourdough from scratch', audience: 'busy parents' });
    expect(r.isError, r.content).toBeUndefined();
    expect(body).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite' });
    expect(dispatched).toHaveLength(1);
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' });
    expect(rec?.configurable).toEqual({ credentialRefs: ['google:two'] });
  });

  it('a creator-named provider with NO ref pins the ladder\'s pick explicitly (the same rung the dispatcher would take)', async () => {
    const { r, body } = await run({ topic: 'Trail running', provider: 'google' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    // No exact `google` ref exists, so the prefix rung picks the FIRST in vault
    // order — and that pick is frozen on the run, so dispatch cannot re-pick.
    expect(rec?.inputs).toMatchObject({ provider: 'google', credentialRef: 'google:one' });
    expect(rec?.configurable).toEqual({ credentialRefs: ['google:one'] });
  });

  // ADR 0903 — the chain no longer pins a vendor; with no creator choice and no
  // ADR 0110 default the factory uses the host default (no chat binding here ⇒
  // the catalog's recommended provider + model, never a stale pack constant).
  it('no workspace default ⇒ the host catalog default (the chain pins none), with its vault key pinned', async () => {
    await setSecret('anthropic', 'test-anthropic-key', { tenantId: T });
    const { r, body } = await run({ topic: 'Watercolor basics' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    const first = listSelectableProviderIds()[0]!;
    expect(first, 'fixture guard: the catalog leads with the provider this case keys').toBe('anthropic');
    expect(rec?.inputs).toMatchObject({ provider: first, model: getDefaultModel(first), credentialRef: 'anthropic' });
    expect(rec?.configurable).toEqual({ credentialRefs: ['anthropic'] });
  });

  it('missing key for the resolved provider ⇒ ai_credential_missing BEFORE a candidate exists, nothing dispatched', async () => {
    const before = await candidateCount();
    const { r, body, dispatched } = await run({ topic: 'Ultramarathon base building', provider: 'openai' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_credential_missing', provider: 'openai', reason: 'no_default_credential' });
    expect(String(body.message)).toContain('Nothing was created');
    expect(dispatched).toEqual([]);
    expect(await candidateCount()).toBe(before);
  });

  it('an explicitly named ref that is not in the vault ⇒ ai_credential_missing (explicit_ref_unresolved) — never a fall-through to a guessed key', async () => {
    const before = await candidateCount();
    const { r, body } = await run({ topic: 'Ultramarathon base building', provider: 'google', credentialRef: 'google:gone' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_credential_missing', provider: 'google', reason: 'explicit_ref_unresolved' });
    expect(await candidateCount()).toBe(before);
  });

  // Review of #3889 — the four pre-flight holes a second reviewer found.
  it('naming the default\'s own provider keeps the default\'s BOUND key and model (not the first prefixed key)', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' }, new Date().toISOString());
    const { r, body } = await run({ topic: 'Sourdough from scratch', provider: 'google' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' });
    expect(rec?.configurable).toEqual({ credentialRefs: ['google:two'] });
  });

  it('a managed ref ⇒ ai_provider_unsupported (the managed tier refuses responseSchema), nothing created', async () => {
    const before = await candidateCount();
    const { r, body, dispatched } = await run({ topic: 'Ultramarathon base building', provider: 'google', credentialRef: 'managed:openwop-free' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_provider_unsupported', reason: 'managed_tier_no_structured_output' });
    expect(dispatched).toEqual([]);
    expect(await candidateCount()).toBe(before);
  });

  it('a ref that is not the provider\'s ⇒ ai_credential_missing (ref_not_for_provider) — it is never sent as that provider\'s key', async () => {
    await setSecret('stripe-live', 'sk_live_not_a_gemini_key', { tenantId: T });
    const before = await candidateCount();
    const { r, body, dispatched } = await run({ topic: 'Ultramarathon base building', provider: 'google', credentialRef: 'stripe-live' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_credential_missing', reason: 'ref_not_for_provider' });
    expect(dispatched).toEqual([]);
    expect(await candidateCount()).toBe(before);
  });

  it('a key that is listed but cannot be decrypted ⇒ ai_credential_missing (ref_unresolvable) BEFORE a candidate exists', async () => {
    // Stored under one KMS key, then read under another: listSecretRefs still
    // names it, resolveSecret returns null. Without the pre-flight resolve, the
    // run would start and prepareRunSecrets would throw credential_unavailable
    // with the candidate already created.
    await setSecret('openai', 'sk-openai-under-the-old-kms-key', { tenantId: T });
    clearTenantSecretCache(T);
    configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/rotated-away'));
    try {
      const before = await candidateCount();
      const { r, body, dispatched } = await run({ topic: 'Ultramarathon base building', provider: 'openai' });
      expect(r.isError).toBe(true);
      expect(body).toMatchObject({ error: 'ai_credential_missing', provider: 'openai', reason: 'ref_unresolvable' });
      expect(dispatched).toEqual([]);
      expect(await candidateCount()).toBe(before);
    } finally {
      configureKmsClient(kmsClient);
      clearTenantSecretCache(T);
      // w41 (shuffle seed 222): the undecryptable `openai` ref leaked into the
      // "missing key" case when it ran later (ref_unresolvable instead of
      // no_default_credential). Remove it so the shared tenant is order-free.
      await removeSecret('openai', { tenantId: T });
    }
  });

  it('model or credentialRef without provider ⇒ validation_error, never silently ignored', async () => {
    const before = await candidateCount();
    const { r, body } = await run({ topic: 'Ultramarathon base building', model: 'gemini-3.1-pro' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'validation_error' });
    expect(await candidateCount()).toBe(before);
  });

  it('a provider without structured output ⇒ ai_provider_unsupported (typed, nothing created) — ADR 0505 OQ3 stays honest', async () => {
    const before = await candidateCount();
    const { r, body, dispatched } = await run({ topic: 'Ultramarathon base building', provider: 'openwop-free' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_provider_unsupported', provider: 'openwop-free' });
    expect(dispatched).toEqual([]);
    expect(await candidateCount()).toBe(before);
  });
});

// KTF-LB-1 / XCH-CA-5 / XCH-LB-6 — lesson images are opt-in on the run tool,
// run on their own image binding (never the chat provider), and are
// pre-flighted with the same "nothing was created" contract as the AI leg.
// ADR 0975 D2 — a stored Factory key (ADR 0910 D8) is the Factory's binding when
// the creator names no provider, ahead of the workspace's general headless default.
// MEASURED on kicktodo.com (2026-10-25): default `anthropic` with no key + a
// `kicktodo-factory:google` key ⇒ every run refused `ai_credential_missing` while
// readiness said ready. Sabotage: removing the `dedicatedFactoryProvider` branch
// reds the first case (the default's keyless anthropic is chosen); keeping the
// ignition binding's ref reds the second (the default's `google:two` is sent).
describe('openwop:kicktodo.factory.run — ADR 0975 D2 the Factory key is the Factory\'s binding', () => {
  const T = 'user:kt-manager-0975';
  const scope: ToolScope = { tenantId: T, actingUserId: T };
  const run = async (input: Record<string, unknown>) => {
    const r = await runFactoryRunTool(deps, input, scope);
    const body = contentOf(r);
    if (typeof body.runId === 'string') started.push(body.runId);
    return { r, body };
  };
  beforeAll(async () => {
    await setSecret('kicktodo-factory:google', 'gemini-factory-key', { tenantId: T });
    await setSecret('google:two', 'gemini-chat-key', { tenantId: T });
  });
  afterEach(async () => { await clearHeadlessAiDefault(T); });

  it('a keyless workspace default (the prod shape) does not block the Factory key: the run uses google + kicktodo-factory:google', async () => {
    // The default was bound to an anthropic key that is no longer in the vault.
    await setSecret('anthropic', 'old-key', { tenantId: T });
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'anthropic', model: 'claude-x', credentialRef: 'anthropic' }, new Date().toISOString());
    await removeSecret('anthropic', { tenantId: T });
    const { r, body } = await run({ topic: 'Daily walking habit for beginners' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).toMatchObject({ provider: 'google', model: getDefaultModel('google'), credentialRef: 'kicktodo-factory:google' });
    expect(rec?.configurable).toEqual({ credentialRefs: ['kicktodo-factory:google'] });
  });

  it('when the default is the Factory key\'s own provider, the default\'s MODEL is kept but the key is the Factory\'s, never the default\'s chat key', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' }, new Date().toISOString());
    const { r, body } = await run({ topic: 'Sourdough from scratch' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'kicktodo-factory:google' });
  });

  it('a creator-named provider still wins over the Factory key (and refuses honestly without its key)', async () => {
    const { r, body } = await run({ topic: 'Sourdough from scratch', provider: 'openai' });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'ai_credential_missing', provider: 'openai' });
  });

  it('the transformation rides the run inputs (it feeds the research search query, ADR 0975 D3)', async () => {
    const { r, body } = await run({ topic: 'The Daily Walk', transformation: 'from rarely walking to a daily walk' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).toMatchObject({ transformation: 'from rarely walking to a daily walk' });
  });
});

// Sabotage: dropping `...image.inputs` from the run inputs reds the stamping
// case; dropping the pre-flight starts a run in the no-key case.
describe('openwop:kicktodo.factory.run — lesson images (KTF-LB-1 / XCH-LB-6)', () => {
  const T = 'user:kt-manager-media';
  const scope: ToolScope = { tenantId: T, actingUserId: T };
  const candidateCount = async (): Promise<number> =>
    rowsOf(contentOf(await runCandidatesTool({}, scope)).candidates).length;
  const run = async (input: Record<string, unknown>) => {
    const r = await runFactoryRunTool(deps, input, scope);
    const body = contentOf(r);
    if (typeof body.runId === 'string') started.push(body.runId);
    return { r, body };
  };

  beforeAll(async () => {
    await setSecret('anthropic', 'test-anthropic-key', { tenantId: T });
  });

  it('generateMedia without an image key ⇒ image_credential_missing, nothing created', async () => {
    const before = await candidateCount();
    const { r, body } = await run({ topic: 'Sketching daily', generateMedia: true });
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ error: 'image_credential_missing', provider: 'openai' });
    expect(await candidateCount()).toBe(before);
  });

  it('generateMedia with an image key stamps the image binding beside the chat binding, both refs registered', async () => {
    await setSecret('openai', 'test-openai-key', { tenantId: T });
    try {
      const { r, body } = await run({ topic: 'Sketching daily', generateMedia: true });
      expect(r.isError, r.content).toBeUndefined();
      expect(body).toMatchObject({ generateMedia: true, imageProvider: 'openai', provider: 'anthropic' });
      const rec = await storage.getRun(String(body.runId));
      expect(rec?.inputs).toMatchObject({ provider: 'anthropic', credentialRef: 'anthropic', generateMedia: true, imageProvider: 'openai', imageCredentialRef: 'openai' });
      expect(rec?.configurable).toEqual({ credentialRefs: ['anthropic', 'openai'] });
    } finally {
      await removeSecret('openai', { tenantId: T });
    }
  });

  it('without generateMedia the run carries no image inputs', async () => {
    const { r, body } = await run({ topic: 'Sketching daily' });
    expect(r.isError, r.content).toBeUndefined();
    expect(body.generateMedia).toBe(false);
    const rec = await storage.getRun(String(body.runId));
    expect(rec?.inputs).not.toHaveProperty('generateMedia');
    expect(rec?.inputs).not.toHaveProperty('imageCredentialRef');
  });

  it('imageProvider without generateMedia, an unknown imageProvider, or a non-boolean generateMedia ⇒ validation_error, nothing created', async () => {
    const before = await candidateCount();
    for (const input of [
      { topic: 'Sketching daily', imageProvider: 'openai' },
      { topic: 'Sketching daily', generateMedia: true, imageProvider: 'mock' },
      { topic: 'Sketching daily', generateMedia: 'yes' },
    ]) {
      const { r, body } = await run(input);
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(body).toMatchObject({ error: 'validation_error' });
    }
    expect(await candidateCount()).toBe(before);
  });
});
