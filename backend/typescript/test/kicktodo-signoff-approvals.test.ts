/**
 * Code-grade KTY-1 (2026-10-14) — the four KickTodo sign-off approval kinds are
 * decidable on the GENERIC decision lane (`/approvals/:id/claim|reject`, which the
 * inbox card and decide-by-email also ride), and the decision ACTS:
 *
 *  - `community-profile`: approve makes the profile public; reject returns it to
 *    draft and it stays private;
 *  - `community-review`: approving the flag removes the review; rejecting restores it;
 *  - `metrics-verifier-sample` / `connect-seller`: the decision is the record the
 *    feature reads back (verifier quality / the author's onboarding status).
 *
 * Before this, all four fell through the run-proposal finalizer: approve 404'd
 * ("Proposing agent no longer exists", the host persona is not a roster row) and
 * reject resolved the row without touching the profile or review.
 *
 * Each kind also gained a decider-eligibility check: manage authority, and
 * separation of duties from the people the approval concerns. The unchanged
 * dispositions (run-proposal, commerce-spend) are pinned at the bottom.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensurePersonalWorkspace } from '../src/host/accessControlService.js';
import { createCommunityApproval, createConnectSellerApproval, getApproval } from '../src/host/approvalService.js';
import { kindHasRejectSideEffects } from '../src/host/approvalDecision.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn } from '../src/features/kicktodo-core/todayService.js';
import { flagReview, putReview, visibleReviews } from '../src/features/kicktodo-community/communityService.js';

let BASE: string;
let server: http.Server;
const TENANT = 'tenant-kt-signoff';
const COMM = '/host/openwop-app/kicktodo/community';
const APPROVALS = '/host/openwop-app/approvals';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const v: unknown = await res.json();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected a JSON object (status ${res.status})`);
  return { ...v };
}
function recOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
}
function strOf(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`expected ${what} to be a string, got ${JSON.stringify(v)}`);
  return v;
}

/** A cookie-session client. `member: false` signs in WITHOUT a workspace seat, so
 *  the subject resolves zero scopes in the tenant (no manage authority). */
function client() {
  let cookie = '';
  let subject = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    post: (p: string, b?: unknown) => send('POST', p, b ?? {}),
    subject: () => subject,
    login: async (who: string, opts: { member?: boolean } = {}) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject: who, tenantId: TENANT });
      expect([200, 201]).toContain(res.status);
      subject = strOf(recOf((await bodyOf(res.clone())).user).userId, 'userId');
      if (opts.member !== false) await ensurePersonalWorkspace({ tenantId: TENANT, ownerSubject: subject, name: `Test workspace ${TENANT}` });
    },
  };
}

const claim = (c: ReturnType<typeof client>, id: string) => c.post(`${APPROVALS}/${encodeURIComponent(id)}/claim`, {});
const reject = (c: ReturnType<typeof client>, id: string) => c.post(`${APPROVALS}/${encodeURIComponent(id)}/reject`, {});

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      BASE = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
      resolve();
    });
  });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-community', 'kicktodo-commerce', 'kicktodo-metrics']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function submittedProfile(handle: string) {
  const creator = client();
  await creator.login(`user:${handle}-creator`);
  expect((await creator.post(`${COMM}/profile`, { handle, displayName: handle })).status).toBe(200);
  const submitted = await bodyOf(await creator.post(`${COMM}/profile/submit`));
  expect(submitted.state).toBe('pending');
  return { creator, approvalId: strOf(submitted.approvalId, 'approvalId') };
}

describe('community-profile on the generic decision lane', () => {
  it('approve makes the profile public; the owner and a non-manager are refused first', async () => {
    const { creator, approvalId } = await submittedProfile('signoff-ada');
    // A re-submit while the decision is open does not mint a second card (KTY-4).
    expect((await bodyOf(await creator.post(`${COMM}/profile/submit`))).approvalId).toBe(approvalId);

    const self = await claim(creator, approvalId);
    expect(self.status).toBe(403);
    expect((await getApproval(approvalId))?.status).toBe('pending');

    const outsider = client();
    await outsider.login('user:signoff-outsider', { member: false });
    expect((await claim(outsider, approvalId)).status).toBe(403);
    expect((await getApproval(approvalId))?.status).toBe('pending');

    const mod = client();
    await mod.login('user:signoff-mod');
    const decided = await claim(mod, approvalId);
    expect(decided.status, JSON.stringify(await bodyOf(decided.clone()))).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('approved');
    const mine = recOf((await bodyOf(await creator.get(`${COMM}/profile`))).profile);
    expect(mine.state, 'the inbox approve resolved the approval but never published the profile').toBe('approved');

    expect((await claim(mod, approvalId)).status).toBe(409);
  });

  it('reject returns the profile to draft and it stays private', async () => {
    const { creator, approvalId } = await submittedProfile('signoff-bea');
    const mod = client();
    await mod.login('user:signoff-mod-2');
    expect((await reject(mod, approvalId)).status).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    const mine = recOf((await bodyOf(await creator.get(`${COMM}/profile`))).profile);
    expect(mine.state, 'reject resolved the approval but left the profile pending forever').toBe('draft');
  });
});

describe('community-review on the generic decision lane', () => {
  let challengeId = '';
  async function flaggedReview(buyer: ReturnType<typeof client>, flagger: string) {
    if (!challengeId) {
      const draft = await createDraft({
        tenantId: TENANT, title: 'Signoff reviewable', summary: 's', outcome: 'o', durationDays: 1,
        activities: [{ stableActivityId: 'a1', day: 1, title: 'Only action', instructions: 'i', evidencePolicy: 'attestation' }],
      });
      await publishChallenge(TENANT, draft.id, 1);
      challengeId = draft.id;
    }
    await enroll({ tenantId: TENANT, ownerSubject: buyer.subject(), challengeId, challengeVersion: 1, timezone: 'UTC' });
    const today = await todayFor(TENANT, buyer.subject());
    const card = today.enrollments.find((e) => e.challengeId === challengeId)?.actions[0]?.occurrence.cardId;
    if (!card) throw new Error('the single action must be due today');
    await submitCheckIn(TENANT, buyer.subject(), card, {});
    await putReview(TENANT, buyer.subject(), { challengeId, challengeVersion: 1, rating: 2, body: 'meh' });
    const flagged = await flagReview(TENANT, flagger, challengeId, buyer.subject(), 'spam');
    return strOf(flagged.flagApprovalId, 'flagApprovalId');
  }

  it('approving the flag removes the review; the review author is refused', async () => {
    const buyer = client();
    await buyer.login('user:signoff-buyer-1');
    const approvalId = await flaggedReview(buyer, 'user:signoff-flagger');
    expect((await claim(buyer, approvalId)).status).toBe(403);
    const mod = client();
    await mod.login('user:signoff-review-mod');
    expect((await claim(mod, approvalId)).status).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('approved');
    expect(await visibleReviews(TENANT, challengeId)).toHaveLength(0);
  });

  it('rejecting the flag restores the review', async () => {
    const buyer = client();
    await buyer.login('user:signoff-buyer-2');
    const approvalId = await flaggedReview(buyer, 'user:signoff-flagger');
    const before = (await visibleReviews(TENANT, challengeId)).length;
    const mod = client();
    await mod.login('user:signoff-review-mod-2');
    expect((await reject(mod, approvalId)).status).toBe(200);
    expect((await visibleReviews(TENANT, challengeId)).length, 'reject resolved the flag but the review stayed hidden').toBe(before + 1);
  });
});

describe('record-only sign-offs on the generic decision lane', () => {
  it('connect-seller: a manager approves; the author cannot self-approve', async () => {
    const author = client();
    await author.login('user:signoff-seller');
    // (The request route needs a product link first; the decision lane is what is under test.)
    const { approvalId } = await createConnectSellerApproval({ tenantId: TENANT, proposal: 'payouts', submittedBy: author.subject() });
    expect((await claim(author, approvalId)).status).toBe(403);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    const op = client();
    await op.login('user:signoff-operator');
    expect((await claim(op, approvalId)).status).toBe(200);
    // `sellerRequestStatus` reads exactly this status back.
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('metrics-verifier-sample: a manager can grade it (approve = agrees with the verifier)', async () => {
    const sample = await createCommunityApproval({ tenantId: TENANT, kind: 'metrics-verifier-sample', proposal: 'grade', refId: 'enr:signoff', submittedBy: 'system:verifier-sampler' });
    const outsider = client();
    await outsider.login('user:signoff-outsider-2', { member: false });
    expect((await claim(outsider, sample.approvalId)).status).toBe(403);
    const grader = client();
    await grader.login('user:signoff-grader');
    expect((await claim(grader, sample.approvalId)).status).toBe(200);
    expect((await getApproval(sample.approvalId))?.status).toBe('approved');
  });
});

describe('unchanged dispositions (before/after pin for non-KickTodo callers)', () => {
  it('reject side effects: the four sign-offs now report them; run-proposal and commerce-spend are unchanged', () => {
    for (const kind of ['community-profile', 'community-review', 'metrics-verifier-sample', 'connect-seller']) {
      expect(kindHasRejectSideEffects(kind), kind).toBe(true);
    }
    expect(kindHasRejectSideEffects(undefined)).toBe(false); // run-proposal
    expect(kindHasRejectSideEffects('commerce-spend')).toBe(true); // campaign-spend finalizer
    expect(kindHasRejectSideEffects('challenge-publish')).toBe(true);
  });
});
