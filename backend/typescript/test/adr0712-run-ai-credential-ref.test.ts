/**
 * ADR 0712 — a run started over HTTP names its BYOK key with
 * `configurable.ai.credentialRef` (v1 `run-options.md`, v2 `runs.md`
 * §configurable), and the host honours it.
 *
 * Before: the field was schema-valid and IGNORED. `prepareRunSecrets` resolved
 * only `node.config.credentialRefs` / `configurable.credentialRefs` (the latter
 * not even a legal v2 key), so a run from the `/` picker reached its first AI
 * node with an empty secret set and died `byok_required_but_unresolved`
 * (ADR 0706 OQ5).
 *
 * Three legs, each observable only at its own boundary:
 *   1. the ladder's run rung (pure);
 *   2. the executor registers the ref into the run's secret set;
 *   3. the create + fork routes refuse a ref that is foreign, provider-less,
 *      managed or unresolvable with `403 credential_forbidden`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/index.js';
import { pickCredentialRef, refNamedProvider } from '../src/aiProviders/credentialRefLadder.js';
import { advertisedByokProviders, createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { declaredRunCredentialRefs, runAiCredentialRef } from '../src/host/runCredentials.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import { getRunSecrets } from '../src/byok/ephemeralRunSecrets.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

describe('ADR 0712 — the ladder run rung (pure)', () => {
  it('maps every host naming convention to its provider, and a provider-less name to none', () => {
    const ps = ['anthropic', 'openai', 'google'];
    expect(refNamedProvider('google', ps)).toBe('google');
    expect(refNamedProvider('google-work', ps)).toBe('google');
    expect(refNamedProvider('anthropic:prod', ps)).toBe('anthropic');
    expect(refNamedProvider('byok:google', ps), 'the BYOK wizard ref (ADR 0517 fix B)').toBe('google');
    expect(refNamedProvider('byok:openai:team', ps)).toBe('openai');
    expect(refNamedProvider('my-key', ps)).toBeNull();
    expect(refNamedProvider('googleish', ps), 'a prefix is not a provider').toBeNull();
    expect(refNamedProvider('byok:minimax', ps), 'a provider this host does not advertise as byok').toBeNull();
  });

  it('uses the run credential only for a node that names none, only for its own provider, only when registered', () => {
    const avail = ['google-old', 'byok:google'];
    expect(pickCredentialRef('google', undefined, avail, 'byok:google')).toEqual({ ref: 'byok:google', rung: 'run' });
    // Without the rung, first-match would have picked the OTHER google key.
    expect(pickCredentialRef('google', undefined, avail)).toEqual({ ref: 'google-old', rung: 'prefix' });
    expect(pickCredentialRef('google', 'google-old', avail, 'byok:google'), 'an explicit node ref wins').toEqual({ ref: 'google-old', rung: 'explicit' });
    expect(pickCredentialRef('anthropic', undefined, avail, 'byok:google'), 'never sent to another vendor').toEqual({ ref: null, reason: 'no_default_credential' });
    expect(pickCredentialRef('google', undefined, ['google-old'], 'byok:google'), 'an unregistered run ref falls through').toEqual({ ref: 'google-old', rung: 'prefix' });
  });

  it('declares the wire ref first, dedupes, and never declares a managed ref', () => {
    expect(declaredRunCredentialRefs({ ai: { credentialRef: 'byok:google' }, credentialRefs: ['google-old', 'byok:google'] }))
      .toEqual(['byok:google', 'google-old']);
    expect(declaredRunCredentialRefs({ ai: { credentialRef: 'managed:openwop-free' } })).toEqual([]);
    expect(runAiCredentialRef({ ai: { credentialRef: '' } })).toBeUndefined();
    expect(runAiCredentialRef({ 'ai.credentialRef': 'byok:google' }), 'a dotted key is not the field').toBeUndefined();
    expect(declaredRunCredentialRefs(undefined)).toEqual([]);
  });
});

describe('ADR 0712 — the adapter dispatches with the run credential', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a node that passes no ref sends the RUN key upstream, not the first-listed key for the provider', async () => {
    setInvocationBackend(await openStorage('memory://'));
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent.push(String(init?.headers?.['x-goog-api-key'] ?? ''));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const adapter = createAiProvidersAdapter({
      runId: `run-adr0712-${Math.random().toString(36).slice(2, 8)}`,
      nodeId: 'n1',
      tenantId: 'adr0712-tenant',
      attempt: 1,
      secrets: { 'google-old': 'key-first-listed', 'byok:google': 'key-the-run-named' },
      runCredentialRef: 'byok:google',
      policyResolver: { async resolveForRun() { return []; } },
    });
    await adapter.callAI({ provider: 'google', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
    expect(sent.length, 'the dispatch must reach fetch or the key assertion is vacuous').toBeGreaterThan(0);
    expect(sent.every((k) => k === 'key-the-run-named')).toBe(true);
  });
});

describe('ADR 0712 — the executor registers the run credential', () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    setRuntimeCapabilities([]);
    const dataDir = mkdtempSync(join(tmpdir(), 'adr0712-'));
    configureSecretResolver({ storage, dataDir });
    initInMemorySurfaces({ dataDir });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('registers ai.credentialRef beside credentialRefs[], and a node that names no ref dispatches with it', async () => {
    await setSecret('google-old', 'key-first-listed', { tenantId: 'demo' });
    await setSecret('byok:google', 'key-the-run-named', { tenantId: 'demo' });
    setInvocationBackend(storage);
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent.push(String(init?.headers?.['x-goog-api-key'] ?? ''));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const seen: string[][] = [];
    getNodeRegistry().register({
      typeId: 'test.adr0712.capture-secrets',
      version: '1.0.0',
      async execute(ctx) {
        seen.push(Object.keys(getRunSecrets(ctx.runId)));
        await ctx.callAI!({ provider: 'google', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
        return { status: 'success', outputs: {} };
      },
    });
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      workflowId: 'wf.test.adr0712',
      tenantId: 'demo',
      status: 'pending',
      inputs: {},
      metadata: {},
      // The host-set list names the OTHER google key first — without the run rung
      // the prefix ladder would pick it.
      configurable: { credentialRefs: ['google-old'], ai: { credentialRef: 'byok:google' } },
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertRun(run);
    const definition: WorkflowDefinition = {
      workflowId: 'wf.test.adr0712',
      nodes: [{ nodeId: 'n1', typeId: 'test.adr0712.capture-secrets' }],
    };
    const result = await executeRun(storage, run, definition, { policyResolver: { async resolveForRun() { return []; } } });
    expect(result.status).toBe('completed');
    expect(seen.map((k) => [...k].sort())).toEqual([['byok:google', 'google-old']]);
    expect(sent.length, 'the node must reach dispatch or the key assertion is vacuous').toBeGreaterThan(0);
    expect(sent.every((k) => k === 'key-the-run-named')).toBe(true);
  });
});

describe('ADR 0712 — create + fork refuse a ref the run may not use (HTTP)', () => {
  let server: Server;
  let base = '';
  const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
  const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  /** The tenant a bearer `dev-token` run is created under (`routes/runs.ts`:
   *  no body tenant, no session tenant ⇒ `default`). The byok HTTP route stores a
   *  bearer caller's key HOST-GLOBAL instead, so it cannot seed this tenant. */
  const RUN_TENANT = 'default';
  async function storeKey(credentialRef: string): Promise<void> {
    await setSecret(credentialRef, `value-for-${credentialRef}`, { tenantId: RUN_TENANT });
  }

  async function createV1(configurable: Record<string, unknown>): Promise<{ status: number; code: string; runId?: string }> {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { message: 'adr0712' }, configurable }),
    });
    const body = await res.json() as { runId?: string; error?: unknown; code?: unknown };
    return { status: res.status, code: errorCode(body), ...(body.runId ? { runId: body.runId } : {}) };
  }

  function errorCode(body: { error?: unknown; code?: unknown }): string {
    return typeof body.error === 'string' ? body.error
      : typeof (body.error as { code?: unknown } | undefined)?.code === 'string' ? String((body.error as { code: string }).code)
      : String(body.code ?? '');
  }

  it('the check reads the SAME list discovery advertises as aiProviders.byok', async () => {
    const res = await fetch(`${base}/.well-known/openwop`);
    const doc = await res.json() as { aiProviders?: { byok?: string[] } };
    expect(doc.aiProviders?.byok).toEqual(advertisedByokProviders());
  });

  it('accepts a ref of an advertised provider stored in the caller\'s own vault (v1)', async () => {
    await storeKey('byok:google');
    const res = await createV1({ ai: { credentialRef: 'byok:google' } });
    expect(res.status).toBe(201);
  });

  it('accepts the same field under v2, inside the closed versioned configurable', async () => {
    await storeKey('anthropic:adr0712');
    const res = await fetch(`${base}/runs`, {
      method: 'POST', headers: V2,
      body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { message: 'adr0712' }, configurable: { version: 1, ai: { credentialRef: 'anthropic:adr0712' } } }),
    });
    expect(res.status).toBe(201);
  });

  it('refuses another tenant\'s key exactly like a key that does not exist — no existence probe', async () => {
    await setSecret('openai:other-tenant-only', 'sk-other', { tenantId: 'adr0712-other-tenant' });
    const foreign = await createV1({ ai: { credentialRef: 'openai:other-tenant-only' } });
    const missing = await createV1({ ai: { credentialRef: 'openai:never-stored' } });
    expect(foreign.status).toBe(403);
    expect(foreign.code).toContain('credential_forbidden');
    expect(missing.status).toBe(403);
    expect(missing.code).toBe(foreign.code);
  });

  it('refuses a stored key whose name carries no advertised provider', async () => {
    await storeKey('my-key');
    const res = await createV1({ ai: { credentialRef: 'my-key' } });
    expect(res.status).toBe(403);
    expect(res.code).toContain('credential_forbidden');
  });

  it('refuses a managed ref and an empty ref — neither is a BYOK credential', async () => {
    expect((await createV1({ ai: { credentialRef: 'managed:openwop-free' } })).status).toBe(403);
    expect((await createV1({ ai: { credentialRef: '' } })).status).toBe(403);
  });

  it('checks a branch fork\'s overlay the same way, and the ref never reaches the event stream', async () => {
    await storeKey('google:fork-src');
    const created = await createV1({ ai: { credentialRef: 'google:fork-src' } });
    expect(created.status).toBe(201);
    const runId = created.runId!;
    // Let the uppercase run finish so a fork point exists.
    let events: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      const poll = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/events/poll?lastSequence=0&timeout=1`, { headers: AUTH });
      const body = await poll.json() as { events?: unknown[]; isComplete?: boolean };
      events = body.events ?? events;
      if (body.isComplete) break;
    }
    expect(events.length, 'the run must have produced events or the echo assertion is vacuous').toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('google:fork-src');

    const fork = async (overlay: Record<string, unknown>): Promise<number> => (await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}:fork`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ mode: 'branch', fromSeq: 0, runOptionsOverlay: overlay }),
    })).status;
    expect(await fork({ ai: { credentialRef: 'openai:other-tenant-only' } })).toBe(403);
    expect(await fork({ ai: { credentialRef: 'google:fork-src' } })).not.toBe(403);
  });
});
