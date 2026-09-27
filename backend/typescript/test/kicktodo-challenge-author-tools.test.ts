/**
 * ADR 0458 CRITICAL-3 — the Challenge Author's tools fail CLOSED without an
 * acting human holding KickTodo manage authority, through the SAME predicate the
 * authoring routes use (`hasKicktodoManageAuthority`). A participant who reaches
 * the agent cannot read the factory pipeline or drive the Factory.
 *
 *   - the READ tool fails EMPTY (no candidates) without authority;
 *   - the ACTION tool returns a typed error (`acting_user_required` /
 *     `forbidden`) without authority, and starts a run WITH it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked } from '../src/features/index.js';
import { createCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { kicktodoCreatorBuiltinWorkflows } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import { runCandidatesTool, runFactoryRunTool, type ToolScope } from '../src/features/kicktodo-creator/agentTools.js';
import { createTurnRunDispatchCollector } from '../src/host/turnRunDispatch.js';
import { randomBytes } from 'node:crypto';
import { configureSecretResolver, setSecret, clearTenantSecretCache } from '../src/byok/secretResolver.js';
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

beforeAll(async () => {
  // Boot parity (src/index.ts): the factory is registered CHAIN-BACKED — the
  // chain packs load through the real loader and the boot registrar binds the
  // same-id definitions. ADR 0706's run tool reads the chain's pinned
  // provider/model from that definition's `variables[]`, which the raw legacy
  // def this harness used to register never carried.
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  registerLegacyDefsChainBacked(kicktodoCreatorBuiltinWorkflows);
  // The Factory refuses to start without a live search adapter (its dossier is
  // fail-closed on demo sources), so the dispatch cases need one configured.
  process.env.OPENWOP_WEBSEARCH_API_KEY = 'test-search-key';
  // ADR 0706 — and it refuses without a Secrets Vault key for the provider it
  // resolved (the chain's pinned `anthropic` here, no workspace default), so the
  // dispatch cases need that too. The 2026-07-29 run died at `extract-claims`
  // for exactly this; now it never starts.
  await setSecret('anthropic', 'test-anthropic-key', { tenantId: MGR });
});
afterAll(() => { delete process.env.OPENWOP_WEBSEARCH_API_KEY; });

describe('openwop:kicktodo.candidates (READ) — fail EMPTY without authority', () => {
  it('a system turn (no acting user) reads nothing', async () => {
    const r = await runCandidatesTool({}, { tenantId: MGR });
    expect(JSON.parse(r.content)).toEqual({ candidates: [] });
  });

  it('a non-manage participant reads nothing', async () => {
    await createCandidate({ tenantId: SHARED, createdBy: 'user:owner', topic: 'Watercolor basics', audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 });
    const scope: ToolScope = { tenantId: SHARED, actingUserId: PARTICIPANT };
    const r = await runCandidatesTool({}, scope);
    expect(JSON.parse(r.content)).toEqual({ candidates: [] });
  });

  it('a manager reads their workspace candidates with stage + draft binding', async () => {
    await createCandidate({ tenantId: MGR, createdBy: MGR, topic: 'Watercolor basics', audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 });
    const r = await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR });
    const body = JSON.parse(r.content) as { candidates: Array<{ topic: string; state: string }> };
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0]).toMatchObject({ state: 'intake' });
  });
});

describe('openwop:kicktodo.factory.run (ACTION) — typed error without authority', () => {
  it('no acting user ⇒ acting_user_required', async () => {
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics' }, { tenantId: MGR });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('a non-manage participant ⇒ forbidden', async () => {
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics' }, { tenantId: SHARED, actingUserId: PARTICIPANT });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'forbidden' });
  });

  it('a manager can create-and-run: returns a runId + candidateId', async () => {
    const r = await runFactoryRunTool(deps, { topic: 'Watercolor basics', audience: 'beginners' }, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content) as { runId: string; candidateId: string };
    expect(body.runId).toBeTruthy();
    expect(body.candidateId).toMatch(/^cand:/);
  });

  it('neither a candidateId nor a topic ⇒ validation_error', async () => {
    const r = await runFactoryRunTool(deps, {}, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'validation_error' });
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
    const { runId } = JSON.parse(r.content) as { runId: string };
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
      const before = JSON.parse((await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR })).content) as { candidates: unknown[] };
      const collector = createTurnRunDispatchCollector();
      const r = await runFactoryRunTool(
        deps,
        { topic: 'Ultramarathon base building', audience: 'runners' },
        { tenantId: MGR, actingUserId: MGR, conversationId: 'conv:kt-2', onRunDispatched: collector.sink },
      );
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content)).toMatchObject({ error: 'research_adapter_unconfigured' });
      // No run recorded, and no candidate burned by the refused call.
      expect(collector.drain()).toEqual([]);
      const after = JSON.parse((await runCandidatesTool({}, { tenantId: MGR, actingUserId: MGR })).content) as { candidates: unknown[] };
      expect(after.candidates.length).toBe(before.candidates.length);
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
    (JSON.parse((await runCandidatesTool({}, scope)).content) as { candidates: unknown[] }).candidates.length;
  const run = async (input: Record<string, unknown>) => {
    const collector = createTurnRunDispatchCollector();
    const r = await runFactoryRunTool(deps, input, { ...scope, conversationId: 'conv:kt-0706', onRunDispatched: collector.sink });
    return { r, body: JSON.parse(r.content) as Record<string, unknown>, dispatched: collector.drain() };
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
    expect(chosen!.model.length).toBeGreaterThan(0);
    expect(chosen!.credentialRef).toBeUndefined();
  });

  it('a Gemini workspace default resolves and is STAMPED on the run: inputs + configurable carry the BOUND ref, not the first prefixed one', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' }, new Date().toISOString());
    const { r, body, dispatched } = await run({ topic: 'Sourdough from scratch', audience: 'busy parents' });
    expect(r.isError, r.content).toBeUndefined();
    expect(body).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite' });
    expect(dispatched).toHaveLength(1);
    const rec = (await storage.getRun(body.runId as string))!;
    expect(rec.inputs).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' });
    expect(rec.configurable).toEqual({ credentialRefs: ['google:two'] });
  });

  it('a creator-named provider with NO ref pins the ladder\'s pick explicitly (the same rung the dispatcher would take)', async () => {
    const { r, body } = await run({ topic: 'Trail running', provider: 'google' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = (await storage.getRun(body.runId as string))!;
    // No exact `google` ref exists, so the prefix rung picks the FIRST in vault
    // order — and that pick is frozen on the run, so dispatch cannot re-pick.
    expect(rec.inputs).toMatchObject({ provider: 'google', credentialRef: 'google:one' });
    expect(rec.configurable).toEqual({ credentialRefs: ['google:one'] });
  });

  it('no workspace default ⇒ the chain\'s pinned provider (read from the definition), with its vault key pinned', async () => {
    await setSecret('anthropic', 'test-anthropic-key', { tenantId: T });
    const { r, body } = await run({ topic: 'Watercolor basics' });
    expect(r.isError, r.content).toBeUndefined();
    const rec = (await storage.getRun(body.runId as string))!;
    expect(rec.inputs).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', credentialRef: 'anthropic' });
    expect(rec.configurable).toEqual({ credentialRefs: ['anthropic'] });
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
    const rec = (await storage.getRun(body.runId as string))!;
    expect(rec.inputs).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' });
    expect(rec.configurable).toEqual({ credentialRefs: ['google:two'] });
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
