/**
 * ADR 0414 P3 — progress projection, frozen evidence, and judged completion
 * through the ADR 0412 goals owner:
 *
 *  - progress is a rebuildable projection (counts from board+check-ins)
 *  - evaluate freezes an immutable content-hashed snapshot; the registered
 *    deterministic verifier judges THE SNAPSHOT (never live collections)
 *  - incomplete → verdict recorded, goal + enrollment stay active
 *  - complete → goal satisfied + enrollment projected to completed
 *  - re-evaluate on unchanged state → the RECORDED verdict replays (the judge
 *    is not re-invoked; ADR 0412 replay invariant, observed end-to-end)
 *  - tampered evidence hash → typed failure, never a verdict
 *  - snooze halts materialization; resume restores it
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getGoal, evaluateGoal, VerifierFailedError } from '../src/features/goals/goalsService.js';
import { freezeProgressEvidence } from '../src/features/kicktodo-core/progressService.js';
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
const TENANT = 'tenant-kt-progress';

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

/** One-day challenge — every activity materializes on day 1, so completion is
 *  judgeable within the test. */
const ONE_DAY = {
  title: 'One-Day Reset',
  summary: 'Two actions, one day',
  outcome: 'A finished reset',
  durationDays: 1,
  activities: [
    { stableActivityId: 'a1', day: 1, title: 'First', instructions: '', evidencePolicy: 'attestation' },
    { stableActivityId: 'a2', day: 1, title: 'Second', instructions: '', evidencePolicy: 'attestation' },
  ],
};

async function setupEnrollment(c: ReturnType<typeof client>) {
  const draft = await (await c.post(`${B}/challenges`, ONE_DAY)).json() as { id: string };
  await c.post(`${B}/challenges/${draft.id}/versions/1/publish`);
  const e = await (await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' })).json() as { id: string; goalId: string };
  const today = await (await c.get(`${B}/today`)).json() as {
    enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string } }> }>;
  };
  const cards = today.enrollments.find((x) => x.enrollmentId === e.id)!.actions.map((a) => a.occurrence.cardId);
  return { e, cards };
}

describe('progress + judged completion (ADR 0414 P3)', () => {
  it('freeze → judge → project: incomplete stays active; complete finishes goal AND enrollment; replay observed', async () => {
    const c = client();
    await c.login('user:kp-dana', TENANT);
    const { e, cards } = await setupEnrollment(c);

    // Projection at zero.
    const p0 = await (await c.get(`${B}/enrollments/${e.id}/progress`)).json() as { completedActivities: number; totalRequiredActivities: number };
    expect(p0.totalRequiredActivities).toBe(2);
    expect(p0.completedActivities).toBe(0);

    // Evaluate while incomplete → verdict recorded, everything stays active.
    await c.post(`${B}/check-ins`, { cardId: cards[0] });
    const r1 = await (await c.post(`${B}/enrollments/${e.id}/evaluate`)).json() as { satisfied: boolean; replayed: boolean; enrollment: { state: string } };
    expect(r1.satisfied).toBe(false);
    expect(r1.enrollment.state).toBe('active');
    expect((await getGoal(TENANT, e.goalId))?.state).toBe('active');

    // Complete the second action → satisfied; enrollment projects completed.
    await c.post(`${B}/check-ins`, { cardId: cards[1] });
    const r2 = await (await c.post(`${B}/enrollments/${e.id}/evaluate`)).json() as { satisfied: boolean; replayed: boolean; enrollment: { state: string } };
    expect(r2.satisfied).toBe(true);
    expect(r2.replayed).toBe(false);
    expect(r2.enrollment.state).toBe('completed');
    expect((await getGoal(TENANT, e.goalId))?.state).toBe('satisfied');

    // Unchanged state → same snapshot hash → the RECORDED verdict replays.
    const r3 = await (await c.post(`${B}/enrollments/${e.id}/evaluate`)).json() as { satisfied: boolean; replayed: boolean };
    expect(r3.satisfied).toBe(true);
    expect(r3.replayed).toBe(true);
  });

  it('tampered evidence hash → typed verifier failure, never a verdict', async () => {
    const c = client();
    await c.login('user:kp-eve', TENANT);
    const { e } = await setupEnrollment(c);
    const snapshot = await freezeProgressEvidence(TENANT, e.id);
    await expect(
      evaluateGoal(TENANT, e.goalId, {
        snapshotRef: `${TENANT}|${e.id}|${snapshot!.id}`,
        snapshotHash: 'sha256:deadbeef', // tampered
      }),
    ).rejects.toBeInstanceOf(VerifierFailedError);
    expect((await getGoal(TENANT, e.goalId))?.state).toBe('active');
  });

  it('snooze halts materialization; resume restores it', async () => {
    const c = client();
    await c.login('user:kp-finn', TENANT);
    const { e } = await setupEnrollment(c);
    await c.post(`${B}/enrollments/${e.id}/snooze`);
    const snoozed = await (await c.post(`${B}/enrollments/${e.id}/materialize`)).json() as { occurrences: unknown[] };
    expect(snoozed.occurrences).toHaveLength(0);
    const resumed = await (await c.post(`${B}/enrollments/${e.id}/resume`)).json() as { state: string };
    expect(resumed.state).toBe('active');
    const after = await (await c.post(`${B}/enrollments/${e.id}/materialize`)).json() as { occurrences: unknown[] };
    expect(after.occurrences.length).toBeGreaterThan(0);
  });

  it('KTX-3 batch read: ?include=progress returns the same projection as the per-id route, in ONE request', async () => {
    const c = client();
    await c.login('user:kp-gwen', TENANT);
    const { e } = await setupEnrollment(c);
    // Plain list carries no progress key (shape unchanged for existing callers).
    const plain = await (await c.get(`${B}/enrollments`)).json() as { enrollments: unknown[]; progress?: unknown };
    expect(plain.progress).toBeUndefined();
    // Batch read: one entry per enrollment, byte-equal to the per-id projection.
    const batch = await (await c.get(`${B}/enrollments?include=progress`)).json() as {
      enrollments: Array<{ id: string }>;
      progress: Record<string, unknown>;
    };
    expect(Object.keys(batch.progress)).toContain(e.id);
    const single = await (await c.get(`${B}/enrollments/${e.id}/progress`)).json();
    expect(batch.progress[e.id]).toEqual(single);
    // The other user's enrollments never appear (authority = the caller's list).
    for (const row of batch.enrollments) expect(Object.keys(batch.progress)).toContain(row.id);
  });

  it('§5.6 trace: per-activity rows joined to plan titles; recovery honest at zero', async () => {
    const c = client();
    await c.login('user:kp-hana', TENANT);
    const { e, cards } = await setupEnrollment(c);
    await c.post(`${B}/check-ins`, { cardId: cards[0] });
    const p = await (await c.get(`${B}/enrollments/${e.id}/progress`)).json() as {
      trace: Array<{ stableActivityId: string; day: number | null; title: string | null; recovery: boolean; completed: boolean; dateLocal: string }>;
      recovery: { offered: number; completed: number };
    };
    expect(p.trace).toHaveLength(2);
    const first = p.trace.find((r) => r.stableActivityId === 'a1');
    expect(first).toMatchObject({ day: 1, title: 'First', recovery: false, completed: true });
    expect(p.trace.find((r) => r.stableActivityId === 'a2')).toMatchObject({ title: 'Second', completed: false });
    expect(p.recovery).toEqual({ offered: 0, completed: 0 });
  });
});
