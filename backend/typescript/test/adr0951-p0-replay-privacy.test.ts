/**
 * ADR 0951 P0 — the session-replay privacy machinery, built before anything can
 * record:
 *  - `analytics.replay` is a STRICT category: only a recorded explicit `true`
 *    permits — no toggle-off escape, no opt-out default, no `analytics` umbrella,
 *    and a visitor without a consent token is always refused;
 *  - withdrawing it deletes the recordings already made (blobs AND index rows);
 *  - the DSAR eraser `eraseSubjectReplays` is registered at boot and reaches a
 *    recording through either identity (consented subject or session key);
 *  - retention: the 30-day default window holds on a default posture, legal
 *    holds are honoured, and the governance purger never keeps a recording
 *    LONGER than the default;
 *  - storage: the process-local memory blob is "not configured" (dev allowance
 *    refused in production), chunks sit under a reserved host root a tenant's
 *    own blob surface cannot list, and tenant teardown deletes them;
 *  - `host:analytics:replay` is admin/owner only and never a custom-role scope;
 *  - the public posture offers the recording choice only where replay can run,
 *    and the settings read says "not configured" without storage.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  isAllowed, mergeConsentCategories, recordConsent, setPolicy, partialCategories, STRICT_EXPLICIT_OPT_IN, CONSENT_CATEGORIES,
} from '../src/features/consent/consentService.js';
import { visitorReplayAllowed } from '../src/features/consent/visitorConsent.js';
import {
  putReplayChunk, getReplaySession, eraseSubjectReplays, sweepExpiredReplays, replayStorageStatus, replayChunkPrefix,
  __resetReplayStoreForTests, REPLAY_DEFAULT_RETENTION_DAYS, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { eraseSubject, registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import { EXPECTED_SUBJECT_ERASERS } from '../src/host/subjectEraserManifest.js';
import { purgeRetained, runDefaultWindowSweeps } from '../src/host/retentionPurger.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { BUILT_IN_ROLES, MANAGEMENT_SCOPES, isProtocolScope } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default for ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('analytics', 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  delete process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB;
  await __resetReplayStoreForTests();
  for (const id of ['consent', 'analytics.session-replay', 'analytics.heatmaps']) await setToggle(id, 'off');
});

let seq = 0;
const T = () => `t-0951-${Date.now()}-${seq++}`;
const allowMemoryBlob = () => { process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true'; };

function row(tenantId: string, over: Partial<ReplaySession> = {}): ReplaySession {
  const now = new Date().toISOString();
  return {
    tenantId, orgId: 'org-a', sessionId: `s-${seq++}`, subjectKey: 'visitor:abc', pageIds: ['p1'],
    startedAt: now, updatedAt: now, durationMs: 1000, bytes: 10, chunkCount: 1, flags: {}, ...over,
  };
}
const CHUNK = Buffer.from('masked-chunk').toString('base64');
async function record(r: ReplaySession, chunks = 2): Promise<void> {
  for (let i = 0; i < chunks; i++) await putReplayChunk(r, i, CHUNK);
}
async function chunkKeys(r: ReplaySession): Promise<string[]> {
  const blob = buildHostSurfaceBundle({ tenantId: '__openwop_session_replay__' }).storage.blob;
  const out = (await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) })) as { entries: Array<{ key: string }> };
  return out.entries.map((e) => e.key);
}

describe('ADR 0951 D1 — analytics.replay is a strict explicit opt-in', () => {
  it('is a recordable category in the strict set', () => {
    expect(CONSENT_CATEGORIES).toContain('analytics.replay');
    expect(STRICT_EXPLICIT_OPT_IN.has('analytics.replay')).toBe(true);
    expect(partialCategories({ 'analytics.replay': true })).toEqual({ 'analytics.replay': true });
    expect(partialCategories({ 'analytics.replay': 'yes' })).toEqual({});
  });

  it('the consent toggle OFF does NOT permit it (no permissive escape)', async () => {
    const t = T();
    expect(await isAllowed(t, 'visitor:x', 'analytics')).toBe(true); // the escape exists for analytics…
    expect(await isAllowed(t, 'visitor:x', 'analytics.replay')).toBe(false); // …and not for replay
  });

  it('opt-out default and the analytics grant do not permit it; only an explicit true does', async () => {
    await setToggle('consent', 'on');
    const t = T();
    await setPolicy(t, { defaultMode: 'opt-out' });
    expect(await isAllowed(t, 'visitor:x', 'analytics.replay')).toBe(false);
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:x', categories: { analytics: true }, source: 'test' });
    expect(await isAllowed(t, 'visitor:x', 'analytics')).toBe(true);
    expect(await isAllowed(t, 'visitor:x', 'analytics.replay')).toBe(false);
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:x', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    expect(await isAllowed(t, 'visitor:x', 'analytics.replay')).toBe(true);
  });

  it('only the visitor can GRANT it: a workflow, form or operator write may refuse but never grant', async () => {
    await setToggle('consent', 'on');
    const t = T();
    await expect(mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:g', categories: { 'analytics.replay': true }, source: 'workflow:run-1' }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
    await expect(recordConsent({ tenantId: t, subjectKey: 'visitor:g', categories: { analytics: true, 'analytics.replay': true }, source: 'form-optin:f1' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(await isAllowed(t, 'visitor:g', 'analytics.replay')).toBe(false);
    // The visitor grants it; a later operator write carrying other changes is fine,
    // and a refusal from any source is accepted.
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:g', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:g', categories: { marketing: false }, source: 'workflow:run-2' });
    expect(await isAllowed(t, 'visitor:g', 'analytics.replay')).toBe(true);
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:g', categories: { 'analytics.replay': false }, source: 'workflow:run-3' });
    expect(await isAllowed(t, 'visitor:g', 'analytics.replay')).toBe(false);
  });

  it('a visitor with no consent token is refused even after a grant on the session key', async () => {
    await setToggle('consent', 'on');
    const t = T();
    await mergeConsentCategories({ tenantId: t, subjectKey: 'vk-1', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    expect(await visitorReplayAllowed(t, 'vk-1', { tokenSubject: undefined, region: null })).toBe(false);
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:tok', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    expect(await visitorReplayAllowed(t, 'vk-1', { tokenSubject: 'visitor:tok', region: null })).toBe(true);
  });
});

describe('ADR 0951 D4 — withdrawal deletes existing recordings', () => {
  it('true → false deletes the subject\'s blobs and index rows; other subjects keep theirs', async () => {
    allowMemoryBlob();
    await setToggle('consent', 'on');
    const t = T();
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:w', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    const mine = row(t, { subjectKey: 'visitor:w' });
    const other = row(t, { subjectKey: 'visitor:other' });
    await record(mine); await record(other);
    expect(await chunkKeys(mine)).toHaveLength(2);

    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:w', categories: { 'analytics.replay': false }, source: 'test' });
    expect(await getReplaySession(t, mine.orgId, mine.sessionId)).toBeNull();
    expect(await chunkKeys(mine)).toEqual([]);
    expect(await getReplaySession(t, other.orgId, other.sessionId)).not.toBeNull();
    expect(await chunkKeys(other)).toHaveLength(2);
  });

  it('a wholesale write that drops the grant also withdraws (strict: absent is not true)', async () => {
    allowMemoryBlob();
    await setToggle('consent', 'on');
    const t = T();
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:r', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    const r = row(t, { subjectKey: 'visitor:r' });
    await record(r);
    await recordConsent({ tenantId: t, subjectKey: 'visitor:r', categories: { analytics: true }, source: 'test' });
    expect(await getReplaySession(t, r.orgId, r.sessionId)).toBeNull();
  });

  it('an unrelated write while granted keeps the recordings', async () => {
    allowMemoryBlob();
    await setToggle('consent', 'on');
    const t = T();
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:k', categories: { 'analytics.replay': true }, source: 'public:org-test' });
    const r = row(t, { subjectKey: 'visitor:k' });
    await record(r);
    await mergeConsentCategories({ tenantId: t, subjectKey: 'visitor:k', categories: { marketing: false }, source: 'test' });
    expect(await getReplaySession(t, r.orgId, r.sessionId)).not.toBeNull();
  });
});

describe('ADR 0951 D4 — DSAR erasure', () => {
  it('eraseSubjectReplays is in the manifest AND registered by a real boot', () => {
    expect(EXPECTED_SUBJECT_ERASERS.has('eraseSubjectReplays')).toBe(true);
    expect(registeredSubjectEraserIds()).toContain('eraseSubjectReplays');
  });

  it('eraseSubject reaches a recording by the consented subject and by the session key', async () => {
    allowMemoryBlob();
    const t = T();
    const a = row(t, { subjectKey: 'visitor:d1' });
    const b = row(t, { subjectKey: 'visitor:d2', sessionKey: 'vk-d2' });
    await record(a); await record(b);
    const r1 = await eraseSubject(t, 'visitor:d1');
    expect(r1.failedFeatures ?? []).not.toContain('eraseSubjectReplays');
    expect(await getReplaySession(t, a.orgId, a.sessionId)).toBeNull();
    expect(await chunkKeys(a)).toEqual([]);
    await eraseSubjectReplays(t, 'vk-d2');
    expect(await getReplaySession(t, b.orgId, b.sessionId)).toBeNull();
  });

  it('never crosses tenants', async () => {
    allowMemoryBlob();
    const t1 = T(); const t2 = T();
    const r2 = row(t2, { subjectKey: 'visitor:same' });
    await record(r2);
    await eraseSubjectReplays(t1, 'visitor:same');
    expect(await getReplaySession(t2, r2.orgId, r2.sessionId)).not.toBeNull();
  });

  it('a recording whose chunks cannot be deleted fails the erasure (no success over remaining content)', async () => {
    allowMemoryBlob();
    const t = T();
    const r = row(t, { subjectKey: 'visitor:stuck' });
    await record(r);
    delete process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB; // storage now "not configured": chunks unreachable
    await expect(eraseSubjectReplays(t, 'visitor:stuck')).rejects.toThrow(/not deleted/);
    allowMemoryBlob();
    expect(await getReplaySession(t, r.orgId, r.sessionId), 'the row stays so a retry finds it').not.toBeNull();
  });
});

describe('ADR 0951 D3/D4 — retention', () => {
  const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  it('the default window deletes recordings older than 30 days on a default posture', async () => {
    allowMemoryBlob();
    const t = T();
    const stale = row(t, { updatedAt: old(REPLAY_DEFAULT_RETENTION_DAYS + 1) });
    const fresh = row(t, { updatedAt: old(1) });
    await record(stale); await record(fresh);
    const results = await runDefaultWindowSweeps();
    expect(results.find((r) => r.feature === 'analytics-replay')?.ok).toBe(true);
    expect(await getReplaySession(t, stale.orgId, stale.sessionId)).toBeNull();
    expect(await chunkKeys(stale)).toEqual([]);
    expect(await getReplaySession(t, fresh.orgId, fresh.sessionId)).not.toBeNull();
  });

  it('a legal hold keeps the tenant\'s recordings', async () => {
    allowMemoryBlob();
    const t = T();
    const stale = row(t, { updatedAt: old(40) });
    await record(stale);
    await setRetentionHold(t, 'litigation');
    try {
      await sweepExpiredReplays();
      expect(await getReplaySession(t, stale.orgId, stale.sessionId)).not.toBeNull();
    } finally { await clearRetentionHold(t); }
  });

  it('the governance purger never keeps a recording longer than the default (stricter cutoff wins)', async () => {
    allowMemoryBlob();
    const t = T();
    const r = row(t, { updatedAt: old(35) });
    await record(r);
    // A 365-day tenant window would keep it; the replay default still removes it.
    const results = await purgeRetained(t, 'confidential-pii', old(365));
    expect(results.find((x) => x.feature === 'analytics-replay')).toMatchObject({ ok: true, deleted: 1 });
    expect(await getReplaySession(t, r.orgId, r.sessionId)).toBeNull();
  });
});

describe('ADR 0951 D1/D3 — storage', () => {
  it('the memory blob is "not configured"; the dev allowance is refused in production', () => {
    expect(replayStorageStatus()).toEqual({ configured: false, reason: 'memory_backend' });
    allowMemoryBlob();
    expect(replayStorageStatus().configured).toBe(true);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(replayStorageStatus()).toEqual({ configured: false, reason: 'memory_backend' }); }
    finally { process.env.NODE_ENV = prev; }
  });

  it('nothing can be stored without configured storage', async () => {
    await expect(putReplayChunk(row(T()), 0, CHUNK)).rejects.toThrow(/not configured/);
  });

  it('chunks live under the reserved host root — the tenant\'s own blob surface cannot list them', async () => {
    allowMemoryBlob();
    const t = T();
    const r = row(t);
    await record(r);
    const tenantBlob = buildHostSurfaceBundle({ tenantId: t }).storage.blob;
    const listed = (await tenantBlob.list({ prefix: '' })) as { entries: unknown[] };
    expect(listed.entries).toEqual([]);
    expect(await chunkKeys(r)).toHaveLength(2);
  });

  it('tenant teardown deletes the chunks, not only the index rows', async () => {
    allowMemoryBlob();
    const t = T();
    const r = row(t);
    await record(r);
    await purgeTenantHostExt(t);
    expect(await chunkKeys(r)).toEqual([]);
    expect(await getReplaySession(t, r.orgId, r.sessionId)).toBeNull();
  });
});

describe('ADR 0951 D4 — host:analytics:replay', () => {
  it('is a management scope held by admin and owner only, never a custom-role scope', () => {
    expect(MANAGEMENT_SCOPES).toContain('host:analytics:replay');
    expect(isProtocolScope('host:analytics:replay')).toBe(false);
    expect(BUILT_IN_ROLES.owner.scopes).toContain('host:analytics:replay');
    expect(BUILT_IN_ROLES.admin.scopes).toContain('host:analytics:replay');
    expect(BUILT_IN_ROLES.editor.scopes).not.toContain('host:analytics:replay');
    expect(BUILT_IN_ROLES.viewer.scopes).not.toContain('host:analytics:replay');
  });
});

// ───────────────────────── routes ───────────────────────────────────────────

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
async function ownerWithOrg() {
  const owner = client();
  const su = await owner.post<{ user?: { tenantId?: string } }>('/host/openwop-app/test/login', { email: `r0951-${Date.now()}-${seq++}@acme.test` });
  expect(su.status).toBe(201);
  const org = await owner.post<{ orgId: string; tenantId?: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId };
}
interface Settings { heatmaps: { enabled: boolean }; replay: { enabled: boolean; storageConfigured: boolean; consentEnabled: boolean; available: boolean; retentionDays: number } }

describe('ADR 0951 P0 routes', () => {
  it('settings say "not configured" without blob storage, even with replay ON', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setToggle('analytics.session-replay', 'on');
    await setToggle('consent', 'on');
    const s = await owner.get<Settings>(`/host/openwop-app/analytics/orgs/${orgId}/behavior/settings`);
    expect(s.status).toBe(200);
    expect(s.body.replay).toMatchObject({ enabled: true, storageConfigured: false, consentEnabled: true, available: false, retentionDays: 30 });
    allowMemoryBlob();
    const s2 = await owner.get<Settings>(`/host/openwop-app/analytics/orgs/${orgId}/behavior/settings`);
    expect(s2.body.replay).toMatchObject({ storageConfigured: true, available: false });
  });

  it('settings are member-only (uniform 404/403 for an outsider)', async () => {
    const { orgId } = await ownerWithOrg();
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `x-${Date.now()}@evil.test` });
    const s = await stranger.get(`/host/openwop-app/analytics/orgs/${orgId}/behavior/settings`);
    expect([403, 404]).toContain(s.status);
  });

  it('the public posture never offers recording before a recorder is installed, even with storage and its toggle on', async () => {
    const { orgId } = await ownerWithOrg();
    await setToggle('consent', 'on');
    const pub = client();
    const off = await pub.get<{ regime: string; choices?: string[] }>(`/host/openwop-app/public-consent/${orgId}/posture`);
    expect(off.status).toBe(200);
    expect(off.body, 'nothing offered ⇒ the ADR 0860 regime-only shape').toEqual({ regime: expect.any(String) });
    await setToggle('analytics.session-replay', 'on');
    const noStorage = await pub.get<{ choices?: string[] }>(`/host/openwop-app/public-consent/${orgId}/posture`);
    expect(noStorage.body.choices, 'no storage ⇒ not offered').toBeUndefined();
    allowMemoryBlob();
    const on = await pub.get<{ choices: string[] }>(`/host/openwop-app/public-consent/${orgId}/posture`);
    expect(on.body.choices).toBeUndefined();
  });

  it('a public capture of analytics.replay is recorded under the minted visitor subject', async () => {
    const { orgId } = await ownerWithOrg();
    await setToggle('consent', 'on');
    const pub = client();
    const r = await pub.post<{ subjectToken: string; categories: Record<string, boolean> }>(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true, 'analytics.replay': true } });
    expect(r.status).toBe(201);
    expect(r.body.categories['analytics.replay']).toBe(true);
    const read = await pub.get<{ categories: Record<string, boolean> }>(`/host/openwop-app/public-consent/${orgId}/${r.body.subjectToken}`);
    expect(read.body.categories['analytics.replay']).toBe(true);
  });
});
