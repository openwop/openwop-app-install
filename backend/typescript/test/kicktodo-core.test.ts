/**
 * kicktodo-core (ADR 0414 P1) — route-level coverage of the participant loop:
 *
 *  - toggle OFF → the whole surface is absent (fail-closed 404s)
 *  - draft → publish (immutable, content-hashed) → Discover lists it
 *  - enrollment saga: deterministic ids; idempotent re-enroll; ONE goal per
 *    enrollment (principal-owned, RFC 0058 bounds); ONE board per user with
 *    NO trigger columns; day-1 occurrences + cards materialized
 *  - Today: bounded read; check-in completes the card (terminal column) and
 *    is idempotent (recorded evidence wins)
 *  - plan-revision supersession: exactly one live card per
 *    (enrollment, localDate, activity) across the revision boundary,
 *    completed cards keep their history
 *  - uniform 404: a foreign participant's enrollment/check-in is
 *    indistinguishable from absent
 *
 * Sabotage witnesses (w41 /grade-tests): dropping the owner check in
 * `hasKicktodoEnrollmentAuthority`, `abandonEnrollment` or `submitCheckIn` reds
 * the uniform-404 case; dropping the published-row early return in
 * `publishChallenge` reds the publish-idempotency leg (publishedAt moves);
 * dropping `if (terminal) continue` in `applyPlanRevision` reds supersession.
 *
 * Honest double guard: enrolling a DRAFT is refused by `status !== 'published'`
 * AND by `!contentHash` (a draft has no hash), so only the retired leg can show
 * the status check alone.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getBoard, getCard } from '../src/host/kanbanService.js';
import { getGoal } from '../src/features/goals/goalsService.js';
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

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const B = '/host/openwop-app/kicktodo';
const TENANT = 'tenant-kicktodo';

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
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CHALLENGE_BODY = {
  title: 'Morning Focus Reset',
  summary: 'A 3-day focus starter',
  outcome: 'A repeatable morning focus ritual',
  durationDays: 3,
  activities: [
    { stableActivityId: 'day1-clear-desk', day: 1, title: 'Clear your desk', instructions: 'Five minutes.', evidencePolicy: 'attestation' },
    { stableActivityId: 'day1-plan', day: 1, title: 'Write the one thing', instructions: 'One sentence.', evidencePolicy: 'note' },
    { stableActivityId: 'day2-block', day: 2, title: 'Block 25 minutes', instructions: 'One pomodoro.', evidencePolicy: 'attestation' },
  ],
};

describe('toggle gate', () => {
  it('toggle OFF → the surface is absent (fail-closed)', async () => {
    const c = client();
    await c.login('user:kt-gate', TENANT);
    await setToggle('kicktodo-core', 'off');
    try {
      for (const path of [`${B}/challenges`, `${B}/today`]) {
        const res = await c.get(path);
        expect(res.status).toBe(404);
        // The toggle gate's OWN refusal — a missing route or an owner 404 would say otherwise.
        expect((await body<{ message?: string }>(res)).message).toBe('KickTodo is not enabled for this tenant.');
      }
    } finally {
      await setToggle('kicktodo-core', 'on');
    }
  });
});

describe('participant loop (ADR 0414 P1)', () => {
  it('publish → enroll → today → check-in → completed card; idempotent everywhere', async () => {
    const c = client();
    await c.login('user:kt-alice', TENANT);
    await setToggle('kicktodo-core', 'on');

    // Author + publish (immutable + content-hashed).
    const draft = await body<{ id: string; version: number; status: string }>(await c.post(`${B}/challenges`, CHALLENGE_BODY));
    expect(draft.status).toBe('draft');
    // Publish is idempotent: the frozen row is returned UNCHANGED. The content
    // hash alone cannot show it (a re-freeze recomputes the same hash), so the
    // clock is moved between the two publishes and `publishedAt` must not move.
    // (Relative to now — the session cookie must stay valid.)
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    let pub: { status: string; contentHash: string; publishedAt: string };
    let pub2: { contentHash: string; publishedAt: string };
    try {
      vi.setSystemTime(t0);
      pub = await body<typeof pub>(await c.post(`${B}/challenges/${draft.id}/versions/1/publish`));
      vi.setSystemTime(t0 + 5_000);
      pub2 = await body<typeof pub2>(await c.post(`${B}/challenges/${draft.id}/versions/1/publish`));
    } finally {
      vi.useRealTimers();
    }
    expect(pub.status).toBe('published');
    expect(pub.contentHash).toMatch(/^sha256:/);
    expect(pub2.contentHash).toBe(pub.contentHash);
    expect(pub2.publishedAt).toBe(pub.publishedAt);
    // Discover lists ONLY published rows — an unpublished draft is absent.
    const unpublished = await body<{ id: string }>(await c.post(`${B}/challenges`, { ...CHALLENGE_BODY, title: 'Unpublished draft' }));
    const disco = await body<{ challenges: Array<{ id: string }> }>(await c.get(`${B}/challenges`));
    expect(disco.challenges.some((x) => x.id === draft.id)).toBe(true);
    expect(disco.challenges.some((x) => x.id === unpublished.id)).toBe(false);

    // Enroll — deterministic, idempotent.
    const e1 = await body<{
      id: string; goalId: string; boardId: string; planRevision: number; challengeContentHash: string;
    }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' }));
    expect(e1.challengeContentHash).toBe(pub.contentHash);
    const e2 = await body<{ id: string; goalId: string }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1 }));
    expect(e2.id).toBe(e1.id);
    expect(e2.goalId).toBe(e1.goalId);

    // ONE goal per enrollment — principal-owned (by the enrollment's stable
    // opaque owner subject — the auth layer hashes login subjects) with
    // RFC 0058 bounds.
    const mineRow = await body<{ ownerSubject: string }>(await c.get(`${B}/enrollments/${e1.id}`));
    const goal = await getGoal(TENANT, e1.goalId);
    expect(goal?.owner.principal).toBe(mineRow.ownerSubject);
    expect(goal?.owner.principal).toMatch(/^user:/);
    // durationDays 3 ⇒ 3 + 7 iterations and a 2×duration timeout (enrollmentService).
    expect(goal?.bounds.maxLoopIterations).toBe(10);
    expect(goal?.bounds.runTimeoutMs).toBe(3 * 2 * 86_400_000);

    // ONE board per user, NO trigger columns (a human action can never start a workflow).
    const board = await getBoard(e1.boardId);
    expect(board?.columns.every((col) => !col.triggerWorkflowId)).toBe(true);
    expect(board?.columns.find((col) => col.id === 'done')?.terminal).toBe(true);

    // Today: both day-1 actions materialized, none completed.
    const today = await body<{
      enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string }; card: { completed: boolean } | null }> }>;
    }>(await c.get(`${B}/today`));
    const mine = today.enrollments.find((x) => x.enrollmentId === e1.id);
    expect(mine?.actions).toHaveLength(2);
    expect(mine?.actions.every((a) => a.card && !a.card.completed)).toBe(true);

    // Check-in on the first action → card completes; repeat is idempotent.
    const cardId = mine!.actions[0].occurrence.cardId;
    const ci = await body<{ cardId: string; note?: string }>(await c.post(`${B}/check-ins`, { cardId, note: 'done!' }));
    expect(ci.cardId).toBe(cardId);
    const ciRepeat = await body<{ note?: string }>(await c.post(`${B}/check-ins`, { cardId, note: 'OVERWRITE ATTEMPT' }));
    expect(ciRepeat.note).toBe('done!'); // recorded evidence wins
    const card = await getCard(cardId);
    expect(card?.columnId).toBe('done');
  });

  it('plan-revision supersession: one live card per action across the boundary; completed history survives', async () => {
    const c = client();
    await c.login('user:kt-bob', TENANT);
    await setToggle('kicktodo-core', 'on');

    const draft = await body<{ id: string }>(await c.post(`${B}/challenges`, CHALLENGE_BODY));
    await c.post(`${B}/challenges/${draft.id}/versions/1/publish`);
    const e = await body<{ id: string }>(await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' }));

    // Complete ONE of the two day-1 actions, leave the other open.
    const today1 = await body<{
      enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string } }> }>;
    }>(await c.get(`${B}/today`));
    const actions = today1.enrollments.find((x) => x.enrollmentId === e.id)!.actions;
    expect(actions).toHaveLength(2);
    const [doneCard, openCard] = [actions[0].occurrence.cardId, actions[1].occurrence.cardId];
    await c.post(`${B}/check-ins`, { cardId: doneCard });

    // Approved re-plan → revision bump with supersession.
    const replanned = await body<{ planRevision: number }>(await c.post(`${B}/enrollments/${e.id}/replan`));
    expect(replanned.planRevision).toBe(2);

    // The completed card SURVIVES (history); the open card was superseded and
    // replaced by exactly one r2 card for the same logical action.
    expect((await getCard(doneCard))?.columnId).toBe('done');
    expect(await getCard(openCard)).toBeNull();

    const today2 = await body<{
      enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string; planRevision: number; stableActivityId: string } }> }>;
    }>(await c.get(`${B}/today`));
    const after = today2.enrollments.find((x) => x.enrollmentId === e.id)!.actions;
    // Exactly one live occurrence per (localDate, activity): the completed r1
    // one is GONE from today's live set? No — supersession only removes
    // non-terminal work: the completed action's r1 occurrence stays live
    // (its history is truth), the open action reappears as r2.
    const byActivity = new Map(after.map((a) => [a.occurrence.stableActivityId, a.occurrence]));
    expect(after).toHaveLength(2);
    expect(byActivity.get('day1-clear-desk')?.planRevision).toBe(1); // completed, kept
    expect(byActivity.get('day1-plan')?.planRevision).toBe(2); // superseded → re-materialized
  });

  it('uniform 404: a foreign participant cannot see or mutate my enrollment', async () => {
    const alice = client();
    await alice.login('user:kt-alice2', TENANT);
    await setToggle('kicktodo-core', 'on');
    const draft = await body<{ id: string }>(await alice.post(`${B}/challenges`, CHALLENGE_BODY));
    await alice.post(`${B}/challenges/${draft.id}/versions/1/publish`);
    const e = await body<{ id: string }>(await alice.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1 }));
    const today = await body<{
      enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string } }> }>;
    }>(await alice.get(`${B}/today`));
    const cardId = today.enrollments.find((x) => x.enrollmentId === e.id)!.actions[0].occurrence.cardId;

    const mallory = client();
    await mallory.login('user:kt-mallory', TENANT);
    const refusals: Array<[Promise<Response>, string]> = [
      [mallory.get(`${B}/enrollments/${e.id}`), 'Enrollment not found.'],
      [mallory.post(`${B}/enrollments/${e.id}/replan`), 'Enrollment not found.'],
      [mallory.post(`${B}/enrollments/${e.id}/abandon`), 'Enrollment not found.'],
      // CheckInDeniedError('not-owner') — the same text as an absent action (no oracle).
      [mallory.post(`${B}/check-ins`, { cardId }), 'No such action.'],
    ];
    for (const [pending, message] of refusals) {
      const res = await pending;
      expect(res.status).toBe(404);
      expect((await body<{ message?: string }>(res)).message).toBe(message);
    }
    // The owner's enrollment is still active (abandon did not land).
    expect((await body<{ state: string }>(await alice.get(`${B}/enrollments/${e.id}`))).state).toBe('active');
    // Nothing changed for the owner.
    expect((await getCard(cardId))?.columnId).toBe('todo');
  });

  it('enrolling in a draft or retired version is refused', async () => {
    const c = client();
    await c.login('user:kt-carol', TENANT);
    await setToggle('kicktodo-core', 'on');
    const draft = await body<{ id: string }>(await c.post(`${B}/challenges`, CHALLENGE_BODY));
    expect((await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1 })).status).toBe(409);
    await c.post(`${B}/challenges/${draft.id}/versions/1/publish`);
    await c.post(`${B}/challenges/${draft.id}/versions/1/retire`);
    expect((await c.post(`${B}/enrollments`, { challengeId: draft.id, challengeVersion: 1 })).status).toBe(409);
  });
});
