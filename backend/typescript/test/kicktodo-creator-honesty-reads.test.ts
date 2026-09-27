/**
 * ADR 0460 Phase 1 — the kicktodo-creator HONESTY READS (gates / simulation / lessons).
 *
 * The whole point of these reads is that the Studio can never paint a status the
 * server can't back. So the tests pin exactly that:
 *
 *  - PARITY (anti-drift): for each reachable throwing gate, the /gates matrix row
 *    carries the SAME gate + the IDENTICAL detail the submit path throws — proving
 *    the read did not fork the predicates (evaluateGates and assertGates share them).
 *  - RIGHTS is display-only: a candidate whose ONLY rights issue is a blocked domain
 *    SUBMITS SUCCESSFULLY while its matrix shows `rights` as an informational-open
 *    row — the row is disclosure, not an enforced pass/fail.
 *  - HONESTY: lessonStatus reports `hasMedia` only when a real media pointer exists,
 *    and exposes NO `enriched` flag (the rich lesson body is ephemeral node output).
 *  - AUTHZ: the reads are manage-gated — an editor (workspace:write, no manage) gets
 *    403 forbidden_scope (not a leaky 404); an admin gets 200.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember, ensurePersonalWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal, userIdFor } from '../src/features/users/usersService.js';
import { sourceHash, setCandidateSimulation, setCandidatePlan } from '../src/features/kicktodo-creator/creatorService.js';
import { setLessonMedia } from '../src/features/kicktodo-creator/lessonAssembly.js';

let BASE: string;
let server: http.Server;

const CB = '/v1/host/openwop-app/kicktodo/creator';
const KB = '/v1/host/openwop-app/kicktodo';
const TENANT = 'tenant-kt-honesty';

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
      // USERS-19 (ADR 0617 D2): a deployment-named tenant (`tenant-kt-honesty`)
      // is NOT a personal shape, so the collapsed `personalTenant === tenantId`
      // cookie no longer grants implicit ownership — only the FIRST login into
      // a tenant is founded as its owner by the seam; every later author here
      // relied on the (SAML-shaped) implicit-owner hole. Seat each author as an
      // explicit owner MEMBER instead (the kicktodo-authz-http precedent), so
      // authority is membership-derived and the reads under test keep working.
      // (`ensurePersonalWorkspace` seeds the owner row idempotently — the same
      // call the seam makes for a tenant's FIRST login.)
      await ensurePersonalWorkspace({ tenantId, ownerSubject: userIdFor(tenantId, subject), name: `Test workspace ${tenantId}` });
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
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

/** A researched candidate + decomposable draft (mirrors the publish suite).
 *  Includes a TED (blocked) source so the `rights` disclosure row is exercised;
 *  the claim is entailed by the GOOD source so the claims gate passes. */
async function setupPublishable(author: ReturnType<typeof client>, tenantId: string, opts?: { tedOnlyClaim?: boolean; simulate?: boolean }) {
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

  if (opts?.simulate ?? true) {
    await setCandidateSimulation(tenantId, cand.id, [
      { sim: 'newcomer', verdict: 'pass', personaSummary: 'ok', findings: [] },
      { sim: 'time-poor', verdict: 'pass', personaSummary: 'ok', findings: [] },
      { sim: 'skeptic', verdict: 'flag', personaSummary: 'skeptical but completes', findings: [{ severity: 'flag', text: 'wants a citation on day 1' }] },
    ]);
  }
  return { candidateId: cand.id, challengeId: draft.id };
}

interface GateRow { gate: string; state: 'pass' | 'open'; detail: string; informational?: boolean }

describe('ADR 0460 — gateStatus parity + rights disclosure', () => {
  it('the 5-gate matrix re-derives the SAME gate + detail the submit path throws (evidence)', async () => {
    const author = client();
    await author.login('user:h-evidence', TENANT);
    // A bare candidate (no dossier) → the evidence gate is the first open one.
    const cand = await (await author.post(`${CB}/candidates`, { topic: 'Tidy desk habit' })).json() as { id: string };
    const draft = await (await author.post(`${KB}/challenges`, {
      title: 'Tidy Desk', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 't1', day: 1, title: 'Clear it', instructions: 'x', evidencePolicy: 'attestation' }],
    })).json() as { id: string };

    const submit = await author.post(`${CB}/candidates/${cand.id}/submit-publication`, { challengeId: draft.id, challengeVersion: 1 });
    expect(submit.status).toBe(409);
    const err = await submit.json() as { message?: string; details?: { gate?: string } };
    expect(err.details?.gate).toBe('evidence');

    const gates = (await (await author.get(`${CB}/candidates/${cand.id}/gates`)).json() as { gates: GateRow[] }).gates;
    const evidence = gates.find((g) => g.gate === 'evidence')!;
    expect(evidence.state).toBe('open');
    expect(evidence.detail).toBe(err.message); // IDENTICAL detail — no forked predicate
  });

  it('parity on the claims gate (a claim entailed only by a blocked source)', async () => {
    const author = client();
    await author.login('user:h-claims', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author, TENANT, { tedOnlyClaim: true });
    const submit = await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    expect(submit.status).toBe(409);
    const err = await submit.json() as { message?: string; details?: { gate?: string } };
    expect(err.details?.gate).toBe('claims');

    const gates = (await (await author.get(`${CB}/candidates/${candidateId}/gates`)).json() as { gates: GateRow[] }).gates;
    const claims = gates.find((g) => g.gate === 'claims')!;
    expect(claims.state).toBe('open');
    expect(claims.detail).toBe(err.message);
  });

  it('parity on the simulation gate (no verdicts recorded)', async () => {
    const author = client();
    await author.login('user:h-sim', TENANT);
    const { candidateId, challengeId } = await setupPublishable(author, TENANT, { simulate: false });
    const submit = await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    expect(submit.status).toBe(409);
    const err = await submit.json() as { message?: string; details?: { gate?: string } };
    expect(err.details?.gate).toBe('simulation');

    const gates = (await (await author.get(`${CB}/candidates/${candidateId}/gates`)).json() as { gates: GateRow[] }).gates;
    const sim = gates.find((g) => g.gate === 'simulation')!;
    expect(sim.state).toBe('open');
    expect(sim.detail).toBe(err.message);
  });

  it('RIGHTS is display-only: a blocked-domain source SUBMITS OK while the matrix flags rights informationally', async () => {
    const author = client();
    await author.login('user:h-rights', TENANT);
    // Claim entailed by the good source (claims pass); a TED source is present (rights blocked).
    const { candidateId, challengeId } = await setupPublishable(author, TENANT);
    const submit = await author.post(`${CB}/candidates/${candidateId}/submit-publication`, { challengeId, challengeVersion: 1 });
    expect(submit.status).toBe(200); // rights blocking does NOT stop publication

    const gates = (await (await author.get(`${CB}/candidates/${candidateId}/gates`)).json() as { gates: GateRow[] }).gates;
    // ADR 0494 P2b added the informational `disputed` row (entailment disagreement).
    expect(gates.map((g) => g.gate)).toEqual(['evidence', 'claims', 'rights', 'disputed', 'safety', 'simulation']);
    const rights = gates.find((g) => g.gate === 'rights')!;
    expect(rights.informational).toBe(true);        // disclosure, not an enforced gate
    expect(rights.state).toBe('open');               // a domain WAS blocked…
    expect(rights.detail).toContain('ted.com');      // …and it's disclosed
    // the ENFORCED gates all pass — that's why submit succeeded
    for (const g of ['evidence', 'claims', 'safety', 'simulation']) {
      expect(gates.find((x) => x.gate === g)!.state).toBe('pass');
    }
  });

  it('gateStatus 404s a candidate from another tenant (no existence leak)', async () => {
    const other = client();
    await other.login('user:h-other', 'tenant-kt-honesty-other');
    expect((await other.get(`${CB}/candidates/does-not-exist/gates`)).status).toBe(404);
  });
});

describe('ADR 0460 — simulationVerdicts (verbatim)', () => {
  it('404 before simulation; verbatim record after', async () => {
    const author = client();
    await author.login('user:h-simread', TENANT);
    const { candidateId } = await setupPublishable(author, TENANT, { simulate: false });
    expect((await author.get(`${CB}/candidates/${candidateId}/simulation`)).status).toBe(404);

    await setCandidateSimulation(TENANT, candidateId, [
      { sim: 'newcomer', verdict: 'pass', personaSummary: 'completes easily', findings: [] },
      { sim: 'time-poor', verdict: 'flag', personaSummary: 'tight but ok', findings: [{ severity: 'flag', text: 'day 5 runs long', day: 5 }] },
      { sim: 'skeptic', verdict: 'pass', personaSummary: 'convinced by evidence', findings: [] },
    ]);
    const sim = await (await author.get(`${CB}/candidates/${candidateId}/simulation`)).json() as { verdicts: Array<{ sim: string; verdict: string; findings: unknown[] }>; recordedAt: string };
    expect(sim.recordedAt).toBeTruthy();
    expect(sim.verdicts.map((v) => v.sim).sort()).toEqual(['newcomer', 'skeptic', 'time-poor']);
    const tp = sim.verdicts.find((v) => v.sim === 'time-poor')!;
    expect(tp.verdict).toBe('flag');
    expect(tp.findings).toEqual([{ severity: 'flag', text: 'day 5 runs long', day: 5 }]); // verbatim
  });
});

describe('ADR 0460 — lessonStatus (durable signals only, no painted `enriched`)', () => {
  it('reports planned + hasMedia per day; hasMedia false until a real pointer; NO enriched flag', async () => {
    const author = client();
    await author.login('user:h-lessons', TENANT);
    const { candidateId } = await setupPublishable(author, TENANT);

    // No plan yet ⇒ empty (candidate exists, so not 404).
    expect((await (await author.get(`${CB}/candidates/${candidateId}/lessons`)).json() as { lessons: unknown[] }).lessons).toEqual([]);

    await setCandidatePlan(TENANT, candidateId, {
      title: 'Gratitude Notes', promise: 'p', audience: 'a', durationDays: 2, dailyMinutesBudget: 15,
      outcomes: [], achievements: [],
      days: [
        { day: 1, stableActivityId: 'g1', title: 'Day 1', actionInstruction: 'do', userFacingWhy: 'why', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'note' },
        { day: 2, stableActivityId: 'g2', title: 'Day 2', actionInstruction: 'do', userFacingWhy: 'why', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'note' },
      ],
    });

    let lessons = (await (await author.get(`${CB}/candidates/${candidateId}/lessons`)).json() as { lessons: Array<Record<string, unknown>> }).lessons;
    expect(lessons.map((l) => l.day)).toEqual([1, 2]);
    expect(lessons.every((l) => l.planned === true)).toBe(true);
    expect(lessons.every((l) => l.hasMedia === false)).toBe(true);
    // Honesty: no `enriched` key anywhere (would be painted status — no host SSoT).
    expect(lessons.some((l) => 'enriched' in l)).toBe(false);

    // Add a real media pointer for day 1 only.
    await setLessonMedia({ tenantId: TENANT, candidateId, day: 1, assetId: 'asset-1', kind: 'image' });
    lessons = (await (await author.get(`${CB}/candidates/${candidateId}/lessons`)).json() as { lessons: Array<Record<string, unknown>> }).lessons;
    const d1 = lessons.find((l) => l.day === 1)!;
    const d2 = lessons.find((l) => l.day === 2)!;
    expect(d1.hasMedia).toBe(true);
    expect(d1.mediaKind).toBe('image');
    expect(d2.hasMedia).toBe(false);
    expect('mediaKind' in d2).toBe(false);
  });
});

describe('ADR 0460 — the reads are manage-gated (editor 403, admin 200)', () => {
  let wsTenant: string;
  let editorCookie: string;
  let adminCookie: string;
  let candidateId: string;

  const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
    const now = Math.floor(Date.now() / 1000);
    return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  };
  const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<string> => {
    const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
    await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
    return craftCookie(user.userId, wsTenant, personalTenant);
  };
  const call = async (cookie: string, method: string, path: string) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie } });
    return { status: res.status, body: await res.json().catch(() => undefined) as { error?: string; code?: string } | undefined };
  };

  beforeAll(async () => {
    const ws = await createWorkspace({ name: 'KT Studio Honesty', ownerSubject: 'oidc:h-owner' });
    wsTenant = ws.tenantId;
    editorCookie = await seatMember('oidc:h-editor', ['editor'], 'ws:home-h-editor');
    adminCookie = await seatMember('oidc:h-admin', ['admin'], 'ws:home-h-admin');
    // Build a candidate in the workspace tenant as the admin (has manage).
    const admin = client();
    // admin cookie is a crafted seated cookie; drive candidate creation via the service-authenticated route using the admin cookie.
    const mk = await fetch(`${BASE}${CB}/candidates`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'Admin-made challenge' }) });
    candidateId = (await mk.json() as { id: string }).id;
    void admin;
  });

  it('an editor (workspace:write, NO manage) gets 403 forbidden_scope on each read — not a leaky 404', async () => {
    for (const path of [`/candidates/${candidateId}/gates`, `/candidates/${candidateId}/simulation`, `/candidates/${candidateId}/lessons`]) {
      const r = await call(editorCookie, 'GET', `${CB}${path}`);
      expect(r.status).toBe(403);
      expect((r.body?.error ?? r.body?.code ?? '')).toContain('forbidden_scope');
    }
  });

  it('an admin (host:kicktodo:manage) gets 200 on the gates read', async () => {
    const r = await call(adminCookie, 'GET', `${CB}/candidates/${candidateId}/gates`);
    expect(r.status).toBe(200);
  });
});

describe('SCREEN_POLISH — the precise Needs-You queue (/needs-you)', () => {
  interface Row { candidateId: string; topic: string; kind: string; detail: string; count?: number }
  const fetchRows = async (c: ReturnType<typeof client>): Promise<Row[]> =>
    ((await (await c.get(`${CB}/needs-you`)).json()) as { rows: Row[] }).rows;

  it('planned+gates-open surfaces; pending publication does NOT (it waits on the approver); rejection returns with the note VERBATIM', async () => {
    const author = client();
    await author.login('user:h-needsyou', TENANT);

    // (1) A PLANNED candidate with an enforced gate open (no simulation).
    const a = await setupPublishable(author, TENANT, { simulate: false });
    const { setCandidateDraft } = await import('../src/features/kicktodo-creator/creatorService.js');
    await setCandidateDraft(TENANT, a.candidateId, a.challengeId, 1);
    let rows = await fetchRows(author);
    const gatesRow = rows.find((r) => r.candidateId === a.candidateId);
    expect(gatesRow?.kind).toBe('gates-open');
    expect(gatesRow?.count ?? 0).toBeGreaterThan(0);
    expect((gatesRow?.detail ?? '').length).toBeGreaterThan(0); // the verbatim assertGates message

    // (2) A submitted publication PENDING approval — waits on the APPROVER,
    // never the creator: no row.
    const b = await setupPublishable(author, TENANT);
    const submitted = await (await author.post(`${CB}/candidates/${b.candidateId}/submit-publication`, {
      challengeId: b.challengeId, challengeVersion: 1,
    })).json() as { approvalId: string };
    rows = await fetchRows(author);
    expect(rows.find((r) => r.candidateId === b.candidateId)).toBeUndefined();

    // (3) REJECTED with a note → returned-with-feedback, the note verbatim.
    const { resolveApproval } = await import('../src/host/approvalService.js');
    await resolveApproval(submitted.approvalId, { status: 'rejected', note: 'Day 1 needs a citation.' });
    rows = await fetchRows(author);
    expect(rows.find((r) => r.candidateId === b.candidateId)).toMatchObject({
      kind: 'returned',
      detail: 'Day 1 needs a citation.',
    });
  });
});
