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
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { decideRights } from '../src/features/kicktodo-creator/publishService.js';
import { sourceHash, setCandidateSimulation } from '../src/features/kicktodo-creator/creatorService.js';
import { getApproval } from '../src/host/approvalService.js';
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

const CB = '/v1/host/openwop-app/kicktodo/creator';
const KB = '/v1/host/openwop-app/kicktodo';
const TENANT = 'tenant-kt-publish';

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
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const cand = await (await author.post(`${CB}/candidates`, {
    topic: 'Daily gratitude notes',
    audience: 'busy adults',
    transformation: 'a durable gratitude habit',
  })).json() as { id: string };

  const good = { url: 'https://example.org/gratitude-study', domain: 'example.org', title: 'Study', hash: sourceHash('https://example.org/gratitude-study', 'Study'), engine: 'searx' };
  const ted = { url: 'https://www.ted.com/talks/x', domain: 'www.ted.com', title: 'Talk', hash: sourceHash('https://www.ted.com/talks/x', 'Talk'), engine: 'searx' };
  await author.post(`${CB}/candidates/${cand.id}/research`, {
    questions: ['q'],
    sources: [good, ted],
    claims: [{ claimId: 'c1', text: 'Gratitude journaling improves wellbeing', sourceHashes: [opts?.tedOnlyClaim ? ted.hash : good.hash] }],
  });

  const draft = await (await author.post(`${KB}/challenges`, {
    title: 'Gratitude Notes',
    summary: '7 days of gratitude',
    outcome: 'A durable gratitude habit',
    durationDays: 7,
    activities: [{ stableActivityId: 'g1', day: 1, title: 'Write one note', instructions: 'One sentence.', evidencePolicy: 'note' }],
  })).json() as { id: string };
  // ADR 0458 P2 — the simulation gate is now real; record passing verdicts so the
  // evidence/claims/safety gates stay the variables these tests exercise. (The
  // claims/evidence gates run BEFORE simulation, so the negative-path tests still
  // fail where they expect.)
  await setCandidateSimulation(TENANT, cand.id, [
    { sim: 'newcomer', verdict: 'pass', personaSummary: '', findings: [] },
    { sim: 'time-poor', verdict: 'pass', personaSummary: '', findings: [] },
    { sim: 'skeptic', verdict: 'pass', personaSummary: '', findings: [] },
  ]);
  return { candidateId: cand.id, challengeId: draft.id };
}

describe('gated publication (submit → distinct approver → publish)', () => {
  it('the full path: gates pass, approval queued, submitter refused, approver publishes, idempotent completion', async () => {
    const author = client();
    await author.login('user:pub-author', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);

    const submitted = await (await author.post(`${CB}/candidates/${candidateId}/submit-publication`, {
      challengeId,
      challengeVersion: 1,
    })).json() as { approvalId: string; submittedBy: string };
    expect(submitted.approvalId).toMatch(/^appr:/);
    expect((await getApproval(submitted.approvalId))?.kind).toBe('challenge-publish');

    // PROBE-KTX3 (KT-EXP-7), inverted. The probe asked to "confirm the JSON has
    // NO `state` key" — it was written to CONFIRM THE DEFECT, and the defect is
    // fixed: `publicationView` derives `state` at the read boundary because the
    // FE client type and the Provenance Spine both expect one, and without it the
    // spine's publication phase and the "Approve & publish" step were driven by a
    // permanently-undefined field (publishService.ts:81-87). So the invariant
    // worth pinning is the FIX, not the defect: the phase must be derived on the
    // wire and must TRACK completion, not sit constant.
    const beforeView = await (await author.get(`${CB}/candidates/${candidateId}/publication`))
      .json() as { state?: string };
    expect(beforeView.state, 'the publication phase is missing on the wire — the KT-EXP-7 regression').toBe('submitted');

    // Separation of duties: the SUBMITTER cannot complete their own publication.
    expect((await author.post(`${CB}/candidates/${candidateId}/complete-publication`)).status).toBe(403);

    // A different identity approves + publishes.
    const approver = client();
    await approver.login('user:pub-approver', TENANT);
    const done = await (await approver.post(`${CB}/candidates/${candidateId}/complete-publication`)).json() as { completedBy?: string; state?: string };
    expect(done.completedBy).toBeDefined();
    expect(done.state, 'the phase did not advance to completed — a completed publication reads as still submitted').toBe('completed');
    const afterView = await (await approver.get(`${CB}/candidates/${candidateId}/publication`)).json() as { state?: string };
    expect(afterView.state, 'the re-read phase disagrees with the completion response').toBe('completed');

    // The challenge is now PUBLISHED in the kicktodo-core owner.
    const pub = await (await approver.get(`${KB}/challenges/${challengeId}/versions/1`)).json() as { status: string; contentHash?: string };
    expect(pub.status).toBe('published');
    expect(pub.contentHash).toMatch(/^sha256:/);

    // Idempotent: completing again returns the recorded act (no re-publish).
    const again = await (await approver.post(`${CB}/candidates/${candidateId}/complete-publication`)).json() as { completedBy?: string };
    expect(again.completedBy).toBe(done.completedBy);
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
    const submitted = await (await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 })).json() as { approvalId: string };
    const CLAIM = `/v1/host/openwop-app/approvals/${encodeURIComponent(submitted.approvalId)}/claim`;

    // Separation of duties holds on the lane: the submitter is refused 403.
    expect((await author.post(CLAIM, {})).status).toBe(403);
    expect((await getApproval(submitted.approvalId))?.status).toBe('pending');

    // A different manage-holder approves from the lane → the publication COMPLETES.
    const approver = client();
    await approver.login('user:lane-approver', TENANT);
    const claim = await approver.post(CLAIM, { note: 'looks good' });
    expect(claim.status, JSON.stringify(await claim.clone().json().catch(() => ({})))).toBe(200);
    const claimBody = await claim.json() as { status?: string; candidateId?: string; challengeId?: string };
    expect(claimBody.status).toBe('approved');
    expect(claimBody.candidateId).toBe(candidateId);
    expect((await getApproval(submitted.approvalId))?.status).toBe('approved');

    const view = await (await approver.get(`${CB}/candidates/${candidateId}/publication`)).json() as { state?: string; completedBy?: string };
    expect(view.state, 'the inbox approve resolved the approval but never ran the publication act').toBe('completed');
    expect(view.completedBy).toBeDefined();
    const pub = await (await approver.get(`${KB}/challenges/${challengeId}/versions/1`)).json() as { status: string };
    expect(pub.status).toBe('published');

    // A second decision on the same approval is a typed 409, never a re-publish.
    expect((await approver.post(CLAIM, {})).status).toBe(409);
    const cand = await (await approver.get(`${CB}/candidates/${candidateId}`)).json() as { state?: string };
    expect(cand.state).toBe('published');
  });

  it('the GENERIC decision lane rejects: a reject resolves the approval and the candidate reads as returned', async () => {
    const author = client();
    await author.login('user:lane-author-2', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author);
    const submitted = await (await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 })).json() as { approvalId: string };
    const approver = client();
    await approver.login('user:lane-approver-2', TENANT);
    const reject = await approver.post(`/v1/host/openwop-app/approvals/${encodeURIComponent(submitted.approvalId)}/reject`, { note: 'day 3 overclaims' });
    expect(reject.status).toBe(200);
    expect((await getApproval(submitted.approvalId))?.status).toBe('rejected');
    const pub = await (await approver.get(`${KB}/challenges/${challengeId}/versions/1`)).json() as { status: string };
    expect(pub.status).not.toBe('published');
    const needs = await (await author.get(`${CB}/needs-you`)).json() as { rows?: Array<{ candidateId?: string; kind?: string; detail?: string }> };
    const returned = (needs.rows ?? []).find((r) => r.candidateId === candidateId && r.kind === 'returned');
    expect(returned, 'a rejected publication must surface as "returned" in the creator\'s Needs-you queue').toBeDefined();
    expect(returned?.detail).toBe('day 3 overclaims');
  });

  it('a claim entailed ONLY by a blocked (TED-class) source fails the submit gate', async () => {
    const author = client();
    await author.login('user:pub-ted', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author, { tedOnlyClaim: true });
    const res = await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    expect(res.status).toBe(409);
    const body = await res.json() as { details?: { gate?: string } };
    expect(JSON.stringify(body)).toContain('claims');
  });

  it('a candidate with no dossier cannot submit (evidence gate)', async () => {
    const author = client();
    await author.login('user:pub-bare', TENANT);
    const cand = await (await author.post(`${CB}/candidates`, { topic: 'Tidy desk habit' })).json() as { id: string };
    const draft = await (await author.post(`${KB}/challenges`, {
      title: 'Tidy Desk', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 't1', day: 1, title: 'Clear it', instructions: '', evidencePolicy: 'attestation' }],
    })).json() as { id: string };
    const res = await author.post(`${CB}/candidates/${cand.id}/submit-publication`, { challengeId: draft.id, challengeVersion: 1 });
    expect(res.status).toBe(409);
  });
});
