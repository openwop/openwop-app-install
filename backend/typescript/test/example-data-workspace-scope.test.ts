/**
 * ADR 0292 (`0292-resilient-example-data-seeding`) §Correction 2026-11-07 + ADR 0321
 * (`0321-demo-provision-idempotency-and-seed-lock`): a seed write is bound to the
 * workspace the caller INTENDED. `expectedTenantId` is an assertion only; the
 * session's real tenant (OIDC bearer + `__session` cookie, never the body) stays the
 * authority. Guard: `requireExpectedSeedTenant` in `src/routes/agentOps.ts`, called by
 * `run`, `clear`, `provision-demo` and the legacy `seed` BEFORE the seed-lock CAS, the
 * NDJSON header flush and any seeder. A missing/empty/non-string assertion is a 400
 * `example_data_workspace_required`; a mismatch is a 409 `example_data_workspace_mismatch`
 * answered as JSON. The read-only dry-run preview needs no assertion and writes nothing;
 * `provision-demo` keeps its superadmin 403 first.
 *
 * Real HTTP through `createApp` (the claim is the route wiring + middleware tenant
 * resolution), a local RS256 JWKS issuer, `memory://` storage.
 *
 * Sabotage-witnessed (w94 probes): mismatch check `if (false)` reds cases 1–2; dropping the
 * empty-string half reds the `''` row; moving the check inside `withSeedLock` (run) or after
 * `provisionDemoFeatures` reds the CAS spy rows; dropping the call from `seed` / `clear`
 * reds their rows; gating the dry-run on the assertion, seeding on a "dry run", or removing
 * `requireSuperadmin` reds case 5; `wantsStream → false` reds case 4.
 */
import http from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { deleteConfig, getStoredConfig, saveConfig } from '../src/host/featureToggles/service.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';

let base = '';
let issuer = '';
let privateKey: KeyObject;
let server: http.Server | undefined;
let storage: Storage;
let issuerServer: http.Server | undefined;
const ownedEnv = ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL', 'OPENWOP_SESSION_SECRET', 'OPENWOP_DEMO_SEED_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_BYOK_ENCRYPTION_KEY'] as const;
const priorEnv = new Map(ownedEnv.map((key) => [key, process.env[key]] as const));
async function closeOwned(server: http.Server | undefined): Promise<void> {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
let usersToggle: { saved: boolean; prior: ToggleConfig | null } = { saved: false, prior: null };
async function restoreUsersToggle(): Promise<void> {
  if (!usersToggle.saved) return;
  const { prior } = usersToggle;
  usersToggle = { saved: false, prior: null };
  if (prior) await saveConfig(prior, 'seed-scope-test-restore');
  else await deleteConfig('users', 'seed-scope-test-restore');
}
async function cleanup(): Promise<void> {
  try {
    try { await restoreUsersToggle(); } finally {
      try { await closeOwned(server); } finally { await closeOwned(issuerServer); }
    }
  } finally {
    for (const key of ownedEnv) {
      const previous = priorEnv.get(key);
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    _resetOidcVerifier();
    resetCachedMasterKey();
  }
}
const H = '/host/openwop-app';
const tour = 'walkthrough.campaign-studio.first-brief';
const chat = 'walkthrough.chat.first-message';
function token(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'scope-key', typ: 'JWT' })}.${encode({ iss: issuer, aud: 'seed-scope-test', sub, iat: now, exp: now + 300 })}`;
  return `${input}.${createSign('sha256').update(input).sign(privateKey).toString('base64url')}`;
}
interface ReplyBody { active?: string; workspaceId?: string; dryRun?: boolean; summary?: { created?: number; errors?: number }; details?: { reason?: string }; error?: string }
interface Reply { status: number; body: ReplyBody; contentType: string }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Narrow a parsed body to the fields these cases read; anything mistyped is dropped, never cast. */
function readBody(value: unknown): ReplyBody {
  if (!isRecord(value)) throw new Error(`Response body is not an object: ${JSON.stringify(value)}`);
  const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
  const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;
  const body: ReplyBody = {};
  const active = str(value.active); if (active !== undefined) body.active = active;
  const workspaceId = str(value.workspaceId); if (workspaceId !== undefined) body.workspaceId = workspaceId;
  const error = str(value.error); if (error !== undefined) body.error = error;
  if (typeof value.dryRun === 'boolean') body.dryRun = value.dryRun;
  if (isRecord(value.summary)) body.summary = { created: num(value.summary.created), errors: num(value.summary.errors) };
  if (isRecord(value.details)) body.details = { reason: str(value.details.reason) };
  return body;
}
function caller(bearer: string, useCookie = true) {
  let cookie = '';
  return async (path: string, body?: Record<string, unknown>, accept?: string): Promise<Reply> => {
    const response = await fetch(`${base}${H}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(accept ? { accept } : {}), ...(useCookie && cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const header of response.headers.getSetCookie()) {
      const match = /(__session=[^;]+)/.exec(header);
      if (match) cookie = match[1];
    }
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const bodyText = contentType.includes('application/x-ndjson') ? text.trim().split('\n')[0] : text;
    const parsed: unknown = JSON.parse(bodyText);
    return { status: response.status, body: readBody(parsed), contentType };
  };
}
beforeAll(async () => {
  try {
    process.env.OPENWOP_BYOK_ENCRYPTION_KEY = '42'.repeat(32); // Synthetic test-only key; never read disk material.
    resetCachedMasterKey();
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keys.privateKey;
    const app = express();
    app.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'scope-key', alg: 'RS256', use: 'sig' }] }));
    issuerServer = await new Promise<http.Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const address = issuerServer.address();
    if (!address || typeof address === 'string') throw new Error('Issuer did not bind');
    issuer = `http://127.0.0.1:${address.port}`;
    process.env.OPENWOP_OIDC_ISSUER = issuer;
    process.env.OPENWOP_OIDC_AUDIENCE = 'seed-scope-test';
    process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    process.env.OPENWOP_SESSION_SECRET = 'seed-scope-test-session-secret-at-least-32-characters';
    process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    _resetOidcVerifier();
    const host = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'seed-scope', serviceVersion: '0', enableConsoleTracer: false });
    storage = host.locals.storage as Storage;
    server = await new Promise<http.Server>((resolve) => { const listening = host.listen(0, '127.0.0.1', () => resolve(listening)); });
    const hostAddress = server.address();
    if (!hostAddress || typeof hostAddress === 'string') throw new Error('Host did not bind');
    base = `http://127.0.0.1:${hostAddress.port}`;
    const users = getToggleDefault('users');
    if (users) {
      usersToggle = { saved: true, prior: await getStoredConfig('users') };
      await saveConfig({ ...users, status: 'on' }, 'seed-scope-test');
    }
  } catch (error) {
    try { await cleanup(); } catch { /* Preserve the setup failure; teardown still restores env/cache. */ }
    throw error;
  }
});
afterAll(cleanup);

afterEach(() => vi.restoreAllMocks());

describe('seed workspace assertion before effects', () => {
  it('rejects the cookie-less Personal bearer on a QA-intended write, then seeds only QA with its real cookie', async () => {
    const bearer = token('seed-owner');
    const owner = caller(bearer);
    const home = (await owner('/me/workspaces')).body.active;
    if (!home) throw new Error('Personal host workspace is missing');
    const ws = (await owner('/workspaces', { name: 'Controlled seed workspace' })).body.workspaceId;
    if (!ws) throw new Error('Shared workspace was not created');
    expect((await owner(`/workspaces/${encodeURIComponent(ws)}/switch`, {})).status).toBe(200);
    expect((await owner('/me/workspaces')).body.active).toBe(ws);
    const direct = caller(bearer, false);
    const refusal = await direct('/example-data/run', { steps: ['demo-walkthroughs'], expectedTenantId: ws }, 'application/x-ndjson');
    expect(refusal.status).toBe(409);
    expect(refusal.body.details?.reason).toBe('example_data_workspace_mismatch');
    expect(refusal.contentType).toContain('application/json');
    expect(await getOwned(home, tour)).toBeNull();
    expect(await getOwned(ws, tour)).toBeNull();
    const seeded = await owner('/example-data/run', { steps: ['demo-walkthroughs'], expectedTenantId: ws });
    expect(seeded.status).toBe(200);
    expect(seeded.body.summary?.created).toBe(1); // one step (demo-walkthroughs) created; its two rows are checked below
    expect(await getOwned(ws, tour)).toMatchObject({ workflowId: tour });
    expect(await getOwned(ws, chat)).toMatchObject({ workflowId: chat });
    expect(await getOwned(home, tour)).toBeNull();
    const repeat = await owner('/example-data/run', { steps: ['demo-walkthroughs'], expectedTenantId: ws });
    expect(repeat.status).toBe(200);
    expect(repeat.body.summary?.created).toBe(0);
    expect(repeat.body.summary?.errors).toBe(0); // 0 created because present, not because every item failed
  });

  it.each(['run', 'clear', 'provision-demo', 'seed'])('refuses a mismatched scope before %s emits NDJSON or writes', async (path) => {
    const admin = caller('dev-token', false);
    const writes = vi.spyOn(storage, 'kvSet');
    const compareWrites = vi.spyOn(storage, 'kvCompareAndSwap');
    const refused = await admin(`/example-data/${path}`, { expectedTenantId: 'ws:foreign', steps: ['demo-walkthroughs'] }, 'application/x-ndjson');
    expect(refused.status).toBe(409);
    expect(refused.body.details?.reason).toBe('example_data_workspace_mismatch');
    expect(refused.contentType).toContain('application/json');
    expect(await getOwned('default', tour)).toBeNull();
    expect(await getOwned('ws:foreign', tour)).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(compareWrites).not.toHaveBeenCalled();
    writes.mockRestore();
    compareWrites.mockRestore();
  });

  it.each([undefined, '', 42])('requires an explicit nonempty opaque workspace assertion: %s', async (expectedTenantId) => {
    const refused = await caller('dev-token', false)('/example-data/run', { steps: ['demo-walkthroughs'], expectedTenantId });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_request');
    expect(refused.body.details?.reason).toBe('example_data_workspace_required');
    expect(await getOwned('default', tour)).toBeNull();
  });

  it('retains a correctly asserted Personal direct NDJSON seed', async () => {
    const personal = caller(token('personal-stream-owner'), false);
    const active = (await personal('/me/workspaces')).body.active;
    if (!active) throw new Error('Personal workspace was not resolved');
    const seeded = await personal('/example-data/run', { steps: ['demo-walkthroughs'], expectedTenantId: active }, 'application/x-ndjson');
    expect(seeded.status).toBe(200);
    expect(seeded.contentType).toContain('application/x-ndjson');
    expect(await getOwned(active, tour)).toMatchObject({ tenantId: active, workflowId: tour });
  });

  it('permits assertion-free read-only preview and retains the superadmin provisioning denial', async () => {
    const owner = caller(token('preview-owner'));
    const personal = (await owner('/me/workspaces')).body.active;
    if (!personal) throw new Error('Personal workspace was not resolved');
    const preview = await owner('/example-data/run', { steps: ['demo-walkthroughs'], dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(await getOwned(personal, tour)).toBeNull();
    expect(await getOwned(personal, chat)).toBeNull();
    const refusal = await owner('/example-data/provision-demo', { expectedTenantId: 'ws:foreign' });
    expect(refusal.status).toBe(403);
    expect(refusal.body.error).toBe('forbidden');
  });
});
