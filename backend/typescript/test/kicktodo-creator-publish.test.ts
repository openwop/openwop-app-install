/**
 * ADR 0415 D3 — rights + the gated publication path:
 *
 *  - rights are a VERSIONED POLICY applied deterministically (TED-class
 *    domains blocked; unknown domains get the safe link-only citation floor)
 *  - a claim entailed ONLY by blocked sources fails the gate
 *  - publication = submit (hard gates → one `challenge-publish` approval on
 *    the shared queue) → complete by a DIFFERENT identity (separation of
 *    duties: the submitter is refused 403) → the challenge publishes into the
 *    kicktodo-core owner; completion is idempotent (never re-publishes)
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { decideRights } from '../src/features/kicktodo-creator/publishService.js';
import { sourceHash, setCandidateSimulation } from '../src/features/kicktodo-creator/creatorService.js';
import { getApproval, listApprovals } from '../src/host/approvalService.js';
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
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
      // USERS-19 (ADR 0617 D2): a deployment-named tenant is NOT a personal
      // shape, so the collapsed `personalTenant === tenantId` cookie no longer
      // grants implicit ownership — the seam founds + owns a tenant only for its
      // FIRST login, and later subjects here relied on the (SAML-shaped)
      // implicit-owner hole. Seat each subject as an explicit owner MEMBER
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for the first login), so authority is membership-derived.
      const user = recOf((await bodyOf(res.clone())).user);
      await ensurePersonalWorkspace({ tenantId, ownerSubject: strOf(user.userId, 'userId'), name: `Test workspace ${tenantId}` });
    },
  };
}

const CB = '/host/openwop-app/kicktodo/creator';
const KB = '/host/openwop-app/kicktodo';
const TENANT = 'tenant-kt-publish';

/** Untyped JSON → a plain record, without a cast (w41 typing rule: no `as`). */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const v: unknown = await res.json();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected a JSON object (status ${res.status})`);
  return { ...v };
}
/** The object rows of an untyped array field. */
function rowsOf(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : [];
}

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
/** A nested object field as a record (absent/non-object ⇒ `{}`). */
function recOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
}
/** A string field, or a failed assertion naming it. */
function strOf(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`expected ${what} to be a string, got ${JSON.stringify(v)}`);
  return v;
}

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
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('rights policy (deterministic, versioned)', () => {
  it('TED-class domains block; unknown domains get the link-only citation floor', () => {
    const rights = decideRights([
      { hash: 'h1', domain: 'www.ted.com' },
      { hash: 'h2', domain: 'example.org' },
    ]);
    expect(rights[0].disposition).toBe('blocked');
    expect(rights[1].disposition).toBe('link-only');
    expect(rights.every((r) => r.policyVersion === 1)).toBe(true);
  });
});

/** Build a researched candidate + a decomposable draft; returns ids. */
async function setupPublishable(author: ReturnType<typeof client>, opts?: { tedOnlyClaim?: boolean }) {
  const cand = await bodyOf(await author.post(`${CB}/candidates`, {
    topic: 'Daily gratitude notes',
    audience: 'busy adults',
    transformation: 'a durable gratitude habit',
  }));
  const candidateId = strOf(cand.id, 'candidate id');

  const good = { url: 'https://example.org/gratitude-study', domain: 'example.org', title: 'Study', hash: sourceHash('https://example.org/gratitude-study', 'Study'), engine: 'searx' };
  const ted = { url: 'https://www.ted.com/talks/x', domain: 'www.ted.com', title: 'Talk', hash: sourceHash('https://www.ted.com/talks/x', 'Talk'), engine: 'searx' };
  await author.post(`${CB}/candidates/${candidateId}/research`, {
    questions: ['q'],
    sources: [good, ted],
    claims: [{ claimId: 'c1', text: 'Gratitude journaling improves wellbeing', sourceHashes: [opts?.tedOnlyClaim ? ted.hash : good.hash] }],
  });

  const draft = await bodyOf(await author.post(`${KB}/challenges`, {
    title: 'Gratitude Notes',
    summary: '7 days of gratitude',
    outcome: 'A durable gratitude habit',
    durationDays: 7,
    activities: [{ stableActivityId: 'g1', day: 1, title: 'Write one note', instructions: 'One sentence.', evidencePolicy: 'note' }],
  }));
  // ADR 0458 P2 — the simulation gate is now real; record passing verdicts so the
  // evidence/claims/safety gates stay the variables these tests exercise. (The
  // claims/evidence gates run BEFORE simulation, so the negative-path tests still
  // fail where they expect.)
  await setCandidateSimulation(TENANT, candidateId, [
    { sim: 'newcomer', verdict: 'pass', personaSummary: '', findings: [] },
    { sim: 'time-poor', verdict: 'pass', personaSummary: '', findings: [] },
    { sim: 'skeptic', verdict: 'pass', personaSummary: '', findings: [] },
  ]);
  return { candidateId, challengeId: strOf(draft.id, 'draft id') };
}

describe('gated publication (submit → distinct approver → publish)', () => {
  it('the full path: gates pass, approval queued, submitter refused, approver publishes, idempotent completion', async () => {
    const author = client();
    await author.login('user:pub-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);

    const submitted = await bodyOf(await author.post(`${CB}/candidates/${candidateId}/submit-publication`, {
      challengeId,
      challengeVersion: 1,
    }));
    const approvalId = strOf(submitted.approvalId, 'approvalId');
    expect(approvalId).toMatch(/^appr:/);
    expect((await getApproval(approvalId))?.kind).toBe('challenge-publish');

    // PROBE-KTX3 (KT-EXP-7), inverted. The probe asked to "confirm the JSON has
    // NO `state` key" — it was written to CONFIRM THE DEFECT, and the defect is
    // fixed: `publicationView` derives `state` at the read boundary because the
    // FE client type and the Provenance Spine both expect one, and without it the
    // spine's publication phase and the "Approve & publish" step were driven by a
    // permanently-undefined field (publishService.ts:81-87). So the invariant
    // worth pinning is the FIX, not the defect: the phase must be derived on the
    // wire and must TRACK completion, not sit constant.
    const beforeView = await bodyOf(await author.get(`${CB}/candidates/${candidateId}/publication`));
    expect(beforeView.state, 'the publication phase is missing on the wire — the KT-EXP-7 regression').toBe('submitted');

    // Separation of duties: the SUBMITTER cannot complete their own publication —
    // refused by `completePublication`'s own check (its exact message).
    const selfComplete = await author.post(`${CB}/candidates/${candidateId}/complete-publication`);
    expect(selfComplete.status).toBe(403);
    expect(await bodyOf(selfComplete)).toMatchObject({ error: 'forbidden', message: 'Publication must be approved by someone other than the submitter (separation of duties).' });

    // A different identity approves + publishes.
    const approver = client();
    await approver.login('user:pub-approver', TENANT);
    const done = await bodyOf(await approver.post(`${CB}/candidates/${candidateId}/complete-publication`));
    expect(done.completedBy).not.toBe(done.submittedBy);
    expect(typeof done.completedBy).toBe('string');
    expect(typeof done.completedAt).toBe('string');
    expect(done.state, 'the phase did not advance to completed — a completed publication reads as still submitted').toBe('completed');
    const afterView = await bodyOf(await approver.get(`${CB}/candidates/${candidateId}/publication`));
    expect(afterView.state, 'the re-read phase disagrees with the completion response').toBe('completed');

    // The challenge is now PUBLISHED in the kicktodo-core owner.
    const pub = await bodyOf(await approver.get(`${KB}/challenges/${challengeId}/versions/1`));
    expect(pub.status).toBe('published');
    expect(pub.contentHash).toMatch(/^sha256:/);

    // Idempotent: completing again returns the recorded act (no re-publish).
    // DOUBLE GUARD (honest ceiling): `completePublication` returns the recorded act
    // early on `record.completedAt` AND again after re-reading `stored.completedAt`
    // before the CAS — removing either one alone leaves this green. The replay-
    // after-kill case below separates the early return.
    const againRes = await approver.post(`${CB}/candidates/${candidateId}/complete-publication`);
    expect(againRes.status).toBe(200);
    const again = await bodyOf(againRes);
    expect(again.completedBy).toBe(done.completedBy);
    expect(again.completedAt).toBe(done.completedAt);
  });

  // The DOUBLE GUARD above is separated here. A replayed completion (a retried
  // request, a second click) that arrives after the operator KILLED the published
  // challenge must still return the recorded act — the publication happened. Only the
  // early `record.completedAt` return gives that: without it the replay re-runs the
  // preconditions, meets the withdrawn candidate and 409s, and never reaches the
  // second (post-publish) completedAt re-read. Witness: w41g1-pub-idempotent.
  it('a replayed completion after the kill switch returns the recorded act, not a re-run of the preconditions', async () => {
    const author = client();
    await author.login('user:replay-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    const approver = client();
    await approver.login('user:replay-approver', TENANT);
    const doneRes = await approver.post(`${CB}/candidates/${candidateId}/complete-publication`);
    expect(doneRes.status).toBe(200);
    const done = await bodyOf(doneRes);

    const killed = await approver.post(`${CB}/candidates/${candidateId}/kill`, { reason: 'source retracted after publish' });
    expect(killed.status, JSON.stringify(await bodyOf(killed.clone()))).toBe(200);
    expect((await bodyOf(await approver.get(`${KB}/challenges/${challengeId}/versions/1`))).status).toBe('retired');

    const replay = await approver.post(`${CB}/candidates/${candidateId}/complete-publication`);
    const replayBody = await bodyOf(replay);
    expect(replay.status, JSON.stringify(replayBody)).toBe(200);
    expect(replayBody.completedAt).toBe(done.completedAt);
    expect(replayBody.completedBy).toBe(done.completedBy);
    expect(replayBody.state).toBe('completed');
    // …and the replay did not resurrect the killed challenge.
    expect((await bodyOf(await approver.get(`${KB}/challenges/${challengeId}/versions/1`))).status).toBe('retired');
  });

  it('the GENERIC decision lane publishes: approve from the inbox completes the publication (ADR 0458 §2.2 correction)', async () => {
    // Before the challenge-publish handler existed, this claim fell through the
    // run-proposal finalizer and 404'd on the factory persona ("Proposing agent
    // no longer exists") — the inbox could reject but never approve, and no client
    // called the creator's complete route after ADR 0458 P4. The approvals routes,
    // the review cards and decide-by-email all ride `claimApproval`, so this is the
    // ONE lane that has to publish.
    const author = client();
    await author.login('user:lane-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const approvalId = strOf((await bodyOf(await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 }))).approvalId, 'approvalId');
    const CLAIM = `/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/claim`;

    // Separation of duties holds on the lane: the submitter is refused 403 by the
    // LANE's own eligibility copy (routes.ts `registerApprovalEligibility`, its exact
    // message). DOUBLE GUARD: `completePublication`'s SoD check sits behind it and
    // refuses with a different message (pinned in the full-path case above).
    const selfClaim = await author.post(CLAIM, {});
    expect(selfClaim.status).toBe(403);
    expect(await bodyOf(selfClaim)).toMatchObject({ error: 'forbidden', message: 'A challenge publication must be decided by someone other than the submitter (separation of duties).' });
    expect((await getApproval(approvalId))?.status).toBe('pending');

    // A different manage-holder approves from the lane → the publication COMPLETES.
    const approver = client();
    await approver.login('user:lane-approver', TENANT);
    const claim = await approver.post(CLAIM, { note: 'looks good' });
    const claimBody = await bodyOf(claim);
    expect(claim.status, JSON.stringify(claimBody)).toBe(200);
    expect(claimBody.status).toBe('approved');
    expect(claimBody.candidateId).toBe(candidateId);
    expect(claimBody.challengeId).toBe(challengeId);
    expect((await getApproval(approvalId))?.status).toBe('approved');

    const view = await bodyOf(await approver.get(`${CB}/candidates/${candidateId}/publication`));
    expect(view.state, 'the inbox approve resolved the approval but never ran the publication act').toBe('completed');
    expect(typeof view.completedBy).toBe('string');
    expect(view.completedBy).not.toBe(view.submittedBy);
    const pub = await bodyOf(await approver.get(`${KB}/challenges/${challengeId}/versions/1`));
    expect(pub.status).toBe('published');

    // A second decision on the same approval is a typed 409, never a re-publish.
    expect((await approver.post(CLAIM, {})).status).toBe(409);
    const cand = await bodyOf(await approver.get(`${CB}/candidates/${candidateId}`));
    expect(cand.state).toBe('published');
  });

  it('the GENERIC decision lane rejects: a reject resolves the approval and the candidate reads as returned', async () => {
    const author = client();
    await author.login('user:lane-author-2', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const approvalId = strOf((await bodyOf(await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 }))).approvalId, 'approvalId');
    const approver = client();
    await approver.login('user:lane-approver-2', TENANT);
    const reject = await approver.post(`/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/reject`, { note: 'day 3 overclaims' });
    expect(reject.status).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    const pub = await bodyOf(await approver.get(`${KB}/challenges/${challengeId}/versions/1`));
    expect(pub.status).toBe('draft');
    const needs = await bodyOf(await author.get(`${CB}/needs-you`));
    const returned = rowsOf(needs.rows).find((r) => r.candidateId === candidateId && r.kind === 'returned');
    expect(returned, 'a rejected publication must surface as "returned" in the creator\'s Needs-you queue').toBeDefined();
    expect(returned?.detail).toBe('day 3 overclaims');
  });

  // Twin: `kicktodo-creator-honesty-reads.test.ts` "parity on the claims gate" drives
  // the same refusal and also pins the /gates matrix row (both red under w41 probe
  // pub-claims-gate). Kept here as the publication-suite view of the gate.
  it('a claim entailed ONLY by a blocked (TED-class) source fails the submit gate', async () => {
    const author = client();
    await author.login('user:pub-ted', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author, { tedOnlyClaim: true });
    const res = await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(recOf(body.details).gate).toBe('claims');
    expect(body.message).toBe('Unsupported claims after rights blocking: c1.');
  });

  // Twin: `kicktodo-creator-honesty-reads.test.ts` "the 5-gate matrix re-derives the
  // SAME gate + detail … (evidence)". The bare 409 here used to pass with the
  // evidence gate gone (the claims gate 409s next — w41 probe pub-evidence-gate was
  // vacuous); the gate + message now pin WHICH gate refused.
  it('a candidate with no dossier cannot submit (evidence gate)', async () => {
    const author = client();
    await author.login('user:pub-bare', TENANT);
    const cand = await bodyOf(await author.post(`${CB}/candidates`, { topic: 'Tidy desk habit' }));
    const draft = await bodyOf(await author.post(`${KB}/challenges`, {
      title: 'Tidy Desk', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 't1', day: 1, title: 'Clear it', instructions: '', evidencePolicy: 'attestation' }],
    }));
    const res = await author.post(`${CB}/candidates/${strOf(cand.id, 'candidate id')}/submit-publication`, { challengeId: draft.id, challengeVersion: 1 });
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(recOf(body.details).gate).toBe('evidence');
    expect(body.message).toBe('No research dossier — a challenge cannot publish without evidence.');
  });
});

describe('code-grade 2026-10-14 hardening', () => {
  it('KTF-PB-1: two concurrent first submits leave ONE pending approval (the loser closes its own as superseded)', async () => {
    const author = client();
    await author.login('user:race-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const [a, b] = await Promise.all([
      author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 }),
      author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 }),
    ]);
    const idA = strOf((await bodyOf(a)).approvalId, 'approvalId');
    const idB = strOf((await bodyOf(b)).approvalId, 'approvalId');
    expect(idA).toBe(idB); // both callers see the winning record
    const forCandidate = (await listApprovals(TENANT)).filter((x) => x.kind === 'challenge-publish' && x.challengePublish?.candidateId === candidateId);
    expect(forCandidate.filter((x) => x.status === 'pending').map((x) => x.approvalId)).toEqual([idA]);
    for (const orphan of forCandidate.filter((x) => x.approvalId !== idA)) {
      expect(orphan.status, 'a losing submit left an orphan approval in the shared queue').toBe('rejected');
      expect(orphan.superseded).toBe(true);
    }
  });

  it('a kill before completion closes the pending approval; approving from the inbox then cannot publish', async () => {
    const author = client();
    await author.login('user:kill-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const approvalId = strOf((await bodyOf(await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 }))).approvalId, 'approvalId');
    const op = client();
    await op.login('user:kill-operator', TENANT);
    const killed = await op.post(`${CB}/candidates/${candidateId}/kill`, { reason: 'source retracted' });
    expect(killed.status, JSON.stringify(await bodyOf(killed.clone()))).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    expect((await op.post(`/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/claim`, {})).status).toBe(409);
    expect((await op.post(`${CB}/candidates/${candidateId}/complete-publication`)).status).toBe(409);
    const pub = await bodyOf(await op.get(`${KB}/challenges/${challengeId}/versions/1`));
    expect(pub.status).not.toBe('published');
  });

  it('a published candidate\'s dossier cannot be rewritten (409), and a malformed claim is a 400, not a 500', async () => {
    const author = client();
    await author.login('user:closed-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const bad = await author.post(`${CB}/candidates/${candidateId}/research`, {
      questions: [], sources: [], claims: [{ claimId: 'c9', text: 't', sourceHashes: 'not-an-array' }],
    });
    expect(bad.status).toBe(400);
    await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    const approver = client();
    await approver.login('user:closed-approver', TENANT);
    expect((await approver.post(`${CB}/candidates/${candidateId}/complete-publication`)).status).toBe(200);
    const rewrite = await author.post(`${CB}/candidates/${candidateId}/research`, {
      questions: [], sources: [{ url: 'https://example.org/other', title: 'Other', engine: 'searx' }], claims: [],
    });
    expect(rewrite.status).toBe(409);
  });

  it('KTF-IN-2: intake targets outside the plan vocabulary are refused at intake', async () => {
    const author = client();
    await author.login('user:intake-author', TENANT);
    for (const body of [{ durationDaysTarget: 0 }, { durationDaysTarget: -3 }, { durationDaysTarget: 2.5 }, { dailyMinutesTarget: 1000 }]) {
      const res = await author.post(`${CB}/candidates`, { topic: 'Learn to juggle', audience: 'adults', ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await author.post(`${CB}/candidates`, { topic: 'Learn to juggle', audience: 'adults', durationDaysTarget: 21, dailyMinutesTarget: 10 })).status).toBe(200);
  });
});

