/**
 * ADR 0496 D2 — the revision-commands / revision-preview HTTP boundary:
 *  - non-owner → 404 (the sibling no-existence-leak posture, architect H3),
 *    never the service's 403;
 *  - preview is a PURE read (nothing mutates) and refuses exactly what apply
 *    refuses (same code, same failing index) — the compare can never paint a
 *    move the apply path would bounce;
 *  - a valid move applies end-to-end through the route (override stored,
 *    revision bumped).
 *
 * Sabotage witnesses (w41 /grade-tests): removing either route's owner guard
 * (the service then answers 403), making the preview route apply, or dropping
 * the past-date window guard each turn a case red. Service-level twins of the
 * window/parity claims live in kicktodo-replan.test.ts; THIS file owns the HTTP
 * mapping (404 vs 403, 409 + details.failedIndex).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensurePersonalWorkspace } from '../src/host/accessControlService.js';

/** Typed JSON body without a cast: `JSON.parse` returns `any`, so the call
 *  site names the narrow wire shape it reads (no `as`). */
async function body<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text());
}

let BASE: string;
let server: http.Server;

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p: string) => send('GET', p),
    post: (p: string, b?: unknown) => send('POST', p, b),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
      // USERS-19 (ADR 0617 D2): a deployment-named tenant is NOT a personal
      // shape, so the collapsed `personalTenant === tenantId` cookie no longer
      // grants implicit ownership — the seam founds + owns a tenant only for its
      // FIRST login, and later subjects here relied on the (SAML-shaped)
      // implicit-owner hole. Seat each subject as an explicit owner MEMBER
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for the first login), so authority is membership-derived.
      const { user } = await body<{ user: { userId: string } }>(res.clone());
      await ensurePersonalWorkspace({ tenantId, ownerSubject: user.userId, name: `Test workspace ${tenantId}` });
    },
  };
}

const B = '/host/openwop-app/kicktodo';
const TENANT = 'tenant-kt-move-routes';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr: AddressInfo | string | null = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server has no TCP address');
      BASE = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  for (const id of ['users', 'kicktodo-core']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const isoShift = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** 5-day challenge with a day-3 activity, enrolled for the caller. */
async function setupEnrollment(c: ReturnType<typeof client>): Promise<string> {
  const draft = await body<{ id: string }>(await c.post(`${B}/challenges`, {
    title: 'Move routes', summary: 's', outcome: 'o', durationDays: 5,
    activities: [
      { stableActivityId: 'a1', day: 1, title: 'First', instructions: '', evidencePolicy: 'attestation' },
      { stableActivityId: 'a3', day: 3, title: 'Third', instructions: '', evidencePolicy: 'attestation' },
    ],
  }));
  await c.post(`${B}/challenges/${draft.id}/versions/1/publish`);
  const e = await body<{ id: string }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' }));
  return e.id;
}

describe('revision-commands / revision-preview routes (ADR 0496 D2)', () => {
  it('non-owner → 404 on BOTH routes (no existence leak); owner previews then applies a move', async () => {
    const owner = client();
    await owner.login('user:mv-owner', TENANT);
    const enrollmentId = await setupEnrollment(owner);
    const toDate = isoShift(6);

    const intruder = client();
    await intruder.login('user:mv-intruder', TENANT);
    for (const path of ['revision-commands', 'revision-preview']) {
      const r = await intruder.post(`${B}/enrollments/${enrollmentId}/${path}`, { commands: [] });
      // The ROUTE's uniform 404 — without it the service would answer 403 'Not your enrollment.'.
      expect(r.status).toBe(404);
      expect((await body<{ message?: string }>(r)).message).toBe('Enrollment not found.');
    }

    // Preview: pure read with before/after dates.
    const pv = await owner.post(`${B}/enrollments/${enrollmentId}/revision-preview`, {
      commands: [{ lane: 'move', day: 3, toDate }],
    });
    expect(pv.status).toBe(200);
    const { changes } = await body<{ changes: Array<{ lane: string; day: number; fromDate: string; toDate: string }> }>(pv);
    expect(changes[0]).toMatchObject({ lane: 'move', day: 3, toDate });
    expect(changes[0]!.fromDate).not.toBe(toDate);
    // Nothing mutated by the preview.
    const before = await body<{ planRevision: number; schedulePreference?: { dayOverrides?: unknown } }>(await owner.get(`${B}/enrollments/${enrollmentId}`));
    expect(before.schedulePreference?.dayOverrides).toBeUndefined();

    // Apply through the route.
    const ap = await owner.post(`${B}/enrollments/${enrollmentId}/revision-commands`, {
      commands: [{ lane: 'move', day: 3, toDate }],
    });
    expect(ap.status).toBe(200);
    const after = await body<{ planRevision: number; schedulePreference?: { dayOverrides?: Record<string, string> } }>(await owner.get(`${B}/enrollments/${enrollmentId}`));
    expect(after.schedulePreference?.dayOverrides).toEqual({ '3': toDate });
    expect(after.planRevision).toBe(before.planRevision + 1);
  });

  it('preview and apply refuse the same bad command with the same shape (window refusal, failedIndex 0)', async () => {
    const owner = client();
    await owner.login('user:mv-parity', TENANT);
    const enrollmentId = await setupEnrollment(owner);
    const bad = { commands: [{ lane: 'move', day: 3, toDate: isoShift(-2) }] };
    const pv = await owner.post(`${B}/enrollments/${enrollmentId}/revision-preview`, bad);
    const ap = await owner.post(`${B}/enrollments/${enrollmentId}/revision-commands`, bad);
    expect(pv.status).toBe(409);
    expect(ap.status).toBe(409);
    type Refusal = { error?: string; message?: string; details?: { failedIndex?: number } };
    const pvBody = await body<Refusal>(pv);
    const apBody = await body<Refusal>(ap);
    expect(pvBody.details?.failedIndex).toBe(0);
    expect(apBody.details?.failedIndex).toBe(0);
    // Same code, and both name the window guard (the shared assertDayMoveAllowed).
    expect(pvBody.error).toBeTruthy();
    expect(pvBody.error).toBe(apBody.error);
    expect(pvBody.message).toContain('window');
    expect(apBody.message).toContain('window');
    // The refused apply changed nothing.
    const after = await body<{ planRevision: number; schedulePreference?: { dayOverrides?: unknown } }>(await owner.get(`${B}/enrollments/${enrollmentId}`));
    expect(after.planRevision).toBe(1);
    expect(after.schedulePreference?.dayOverrides).toBeUndefined();
  });
});
