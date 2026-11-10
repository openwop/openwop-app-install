/** KB-BYOK-1 (ADR 0398 P3 / ADR 0712 OQ4): real start/drain → tenant KMS resolver
 * → real Google dispatch, with ONLY the fetch boundary replaced. No app boot, live
 * DSN, provider egress, resolver override, headless binding, secret alias, or
 * scheduler worker.
 * Sabotage-witnessed (w93): dropping the other-provider guard in startReindex;
 * ignoring the spec's explicit credentialRef in resolveHeadlessEmbedderForSpec;
 * falling back to the provider-convention key when the explicit ref is
 * unresolved; flipping the serving spec at start instead of at cutover;
 * completing a rebuild whose provider refused (local vectors instead of fail). */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { configureSecretResolver, setSecret, removeSecret, clearCache } from '../src/byok/secretResolver.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { __setHeadlessEmbedderForTest, getHeadlessAiDefault } from '../src/host/headlessAi.js';
import { createCollection, ingestDocument, setRetrievalConfig, getCollection, searchDetailed, startReindex, drainReindex, getReindexJob } from '../src/features/kb/kbService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
const tenant = 'ws:kb-explicit-owner';
const other = 'ws:kb-explicit-other';
const org = 'org-kb-fixture';
let dataDir: string | undefined;
let storage: Storage | undefined;
let failProvider = false;
const calls: Array<{ url: string; key: string | null; tasks: string[] }> = [];
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openwop-kb-explicit-'));
  initInMemorySurfaces({ dataDir });
});
beforeEach(async () => {
  vi.stubEnv('OPENWOP_RELEASE_BUS', 'off');
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_BYOK_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('OPENWOP_KB_HOST_EMBEDDER', '');
  vi.stubEnv('OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY', '1000000');
  resetCachedMasterKey(); clearCache(); __setHeadlessEmbedderForTest(null); _resetKmsForTesting();
  storage = await openStorage('memory://'); initHostExtPersistence(storage);
  if (!dataDir) throw new Error('Owned fixture directory missing');
  configureSecretResolver({ storage, dataDir });
  configureKmsClient(createLocalAesKmsClient(Buffer.alloc(32, 3), 'test/kb-explicit-only'));
  calls.length = 0; failProvider = false;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/') || !url.endsWith(':batchEmbedContents')) throw new Error('Unexpected egress blocked by KB fixture');
    const body: unknown = JSON.parse(String(init?.body));
    if (!body || typeof body !== 'object' || !('requests' in body) || !Array.isArray(body.requests)) throw new Error('Expected real Google embedding requests');
    const tasks: string[] = [];
    const embeddings = body.requests.map((request: unknown) => {
      if (!request || typeof request !== 'object' || !('outputDimensionality' in request) || typeof request.outputDimensionality !== 'number' || !('taskType' in request) || typeof request.taskType !== 'string') throw new Error('Expected dimension and task type');
      tasks.push(request.taskType);
      return { values: Array.from({ length: request.outputDimensionality }, (_, index) => index === 0 ? 1 : 0) };
    });
    calls.push({ url, key: new Headers(init?.headers).get('x-goog-api-key'), tasks });
    return failProvider ? Response.json({ error: { message: 'Synthetic provider refusal' } }, { status: 400 }) : Response.json({ embeddings });
  }));
});
afterEach(async () => {
  try { if (storage) await storage.close(); }
  finally { storage = undefined; __setHeadlessEmbedderForTest(null); clearCache(); _resetKmsForTesting(); resetCachedMasterKey(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
afterAll(() => { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });
async function existingLocal() {
  const col = await createCollection(tenant, org, 'fixture-owner', { name: 'Official source' });
  await setRetrievalConfig(tenant, org, col.collectionId, 'fixture-owner', { embedder: 'local', enrichment: 'off', mode: 'hybrid' }, PREAUTHORIZED_CALLER);
  await ingestDocument(tenant, org, 'fixture-owner', col.collectionId, { title: 'KickTodo', text: 'KickTodo turns a meaningful goal into small daily actions and a weekly plan.' });
  const found = await searchDetailed(tenant, org, col.collectionId, 'KickTodo small daily actions', 6, 'hybrid', PREAUTHORIZED_CALLER);
  expect(found.hits).toHaveLength(1); expect(found.embedding.mode).toBe('local'); expect(calls).toHaveLength(0);
  // Hydration may stamp the old vector signature: capture the serving baseline afterward.
  const before = await getCollection(tenant, org, col.collectionId, PREAUTHORIZED_CALLER);
  if (!before) throw new Error('Created collection disappeared');
  return { id: col.collectionId, before };
}
async function unchanged(id: string, before: Awaited<ReturnType<typeof getCollection>>) {
  expect(await getCollection(tenant, org, id, PREAUTHORIZED_CALLER)).toEqual(before);
  expect(await getReindexJob(tenant, org, id)).toBeNull();
  const found = await searchDetailed(tenant, org, id, 'KickTodo small daily actions', 6, 'hybrid', PREAUTHORIZED_CALLER);
  expect(found.hits).toHaveLength(1); expect(found.embedding.mode).toBe('local'); expect(calls).toHaveLength(0);
}
it('uses the chosen labeled tenant key at real Google dispatch and changes the serving index only on completed cutover', async () => {
  const { id, before } = await existingLocal();
  await setSecret('google:first', 'synthetic-not-chosen', { tenantId: tenant });
  await setSecret('google:chosen', 'synthetic-owner-google', { tenantId: tenant }); clearCache();
  expect(await getHeadlessAiDefault(tenant)).toBeNull();
  const started = await startReindex(tenant, org, id, { provider: 'google', credentialRef: 'google:chosen' }, PREAUTHORIZED_CALLER);
  expect(started.targetSpec).toEqual({ provider: 'google', credentialRef: 'google:chosen' }); expect(started.status).toBe('running');
  expect(JSON.stringify(started)).not.toContain('synthetic-owner-google');
  const during = await getCollection(tenant, org, id, PREAUTHORIZED_CALLER);
  expect(during?.embeddingSpec).toEqual(before?.embeddingSpec); expect(during?.activeSignature).toEqual(before?.activeSignature); expect(calls).toHaveLength(0);
  const done = await drainReindex(tenant, org, id); expect(done?.status).toBe('done'); expect(done?.embeddedChunks).toBe(1);
  const after = await getCollection(tenant, org, id, PREAUTHORIZED_CALLER); expect(after?.embeddingSpec).toEqual(started.targetSpec); expect(after?.activeSignature).toBe(started.toSig); expect(after?.pendingSignature).toBeUndefined();
  expect(calls).toHaveLength(1); expect(calls[0]?.key).toBe('synthetic-owner-google'); expect(calls[0]?.tasks).toEqual(['RETRIEVAL_DOCUMENT']);
  const found = await searchDetailed(tenant, org, id, 'KickTodo', 6, 'hybrid', PREAUTHORIZED_CALLER);
  expect(found.embedding).toMatchObject({ mode: 'provider', provider: 'google', funding: 'byok' }); expect(found.hits).toHaveLength(1);
  expect(calls).toHaveLength(2); expect(calls[1]?.tasks).toEqual(['RETRIEVAL_QUERY']); expect(calls[1]?.key).toBe('synthetic-owner-google');
  expect(await getHeadlessAiDefault(tenant)).toBeNull();
});
it.each(['anthropic:wrong', 'cohere:wrong'])('refuses known other-provider reference %s before a new job or provider call', async credentialRef => {
  const { id, before } = await existingLocal(); await setSecret(credentialRef, 'synthetic-other-vendor', { tenantId: tenant });
  await expect(startReindex(tenant, org, id, { provider: 'google', credentialRef }, PREAUTHORIZED_CALLER)).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400, details: { reason: 'credential_provider_mismatch' } });
  await unchanged(id, before);
});
it('does not fall back to a default or another tenant for missing, foreign-only, or deleted explicit refs', async () => {
  const { id, before } = await existingLocal();
  await setSecret('google', 'synthetic-convention-key', { tenantId: tenant });
  await setSecret('google:foreign', 'synthetic-foreign-key', { tenantId: other });
  await setSecret('google:deleted', 'synthetic-deleted-key', { tenantId: tenant }); await removeSecret('google:deleted', { tenantId: tenant }); clearCache();
  for (const credentialRef of ['google:missing', 'google:foreign', 'google:deleted']) {
    // The no-key refusal itself: startReindex has several other validation_error 400s.
    await expect(startReindex(tenant, org, id, { provider: 'google', credentialRef }, PREAUTHORIZED_CALLER)).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400, message: expect.stringMatching(/No resolvable embeddings credential for provider 'google'/), details: { provider: 'google' } });
    await unchanged(id, before);
  }
});
it('retains opaque explicit alias compatibility at the same real resolver and dispatch boundary', async () => {
  const { id } = await existingLocal(); await setSecret('my-embedding-key', 'synthetic-alias-key', { tenantId: tenant }); clearCache();
  await startReindex(tenant, org, id, { provider: 'google', credentialRef: 'my-embedding-key' }, PREAUTHORIZED_CALLER);
  expect((await drainReindex(tenant, org, id))?.status).toBe('done'); expect(calls).toHaveLength(1); expect(calls[0]?.key).toBe('synthetic-alias-key');
  expect((await getCollection(tenant, org, id, PREAUTHORIZED_CALLER))?.embeddingSpec).toEqual({ provider: 'google', credentialRef: 'my-embedding-key' });
});
it('keeps the old Local index and serving spec after a started rebuild receives a provider refusal', async () => {
  const { id, before } = await existingLocal(); await setSecret('google:chosen', 'synthetic-rejected-key', { tenantId: tenant });
  await startReindex(tenant, org, id, { provider: 'google', credentialRef: 'google:chosen' }, PREAUTHORIZED_CALLER); failProvider = true;
  expect((await drainReindex(tenant, org, id))?.status).toBe('failed'); expect(calls).toHaveLength(1);
  const after = await getCollection(tenant, org, id, PREAUTHORIZED_CALLER); expect(after?.embeddingSpec).toEqual(before?.embeddingSpec); expect(after?.activeSignature).toEqual(before?.activeSignature); expect(after?.vectorSignature).toEqual(before?.vectorSignature);
  const found = await searchDetailed(tenant, org, id, 'KickTodo small daily actions', 6, 'hybrid', PREAUTHORIZED_CALLER); expect(found.hits).toHaveLength(1); expect(found.embedding.mode).toBe('local'); expect(calls).toHaveLength(1);
});
