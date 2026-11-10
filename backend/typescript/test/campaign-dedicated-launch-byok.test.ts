/** ADR 0712 / ADR 0961: dedicated launch -> declarations -> real executor/adapter.
 * Production workflows, authorization and provider adapters remain real.
 * The real autopilot is deliberately blocked by an incomplete local brief.
 * A separate one-node probe consumes its captured configurable/metadata so KB,
 * approvals and ad preflight cannot hide the credential declaration failure.
 *
 * Wrong-tenant source: three guards hold it. stageRun `taggedCampaignOf` reads
 * the tag only from a same-tenant run AND re-checks the tenant in its throw;
 * runStarter refuses a foreign `inheritFromRunId` parent (404). Removing the
 * throw re-check alone stays green (w93 probe); breaking both stageRun halves
 * reds the exact 403 `not_campaign_run` assertion.
 *
 * Sabotage-witnessed (w93): dropping `configurable.ai.credentialRef` from
 * declaredRunCredentialRefs; ignoring the launch `ai` option; resolving it
 * AFTER claiming ignition; dropping the launch/tool configurable; removing the
 * provider, model or colon-grammar (google-vertex) checks; treating an
 * unresolved key as usable; projecting before stage reuse; copying the source
 * configurable into a stage; dropping the stage aiDefault metadata or the
 * managed empty inputs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createOrg, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { configureSecretResolver, setSecret, clearCache } from '../src/byok/secretResolver.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { getRunSecrets } from '../src/byok/ephemeralRunSecrets.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { getChatByokConfig, setChatByokConfig, clearChatByokConfig } from '../src/host/chatByokConfig.js';
import { getDefaultModel, getProviderConfig } from '../src/providers/catalog.js';
import { bareRunId } from './support/bareRunId.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import { configureManagedProvider, bootstrapManagedProvider, _clearManagedCacheForTests } from '../src/providers/managedProvider.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { startStageRun, stageRunId } from '../src/features/campaign-autopilot/stageRun.js';
import { stampCampaignRun, listCampaignRuns } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { runOrchestrationRunTool } from '../src/features/campaign-orchestration/agentTools.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

// Optional dedicated host launch body on the existing scoped action.
// It uses only existing run AI option names, never credential material.
interface LaunchAi { provider: 'google' | 'anthropic'; model: string; credentialRef: string }
let storage: Storage | undefined;
let starter: StartRunDeps | undefined;
let omitProvider = false;
const seenProviders: string[] = [];
const seenGoogleModels: string[] = [];
let server: Server | undefined;
let dataDir: string | undefined;
const launchedRunIds = new Set<string>();
let cleanupFinished = false;
let base = '';
let tenant = '';
let orgId = '';
let actor = '';
let cookie = '';
let provider: LaunchAi['provider'] = 'google';
const nativeFetch = globalThis.fetch;
const seenHeaders: string[] = [];
const seenDeclared: string[][] = [];
const probeType = 'test.campaign-launch-byok-probe';
const selectedValue = 'qa-synthetic-selected-value';
const otherValue = 'qa-synthetic-other-value';
const managedValue = 'qa-synthetic-managed-value';
const localKmsKey = Buffer.alloc(32, 7); // synthetic local encryption, no cloud KMS

beforeAll(async () => {
  try {
    // Reset inherited module cache BEFORE boot and prefer this synthetic env key
    // over any existing ./data master-key file. Never read the previous value.
    resetCachedMasterKey();
    clearCache();
    vi.stubEnv('OPENWOP_BYOK_ENCRYPTION_KEY', '17'.repeat(32));
    vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
    vi.stubEnv('OPENWOP_SESSION_SECRET', 'qa-fixture-session-secret-at-least-32-characters');
    vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', 'false');
    vi.stubEnv('OPENWOP_BOOT_SECRETS', '{}');
    vi.stubEnv('OPENWOP_SAMPLE_SECRETS', '{}');
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    vi.stubEnv('OPENWOP_MANAGED_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', managedValue);
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('OPENWOP_RELEASE_BUS', 'off');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    configureKmsClient(createLocalAesKmsClient(localKmsKey, 'test/launch-byok'));
    // Only loopback app HTTP and the synthetic vendor boundary are allowed.
    // No vendor request ever falls through to nativeFetch.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (base && url.origin === base) return nativeFetch(input, init);
      const headers = new Headers(init?.headers);
      if (url.hostname === 'generativelanguage.googleapis.com') {
        // The real adapter streams SSE; plain JSON would exercise only its
        // incomplete-stream refusal, hiding the credential dispatch contract.
        expect(url.pathname).toMatch(/:streamGenerateContent$/);
        expect(url.searchParams.get('alt')).toBe('sse');
        seenProviders.push('google');
        seenGoogleModels.push(decodeURIComponent(url.pathname.split('/models/')[1]?.split(':')[0] ?? ''));
        seenHeaders.push(headers.get('x-goog-api-key') ?? '');
        const chunk = { candidates: [{ content: { parts: [{ text: 'local receipt' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        return new Response('data: ' + JSON.stringify(chunk) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.hostname === 'api.anthropic.com') {
        seenProviders.push('anthropic');
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        seenHeaders.push(headers.get('x-api-key') ?? '');
        if (body && typeof body === 'object' && 'stream' in body && body.stream === true) {
          const events = [
            { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local managed receipt' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ];
          return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ id: 'msg-local', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'local receipt' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('Unexpected egress in local launch fixture: ' + url.origin);
    }));
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    const hostSuite: HostAdapterSuite = app.locals.hostSuite;
    starter = { storage: ownStorage(), hostSuite };
    // Override the app's default local data directory for synthetic values only.
    dataDir = mkdtempSync(join(tmpdir(), 'launch-byok-'));
    configureSecretResolver({ storage: ownStorage(), dataDir });
    configureManagedProvider({ storage: ownStorage(), dataDir });
    _clearManagedCacheForTests();
    await bootstrapManagedProvider();
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const port: number = address.port;
    base = 'http://127.0.0.1:' + port;
    for (const id of ['campaign-orchestration', 'campaign-autopilot', 'campaign-channels']) {
      const defaults = getToggleDefault(id);
      if (!defaults) throw new Error('Missing actual feature default ' + id);
      await saveConfig({ ...defaults, status: 'on' }, 'local-fixture');
    }
    const workspace = await createWorkspace({ name: 'Local launch declaration fixture', ownerSubject: 'oidc:launch-owner' });
    tenant = workspace.tenantId;
    actor = (await upsertFromPrincipal({ tenantId: tenant, principalId: 'oidc:launch-owner', source: 'oidc' })).userId;
    // Cookie requests recheck canonical root membership before child-org RBAC.
    // Root viewer is enough; only the owned child grants editor authority.
    await createMember({ tenantId: tenant, orgId: tenant, subject: actor, displayName: 'Fixture workspace viewer', roles: ['viewer'] });
    orgId = (await createOrg({ tenantId: tenant, createdBy: actor, name: 'Local draft client' })).orgId;
    await createMember({ tenantId: tenant, orgId, subject: actor, displayName: 'Fixture author', roles: ['editor'] });
    const now = Math.floor(Date.now() / 1000);
    cookie = '__session=' + signSession({ sid: randomUUID(), tenantId: tenant, tier: 'user', userId: actor, personalTenant: 'user:local-launch-owner', iat: now, exp: now + COOKIE_TTL_SECONDS });
    getNodeRegistry().register({
      typeId: probeType, version: '1.0.0',
      async execute(ctx) {
        seenDeclared.push(Object.keys(getRunSecrets(ctx.runId)));
        if (!ctx.callAI) throw new Error('Actual executor AI seam missing');
        // The typed host request requires strings. Empty names exercise the real
        // withRunAiDefault unnamed-provider branch without a laundering cast.
        const result = await ctx.callAI({ provider: omitProvider ? '' : provider, model: omitProvider ? '' : getDefaultModel(provider), messages: [{ role: 'user', content: 'Return local receipt.' }] });
        return { status: 'success', outputs: { received: result !== undefined } };
      },
    });
  } catch (setupError) {
    try { await cleanupOwned(); }
    catch (cleanupError) { throw new AggregateError([setupError, cleanupError], 'Fixture setup and cleanup failed'); }
    throw setupError;
  }
});
afterAll(cleanupOwned);
// Even a failed preflight assertion must not leave a queued launch behind when
// the next case changes its synthetic provider or request counters.
afterEach(async () => {
  if (!storage) return;
  for (const runId of launchedRunIds) {
    const run = await storage.getRun(runId);
    if (run) await bounded(cancelRunAndCascade(storage, run, 'Local case complete'), 'owned case run cancellation');
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});
beforeEach(() => { seenHeaders.length = 0; seenDeclared.length = 0; seenProviders.length = 0; seenGoogleModels.length = 0; omitProvider = false; });

function ownStorage(): Storage {
  if (!storage) throw new Error('Local memory storage not initialized');
  return storage;
}
async function bounded<T>(work: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + operation)), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function cleanupOwned(): Promise<void> {
  if (cleanupFinished) return;
  cleanupFinished = true;
  const failures: unknown[] = [];
  try {
    if (storage) {
      for (const runId of launchedRunIds) {
        try {
          const run = await storage.getRun(runId);
          if (run) await bounded(cancelRunAndCascade(storage, run, 'Local fixture cleanup'), 'owned run cancellation');
        } catch (error) { failures.push(error); }
      }
      // Drain owned cancellation/event callbacks before restoring test globals.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (server) {
      try {
        const listener = server;
        const closed = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        listener.closeAllConnections();
        await bounded(closed, 'owned loopback listener close');
      } catch (error) { failures.push(error); }
    }
    if (storage) {
      try { await bounded(storage.close(), 'owned memory storage close'); }
      catch (error) { failures.push(error); }
    }
  } finally {
    try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
    clearCache();
    resetCachedMasterKey();
    _resetKmsForTesting();
    _clearManagedCacheForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed');
}

async function probe(configurable: RunRecord['configurable'], metadata: RunRecord['metadata']) {
  const storage = ownStorage();
  const now = new Date().toISOString();
  const run: RunRecord = { runId: randomUUID(), tenantId: tenant, workflowId: 'local.launch-byok-probe', status: 'pending', inputs: {}, configurable, metadata, createdAt: now, updatedAt: now };
  await storage.insertRun(run);
  const definition: WorkflowDefinition = { workflowId: run.workflowId, nodes: [{ nodeId: 'probe', typeId: probeType }] };
  const result = await executeRun(storage, run, definition, { policyResolver: { async resolveForRun() { return []; } } });
  const events = await storage.listEvents(run.runId);
  const persisted = await storage.getRun(run.runId);
  for (const value of [selectedValue, otherValue, managedValue]) {
    expect(JSON.stringify(persisted)).not.toContain(value);
    expect(JSON.stringify(events)).not.toContain(value);
  }
  return result;
}

it.each(['google', 'anthropic'] as const)('existing declaration contract reaches the fake %s provider with the selected synthetic key', async selectedProvider => {
  provider = selectedProvider;
  const ref = provider + ':selected-local';
  await setSecret(ref, selectedValue, { tenantId: tenant });
  await setSecret(provider + ':other-local', otherValue, { tenantId: tenant });
  const result = await probe({ ai: { provider, model: getDefaultModel(provider), credentialRef: ref } }, {});
  expect(result.status).toBe('completed');
  expect(seenDeclared).toEqual([[ref]]);
  expect(seenHeaders.length).toBeGreaterThan(0);
  expect(seenHeaders.every(value => value === selectedValue)).toBe(true);
});

it.each(['google', 'anthropic'] as const)('dedicated launch records its explicit %s option and the captured run reaches actual AI dispatch', async selectedProvider => {
  provider = selectedProvider;
  const ref = provider + ':selected-local';
  await setSecret(ref, selectedValue, { tenantId: tenant });
  await setSecret(provider + ':other-local', otherValue, { tenantId: tenant });
  // An incomplete real brief blocks the production autopilot before generation;
  // no KB, paid account, fake persona or fake approved kernel is introduced.
  const brief = await createBrief(tenant, orgId, actor, { name: 'Local incomplete launch fixture', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const ai: LaunchAi = { provider, model: getDefaultModel(provider), credentialRef: ref };
  const response = await fetch(base + '/host/openwop-app/campaign-autopilot/campaigns/' + encodeURIComponent(campaign.id) + '/launch', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ai }),
  });
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('runId' in body) || typeof body.runId !== 'string') throw new Error('Launch did not return its actual run id');
  const storage = ownStorage();
  const runId = bareRunId(body.runId);
  launchedRunIds.add(runId);
  // A201 is not a settled executor. Observe the ACTUAL blocked preflight and
  // its clarification card before another case can change provider/fetch state.
  const captured = await vi.waitFor(async () => {
    const run = await storage.getRun(runId);
    if (!run || run.status === 'pending' || run.status === 'running') throw new Error('Autopilot preflight has not settled');
    expect(run.status).toMatch(/^waiting/);
    const interrupts = await storage.listOpenInterrupts(runId);
    expect(interrupts).toHaveLength(1);
    const [card] = interrupts;
    if (!card) throw new Error('Expected actual preflight clarification');
    expect(card.kind).toBe('clarification');
    expect(JSON.stringify(card.data)).toContain('Brief is complete');
    return run;
  }, { timeout: 2000, interval: 10 });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(seenHeaders).toEqual([]);
  expect(seenDeclared).toEqual([]);
  const reusedResponse = await fetch(base + '/host/openwop-app/campaign-autopilot/campaigns/' + encodeURIComponent(campaign.id) + '/launch', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ai: { credentialRef: provider + ':other-local' } }),
  });
  expect(reusedResponse.status).toBe(200);
  expect(await reusedResponse.json()).toMatchObject({ runId: body.runId, reused: true });
  expect((await storage.getRun(runId))?.configurable).toEqual(captured.configurable);
  // Execute the REAL credential preparation/adapter with that exact captured
  // option set, not a hand-added declaration that would mask the launch defect.
  const result = await probe(captured.configurable, captured.metadata);
  expect(result.status).toBe('completed');
  expect(seenDeclared).toEqual([[ref]]);
  expect(seenHeaders.length).toBeGreaterThan(0);
  expect(seenHeaders.every(value => value === selectedValue)).toBe(true);
  expect(captured.configurable).toMatchObject({ ai });
  expect(JSON.stringify(captured)).not.toContain(selectedValue);
});

it('unavailable and foreign keys have the same refusal and do not consume ignition before a valid retry', async () => {
  provider = 'google';
  const foreign = await createWorkspace({ name: 'Other local fixture', ownerSubject: 'oidc:other-launch-owner' });
  const foreignRef = 'google:foreign-only';
  await setSecret(foreignRef, otherValue, { tenantId: foreign.tenantId });
  const brief = await createBrief(tenant, orgId, actor, { name: 'Admission retry', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const post = (ai: unknown) => fetch(base + '/host/openwop-app/campaign-autopilot/campaigns/' + encodeURIComponent(campaign.id) + '/launch', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ai }),
  });
  const missing = await post({ credentialRef: 'google:missing-local' });
  const foreignResponse = await post({ credentialRef: foreignRef });
  expect(missing.status).toBe(403);
  expect(foreignResponse.status).toBe(403);
  // The exact launch refusal, not any 403 (RBAC and the cookie gate share the status).
  const missingBody: unknown = await missing.json();
  expect(missingBody).toMatchObject({ error: 'credential_forbidden', details: { reason: 'campaign_ai_key_forbidden' } });
  expect(await foreignResponse.json()).toEqual(missingBody);
  expect(seenHeaders).toEqual([]);
  await setSecret('google:admission-valid', selectedValue, { tenantId: tenant });
  const valid = await post({ credentialRef: 'google:admission-valid' });
  expect(valid.status).toBe(201);
  const out: unknown = await valid.json();
  if (!out || typeof out !== 'object' || !('runId' in out) || typeof out.runId !== 'string') throw new Error('Valid retry did not launch');
  const id = bareRunId(out.runId);
  launchedRunIds.add(id);
  const captured = await vi.waitFor(async () => {
    const run = await ownStorage().getRun(id);
    if (!run || !run.status.startsWith('waiting')) throw new Error('Preflight has not settled');
    return run;
  }, { timeout: 2000, interval: 10 });
  expect(captured.configurable).toMatchObject({ ai: { credentialRef: 'google:admission-valid', provider: 'google', model: getDefaultModel('google') } });
  expect(seenHeaders).toEqual([]);
});

it.each([
  { provider: 'anthropic', model: getDefaultModel('google'), reason: 'campaign_ai_provider_mismatch' },
  { provider: 'google', model: getDefaultModel('anthropic'), reason: 'campaign_ai_model_mismatch' },
])('refuses incoherent provider/model before ignition: $reason', async ({ provider: requestedProvider, model, reason }) => {
  await setSecret('google:coherent-only', selectedValue, { tenantId: tenant });
  const brief = await createBrief(tenant, orgId, actor, { name: 'Coherence refusal', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const response = await fetch(base + '/host/openwop-app/campaign-autopilot/campaigns/' + encodeURIComponent(campaign.id) + '/launch', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ai: { credentialRef: 'google:coherent-only', provider: requestedProvider, model } }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'validation_error', details: { reason } });
  expect(seenHeaders).toEqual([]);
});

it.each(['google', 'anthropic'] as const)('Strategist actual tool launch declares the explicitly supplied %s key', async selectedProvider => {
  if (!starter) throw new Error('Actual starter missing');
  provider = selectedProvider;
  const ref = provider + ':tool-choice';
  await setSecret(ref, selectedValue, { tenantId: tenant });
  const brief = await createBrief(tenant, orgId, actor, { name: 'Tool launch fixture', channels: [] });
  const ai = { credentialRef: ref, provider, model: getDefaultModel(provider) };
  const result = await runOrchestrationRunTool(starter, { briefId: brief.id, ai }, { tenantId: tenant, actingUserId: actor });
  const body: unknown = JSON.parse(result.content);
  if (!body || typeof body !== 'object' || !('runId' in body) || typeof body.runId !== 'string') throw new Error('Actual tool did not launch: ' + result.content);
  const id = bareRunId(body.runId);
  launchedRunIds.add(id);
  const captured = await vi.waitFor(async () => {
    const run = await ownStorage().getRun(id);
    if (!run || run.status === 'pending' || run.status === 'running') throw new Error('Tool launch has not settled');
    return run;
  }, { timeout: 2000, interval: 10 });
  expect(captured.configurable).toMatchObject({ ai });
  expect(seenHeaders).toEqual([]);
  omitProvider = true;
  expect((await probe(captured.configurable, captured.metadata)).status).toBe('completed');
  expect(seenDeclared).toEqual([[ref]]);
  expect(seenProviders.length).toBeGreaterThan(0);
  expect(seenProviders.every(value => value === provider)).toBe(true);
  expect(seenHeaders.every(value => value === selectedValue)).toBe(true);
});

it('detached stage captures source AI, strips unrelated authority and resolves deterministic reuse before legacy validation', async () => {
  await setSecret('google:stage-selected', selectedValue, { tenantId: tenant });
  await setSecret('google:stage-other', otherValue, { tenantId: tenant });
  const brief = await createBrief(tenant, orgId, actor, { name: 'Detached stage fixture', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const model = getDefaultModel('google');
  const source: RunRecord = {
    runId: sourceId, tenantId: tenant, workflowId: 'campaign-studio.autopilot', status: 'completed', inputs: {}, createdAt: now, updatedAt: now,
    configurable: { ai: { provider: 'google', model, credentialRef: 'google:stage-selected' }, connections: ['do-not-copy'], tools: { private: true } },
    metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), aiDefault: { provider: 'anthropic', model: getDefaultModel('anthropic'), source: 'workspace' } },
  };
  await ownStorage().insertRun(source);
  const scope = { tenantId: tenant, runId: sourceId, actingUserId: actor };
  await expect(startStageRun(scope, { stage: 'drafts', provider: 'anthropic' })).rejects.toMatchObject({ details: { reason: 'campaign_ai_stage_mismatch' } });
  expect(await ownStorage().getRun(stageRunId(tenant, sourceId, 'drafts'))).toBeNull();
  const launched = await startStageRun(scope, { stage: 'drafts' });
  launchedRunIds.add(launched.runId);
  const captured = await vi.waitFor(async () => {
    const run = await ownStorage().getRun(launched.runId);
    if (!run || run.status === 'pending' || run.status === 'running') throw new Error('Detached stage has not settled');
    return run;
  }, { timeout: 2000, interval: 10 });
  expect(captured.configurable).toEqual({ credentialRefs: ['google:stage-selected'], ai: { provider: 'google', model, credentialRef: 'google:stage-selected' } });
  expect(captured.inputs).toEqual({ briefId: brief.id, provider: 'google', model });
  expect(captured.metadata).toMatchObject({ aiDefault: { provider: 'google', model, source: 'run' }, campaignOrchestration: { campaignId: campaign.id, role: 'stage' } });
  expect(seenHeaders).toEqual([]);
  omitProvider = true;
  expect((await probe(captured.configurable, captured.metadata)).status).toBe('completed');
  expect(seenDeclared).toEqual([['google:stage-selected']]);
  expect(seenProviders.length).toBeGreaterThan(0);
  expect(seenProviders.every(value => value === 'google')).toBe(true);
  expect(seenHeaders.every(value => value === selectedValue)).toBe(true);
  // A persisted legacy parent cannot be newly blessed. Its already-existing
  // deterministic stage remains reusable without reinterpreting current args.
  await ownStorage().updateRun(source.runId, { ...source, configurable: {}, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }) } });
  const reused = await startStageRun(scope, { stage: 'drafts', provider: 'anthropic', model: 'now-different' });
  expect(reused.runId).toBe(launched.runId);
  expect((await ownStorage().getRun(reused.runId))?.configurable).toEqual(captured.configurable);
});

it('a legacy parent without a frozen decision refuses only a NEW stage', async () => {
  const brief = await createBrief(tenant, orgId, actor, { name: 'Legacy stage refusal', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  await ownStorage().insertRun({ runId: sourceId, tenantId: tenant, workflowId: 'campaign-studio.autopilot', status: 'completed', inputs: {}, configurable: {}, createdAt: now, updatedAt: now, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }) } });
  await expect(startStageRun({ tenantId: tenant, runId: sourceId, actingUserId: actor }, { stage: 'drafts' })).rejects.toMatchObject({ httpStatus: 422, details: { reason: 'campaign_ai_choice_missing' } });
  expect(await ownStorage().getRun(stageRunId(tenant, sourceId, 'drafts'))).toBeNull();
  expect(seenHeaders).toEqual([]);
});

it('a real detached managed stage keeps its sentinel and ctx.callAI reaches the synthetic managed vendor with no vault declaration', async () => {
  const brief = await createBrief(tenant, orgId, actor, { name: 'Managed detached stage', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const choice = { provider: 'openwop-free', model: getDefaultModel('openwop-free'), source: 'managed', credentialRef: 'managed:openwop-free' };
  await ownStorage().insertRun({ runId: sourceId, tenantId: tenant, workflowId: 'campaign-studio.autopilot', status: 'completed', inputs: {}, configurable: {}, createdAt: now, updatedAt: now, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), aiDefault: choice } });
  const stage = await startStageRun({ tenantId: tenant, runId: sourceId, actingUserId: actor }, { stage: 'drafts', provider: choice.provider, model: choice.model });
  launchedRunIds.add(stage.runId);
  const captured = await vi.waitFor(async () => {
    const row = await ownStorage().getRun(stage.runId);
    if (!row || row.status === 'pending' || row.status === 'running') throw new Error('Managed stage not settled');
    return row;
  }, { timeout: 2000, interval: 10 });
  expect(captured.configurable).toEqual({});
  expect(captured.inputs).toEqual({ briefId: brief.id });
  expect(captured.metadata).toMatchObject({ aiDefault: choice });
  expect(seenHeaders).toEqual([]);
  omitProvider = true;
  expect((await probe(captured.configurable, captured.metadata)).status).toBe('completed');
  expect(seenDeclared).toEqual([[]]);
  expect(seenProviders.length).toBeGreaterThan(0);
  expect(seenProviders.every(value => value === 'anthropic')).toBe(true);
  expect(seenHeaders.every(value => value === managedValue)).toBe(true);
});

it.each([false, true])('the shipped autopilot stage node resolves optional template provider/model bindings (supplied=%s)', async supplied => {
  const brief = await createBrief(tenant, orgId, actor, { name: 'Actual optional stage bindings', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const model = getDefaultModel('google');
  const source: RunRecord = { runId: sourceId, tenantId: tenant, workflowId: 'campaign-studio.autopilot', status: 'pending', inputs: supplied ? { provider: 'google', model } : {}, createdAt: now, updatedAt: now, configurable: { ai: { provider: 'google', model, credentialRef: 'google:template-key' } }, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }) } };
  await setSecret('google:template-key', selectedValue, { tenantId: tenant });
  await ownStorage().insertRun(source);
  const shipped = buildChainBackedDefinition('campaign-studio.autopilot');
  const node = shipped.nodes.find(candidate => candidate.typeId === 'feature.campaign-autopilot.nodes.start-stage');
  if (!node) throw new Error('Shipped start-stage node missing');
  expect(node.inputs).toMatchObject({ provider: { type: 'variable', variableName: 'provider' }, model: { type: 'variable', variableName: 'model' } });
  // This local probe extracts the ACTUAL shipped node and bindings. It does not
  // change the registered autopilot, bypass/approve its preflight, or claim a
  // full campaign run. The stage itself still fails its incomplete real brief.
  const definition: WorkflowDefinition = { workflowId: source.workflowId, nodes: [node], variables: shipped.variables };
  expect((await executeRun(ownStorage(), source, definition, { policyResolver: { async resolveForRun() { return []; } } })).status).toBe('completed');
  const id = stageRunId(tenant, sourceId, 'drafts');
  launchedRunIds.add(id);
  const captured = await vi.waitFor(async () => {
    const row = await ownStorage().getRun(id);
    if (!row || row.status === 'pending' || row.status === 'running') throw new Error('Template stage not settled');
    return row;
  }, { timeout: 2000, interval: 10 });
  expect(captured.inputs).toEqual({ briefId: brief.id, provider: 'google', model });
  expect(captured.configurable).toMatchObject({ ai: { provider: 'google', model, credentialRef: 'google:template-key' } });
  expect(seenHeaders).toEqual([]);
});

it('a held Google-hyphen name refuses dedicated selection without consuming ignition, then a colon-qualified retry launches', async () => {
  const hyphenRef = 'google-vertex:local-held';
  const validRef = 'google:hyphen-retry';
  await setSecret(hyphenRef, otherValue, { tenantId: tenant });
  await setSecret(validRef, selectedValue, { tenantId: tenant });
  const brief = await createBrief(tenant, orgId, actor, { name: 'Explicit naming admission', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const post = (credentialRef: string) => fetch(base + '/host/openwop-app/campaign-autopilot/campaigns/' + encodeURIComponent(campaign.id) + '/launch', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ai: { credentialRef } }),
  });
  expect(await listCampaignRuns(tenant, campaign.id)).toEqual([]);
  const refused = await post(hyphenRef);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'credential_forbidden', details: { reason: 'campaign_ai_key_forbidden' } });
  expect(await listCampaignRuns(tenant, campaign.id)).toEqual([]);
  expect(seenHeaders).toEqual([]);
  const retry = await post(validRef);
  expect(retry.status).toBe(201);
  const body: unknown = await retry.json();
  if (!body || typeof body !== 'object' || !('runId' in body) || typeof body.runId !== 'string') throw new Error('Valid colon retry did not launch');
  const id = bareRunId(body.runId);
  launchedRunIds.add(id);
  const captured = await vi.waitFor(async () => {
    const run = await ownStorage().getRun(id);
    if (!run || !run.status.startsWith('waiting')) throw new Error('Retry preflight not settled');
    return run;
  }, { timeout: 2000, interval: 10 });
  expect(captured.configurable).toMatchObject({ ai: { provider: 'google', model: getDefaultModel('google'), credentialRef: validRef } });
  expect((await listCampaignRuns(tenant, campaign.id)).map(row => row.runId)).toEqual([id]);
  expect(seenHeaders).toEqual([]);
});

it('actual detached stage rejects a wrong-tenant stored source before projection or deterministic stage creation', async () => {
  const brief = await createBrief(tenant, orgId, actor, { name: 'Foreign source refusal', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const foreignTenant = 'ws:local-foreign-source';
  await ownStorage().insertRun({ runId: sourceId, tenantId: foreignTenant, workflowId: 'campaign-studio.autopilot', status: 'completed', inputs: {}, createdAt: now, updatedAt: now, configurable: { ai: { provider: 'google', model: getDefaultModel('google'), credentialRef: 'google:foreign-source' } }, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), aiDefault: { provider: 'google', model: getDefaultModel('google'), source: 'catalog' } } });
  await expect(startStageRun({ tenantId: tenant, runId: sourceId, actingUserId: actor }, { stage: 'drafts' })).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden_scope', details: { reason: 'not_campaign_run' } });
  expect(await ownStorage().getRun(stageRunId(tenant, sourceId, 'drafts'))).toBeNull();
  expect(await ownStorage().getRun(stageRunId(foreignTenant, sourceId, 'drafts'))).toBeNull();
  expect(await listCampaignRuns(tenant, campaign.id)).toEqual([]);
  expect(seenHeaders).toEqual([]);
});

it('metadata-only BYOK stage retains frozen nondefault model and declared-key order through unnamed ctx.callAI despite a newer workspace binding', async () => {
  const chosen = 'google:metadata-selected';
  const other = 'google:metadata-other';
  await setSecret(chosen, selectedValue, { tenantId: tenant });
  await setSecret(other, otherValue, { tenantId: tenant });
  await setSecret('anthropic:later-binding', otherValue, { tenantId: tenant });
  const model = getProviderConfig('google')?.models.find(entry => entry.id !== getDefaultModel('google'))?.id;
  if (!model) throw new Error('Metadata fixture needs a catalog nondefault Google model');
  const brief = await createBrief(tenant, orgId, actor, { name: 'Metadata BYOK stage', channels: [] });
  const campaign = (await ensureDraftCampaign(tenant, brief, actor)).campaign;
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const frozen = { provider: 'google', model, source: 'workspace' };
  await ownStorage().insertRun({ runId: sourceId, tenantId: tenant, workflowId: 'campaign-studio.autopilot', status: 'completed', inputs: {}, createdAt: now, updatedAt: now, configurable: { credentialRefs: [chosen, other], connections: ['not-inherited'], tools: { private: true } }, metadata: { actingUserId: actor, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), aiDefault: frozen } });
  const priorBinding = await getChatByokConfig(tenant);
  try {
    await setChatByokConfig({ tenantId: tenant }, { provider: 'anthropic', model: getDefaultModel('anthropic'), credentialRef: 'anthropic:later-binding' }, now);
    const launched = await startStageRun({ tenantId: tenant, runId: sourceId, actingUserId: actor }, { stage: 'drafts' });
    launchedRunIds.add(launched.runId);
    const captured = await vi.waitFor(async () => {
      const row = await ownStorage().getRun(launched.runId);
      if (!row || row.status === 'pending' || row.status === 'running') throw new Error('Metadata-only stage not settled');
      return row;
    }, { timeout: 2000, interval: 10 });
    expect(captured.configurable).toEqual({ credentialRefs: [chosen, other], ai: { provider: 'google', model } });
    expect(captured.inputs).toEqual({ briefId: brief.id, provider: 'google', model });
    expect(captured.metadata).toMatchObject({ aiDefault: frozen });
    expect(seenHeaders).toEqual([]);
    omitProvider = true;
    expect((await probe(captured.configurable, captured.metadata)).status).toBe('completed');
    expect(seenDeclared).toEqual([[chosen, other]]);
    expect(seenProviders.length).toBeGreaterThan(0);
    expect(seenProviders.every(value => value === 'google')).toBe(true);
    expect(seenGoogleModels).toEqual(seenProviders.map(() => model));
    expect(seenHeaders.every(value => value === selectedValue)).toBe(true);
  } finally {
    if (priorBinding) await setChatByokConfig({ tenantId: tenant }, priorBinding, priorBinding.updatedAt);
    else await clearChatByokConfig(tenant);
  }
});
