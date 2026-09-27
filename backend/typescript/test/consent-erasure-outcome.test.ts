/**
 * CONS-G1 (docs/steward/UX_UPGRADE-consent.md) — a partially-failed GDPR erasure must NOT
 * report success.
 *
 * `eraseSubject` has always returned `{ total, failed, keysResolved }`, and its
 * docblock describes the shape in terms of "the caller's `failed > 0` reaction".
 * There was no reaction: `deleteSubject` discarded it and the route hard-coded
 * `ok: true`, so a fan-out in which N feature erasers threw — leaving the
 * subject's data in place — was indistinguishable from a clean erasure all the
 * way up to a green toast. Under GDPR Art. 5(2) the controller must be able to
 * demonstrate the erasure; being told it happened when it didn't is worse than
 * being told nothing.
 */

import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import {
  registerSubjectEraser,
  __resetSubjectErasers,
  __resetSubjectKeyResolvers,
  registerSubjectKeyResolver,
} from '../src/host/subjectErasure.js';

const T = 't-erasure-outcome';

describe('consent deleteSubject — erasure outcome', () => {
  // Scoped to THIS describe: it swaps in a private storage and empties the
  // eraser registry, which would otherwise pull the booted app out from under
  // the route suite below (that is exactly how it failed the first time).
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    // A bare registry: these cases assert the COUNTS, so the real
    // boot-registered erasers would make `total` a moving target.
    __resetSubjectErasers();
    __resetSubjectKeyResolvers();
  });
  afterEach(() => {
    __resetSubjectErasers();
    __resetSubjectKeyResolvers();
  });

  it('reports a clean fan-out: every eraser ran, none failed', async () => {
    // WF-CONS-2 — synthetic erasers must be NAMED now: `fn.name` is both the
    // operator-facing label in `failedFeatures` and the expected-set manifest's
    // key, so an anonymous one is unreportable and manifest-invisible.
    registerSubjectEraser(async function ok1() {});
    registerSubjectEraser(async function ok2() {});
    const r = await deleteSubject(T, 'subj-clean');
    expect(r.erasure.total).toBe(2);
    expect(r.erasure.failed).toBe(0);
    expect(r.erasure.keysResolved).toBe(1);
  });

  it('reports the FAILURE COUNT when erasers throw — the subject data is still there', async () => {
    registerSubjectEraser(async function ok1() {});
    registerSubjectEraser(async function down1() { throw new Error('store down'); });
    registerSubjectEraser(async function down2() { throw new Error('also down'); });
    const r = await deleteSubject(T, 'subj-partial');
    expect(r.erasure.total).toBe(3);
    // Two feature stores STILL hold this person's data. Anything that renders
    // this as "erased" is telling the operator a legal obligation was met.
    expect(r.erasure.failed).toBe(2);
  });

  it('a failing eraser does not stop the others (best-effort fan-out is preserved)', async () => {
    const ran: string[] = [];
    registerSubjectEraser(async function eraserA() { ran.push('a'); });
    registerSubjectEraser(async function eraserB() { throw new Error('boom'); });
    registerSubjectEraser(async function eraserC() { ran.push('c'); });
    const r = await deleteSubject(T, 'subj-continues');
    expect(ran).toEqual(['a', 'c']);
    expect(r.erasure.failed).toBe(1);
  });

  it('counts the LINKED identity keys the subject expanded to (ADR 0381)', async () => {
    registerSubjectKeyResolver(async () => ['linked-contact-1', 'linked-session-2']);
    const seen: string[] = [];
    registerSubjectEraser(async function seenEraser(_t, key) { seen.push(key); });
    const r = await deleteSubject(T, 'subj-linked');
    // The bare key plus both linked keys — one person, three identity spaces.
    expect(r.erasure.keysResolved).toBe(3);
    expect(new Set(seen)).toEqual(new Set(['subj-linked', 'linked-contact-1', 'linked-session-2']));
  });

  it('counts DISTINCT failing erasers, not one per linked key', async () => {
    registerSubjectKeyResolver(async () => ['k2', 'k3']);
    registerSubjectEraser(async function alwaysDown() { throw new Error('down for every key'); });
    const r = await deleteSubject(T, 'subj-multi');
    expect(r.erasure.keysResolved).toBe(3);
    // One broken store is ONE failure, however many keys it was tried with —
    // otherwise the number an operator reads would be an artefact of how many
    // identity spaces the person happened to span.
    expect(r.erasure.total).toBe(1);
    expect(r.erasure.failed).toBe(1);
  });
});

/**
 * The same honesty, at the wire. `ok` used to be hard-coded `true`; it now
 * reports whether the ERASURE completed. The status stays 200 — the request was
 * accepted and is idempotently retryable, and a partial erasure is a reportable
 * outcome, not a transport error.
 */
describe('DELETE …/subjects/:key — `ok` reports the erasure, not the request', () => {
  let BASE: string;
  let server: import('node:http').Server;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['users', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function ownerClient(): Promise<{ call: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }>; orgId: string }> {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of typeof h.getSetCookie === 'function' ? h.getSetCookie() : []) {
        const m = /(__session=[^;]+)/.exec(c);
        if (m) cookie = m[1];
      }
      return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
    };
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `ce-${Date.now()}@acme.test`, tenantId: 'default' });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Erasure Co' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    return { call, orgId: org.body.org?.orgId ?? org.body.orgId };
  }

  it('ok:false — and the failure count — when a feature eraser throws', async () => {
    const { call, orgId } = await ownerClient();
    // Additive: the app's real erasers stay registered, so this proves the route
    // reports a failure that occurs ALONGSIDE working erasers, not in a vacuum.
    registerSubjectEraser(async function unavailableStore() { throw new Error('feature store unavailable'); });

    const del = await call('DELETE', `/v1/host/openwop-app/consent/orgs/${orgId}/subjects/nobody-here`);
    // Still 200 — accepted, idempotent, retryable …
    expect(del.status).toBe(200);
    // … but NOT ok. This is the assertion the old hard-coded `ok: true` made
    // impossible, and the reason an operator could be told a DSAR was complete
    // while the data was still sitting in a feature store.
    expect(del.body.ok).toBe(false);
    expect(del.body.erasure.failed).toBeGreaterThanOrEqual(1);
    expect(del.body.erasure.total).toBeGreaterThanOrEqual(del.body.erasure.failed);
  });
});
