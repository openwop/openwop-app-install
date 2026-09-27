/**
 * ADR 0496 D2 — the revision-commands / revision-preview HTTP boundary:
 *  - non-owner → 404 (the sibling no-existence-leak posture, architect H3),
 *    never the service's 403;
 *  - preview is a PURE read (nothing mutates) and refuses exactly what apply
 *    refuses (same code, same failing index) — the compare can never paint a
 *    move the apply path would bounce;
 *  - a valid move applies end-to-end through the route (override stored,
 *    revision bumped).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensurePersonalWorkspace } from '../src/host/accessControlService.js';

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
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
      // USERS-19 (ADR 0617 D2): a deployment-named tenant is NOT a personal
      // shape, so the collapsed `personalTenant === tenantId` cookie no longer
      // grants implicit ownership — the seam founds + owns a tenant only for its
      // FIRST login, and later subjects here relied on the (SAML-shaped)
      // implicit-owner hole. Seat each subject as an explicit owner MEMBER
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for the first login), so authority is membership-derived.
      const { user } = (await res.clone().json()) as { user: { userId: string } };
      await ensurePersonalWorkspace({ tenantId, ownerSubject: user.userId, name: `Test workspace ${tenantId}` });
    },
  };
}

const B = '/v1/host/openwop-app/kicktodo';
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
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  const draft = await (await c.post(`${B}/challenges`, {
    title: 'Move routes', summary: 's', outcome: 'o', durationDays: 5,
    activities: [
      { stableActivityId: 'a1', day: 1, title: 'First', instructions: '', evidencePolicy: 'attestation' },
      { stableActivityId: 'a3', day: 3, title: 'Third', instructions: '', evidencePolicy: 'attestation' },
    ],
  })).json() as { id: string };
  await c.post(`${B}/challenges/${draft.id}/versions/1/publish`);
  const e = await (await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' })).json() as { id: string };
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
      expect(r.status).toBe(404);
    }

    // Preview: pure read with before/after dates.
    const pv = await owner.post(`${B}/enrollments/${enrollmentId}/revision-preview`, {
      commands: [{ lane: 'move', day: 3, toDate }],
    });
    expect(pv.status).toBe(200);
    const { changes } = await pv.json() as { changes: Array<{ lane: string; day: number; fromDate: string; toDate: string }> };
    expect(changes[0]).toMatchObject({ lane: 'move', day: 3, toDate });
    expect(changes[0]!.fromDate).not.toBe(toDate);
    // Nothing mutated by the preview.
    const before = await (await owner.get(`${B}/enrollments/${enrollmentId}`)).json() as { planRevision: number; schedulePreference?: { dayOverrides?: unknown } };
    expect(before.schedulePreference?.dayOverrides).toBeUndefined();

    // Apply through the route.
    const ap = await owner.post(`${B}/enrollments/${enrollmentId}/revision-commands`, {
      commands: [{ lane: 'move', day: 3, toDate }],
    });
    expect(ap.status).toBe(200);
    const after = await (await owner.get(`${B}/enrollments/${enrollmentId}`)).json() as { planRevision: number; schedulePreference?: { dayOverrides?: Record<string, string> } };
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
    const pvBody = await pv.json() as { error?: string; code?: string; details?: { failedIndex?: number } };
    const apBody = await ap.json() as { error?: string; code?: string; details?: { failedIndex?: number } };
    expect(pvBody.details?.failedIndex).toBe(0);
    expect(apBody.details?.failedIndex).toBe(0);
  });
});
