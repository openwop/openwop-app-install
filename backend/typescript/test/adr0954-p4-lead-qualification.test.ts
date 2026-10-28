/**
 * ADR 0954 P4a — lead qualification assessments (D4) and the widget's
 * qualification answers (D7).
 *
 * Exit criteria (witnessed):
 *  - ungrounded evidence gives a typed failure: an answer citing a ref the run
 *    never read (or an unknown criterion, or an out-of-range value) is refused,
 *    the node repairs ONCE with the errors fed back, and then the run fails with
 *    `assessment_ungrounded`; nothing is recorded and no grade is written;
 *  - the widget cannot write a grade: `crm.lead.qualify` stores only the
 *    visitor's own statement, which is evidence an assessment may cite and
 *    never a signal; and it is HOLD-ONLY (an auto-run grant is refused, and a
 *    call on an auto-run surface is held), so a visitor typing an existing
 *    contact's email attaches nothing without an operator;
 *  - a band adjustment is recorded `pending` and does not move the band. The
 *    ADR 0942 gate that would decide it is P4b (not on main).
 * plus: a grounded assessment feeds `qualifier.*` signals deterministically; one
 * repair can succeed; an older run cannot record an assessment; the qualify
 * route refuses a model without criteria and is client-scoped; erasure removes
 * stated answers and assessments.
 *
 * Sabotage-witnessed (P4): dropping `anonHitlOnly` from the tool reds the
 * hold-only case (both legs); dropping the `readRefs` membership check reds the
 * invented-ref case; removing the repair round reds "one repair can succeed";
 * reading a qualifier signal from stated answers instead of the assessment reds
 * "the widget cannot write a grade".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCallRequest, AiCallResult, AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const ai = vi.hoisted(() => ({ calls: [] as AiCallRequest[], queue: [] as unknown[], providerCalls: 0 }));
vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  const mock = await import('../src/providers/dispatchMock.js');
  return {
    ...actual,
    createAiProvidersAdapter: ((...args: Parameters<typeof actual.createAiProvidersAdapter>) => {
      const real = actual.createAiProvidersAdapter(...args);
      const scope = args[0]; let programmed = false;
      return {
        ...real,
        callAI: async (req: AiCallRequest): Promise<AiCallResult> => {
          ai.calls.push(req);
          if (!programmed && ai.queue.length > 0) {
            mock.programMockForRun(scope.runId, scope.nodeId, ai.queue.splice(0).map((data) => ({ content: JSON.stringify(data) })));
            programmed = true;
          }
          return real.callAI({ ...req, provider: 'mock', model: 'qualification-test' });
        },
      };
    }) as typeof actual.createAiProvidersAdapter,
  };
});

vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return { ...actual, dispatchChat: async (...args: Parameters<typeof actual.dispatchChat>) => { ai.providerCalls += 1; return actual.dispatchChat(...args); } };
});

import { toWireRunId, fromWireRunId } from '../src/host/v2Ids.js';
import { readLeadAssessments, listLeadProfiles } from '../src/features/crm/leadIntel/leadStore.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { runAnonReadTurn } from '../src/host/anonymousActor.js';
import { createScopedAgentToolProvider } from '../src/host/agentToolProvider.js';
import { provisionWidget } from '../src/features/chat-widget/widgetService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createContact, findContactByEmail } from '../src/features/crm/contactsService.js';
import { createActivity, makeLinkValidators } from '../src/features/crm/crmEntitiesService.js';
import { CRM_LEAD_QUALIFY_TOOL_ID } from '../src/features/crm/agentTools.js';
import { bindLead, getLeadGrade } from '../src/features/crm/leadIntel/leadStore.js';
import { activateModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';
import { computeGrade } from '../src/features/crm/leadIntel/grading.js';
import { getAssessmentForRun, validateAssessment } from '../src/features/crm/leadIntel/assessment.js';
import { getStatedAnswers, recordStatedAnswers } from '../src/features/crm/leadIntel/statedAnswers.js';
import { eraseLeadIntelSubject } from '../src/features/crm/leadIntel/erasure.js';
import { LEAD_INTEL_TOGGLE } from '../src/features/crm/leadIntel/constants.js';
import type { QualificationCriterion } from '../src/features/crm/leadIntel/model.js';

let BASE: string;
let hostSuite: HostAdapterSuite;
let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let admin: string;
let o1: string;
let onlyB: string;
let model: { modelId: string; version: number };
const cookies: Record<string, string> = {};

const CRITERIA: QualificationCriterion[] = [
  { criterionId: 'budget', label: 'Budget', answer: { kind: 'enum', values: ['none', 'small', 'large'] } },
  { criterionId: 'timeline', label: 'Months to purchase', answer: { kind: 'range', min: 0, max: 24 } },
];

const cookieFor = (userId: string, home: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/crm/clients${path}`, {
    method, headers: { cookie: cookies[who]!, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const toggle = async (id: string): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
};
const newLead = async (name: string, email?: string): Promise<string> => {
  const c = await createContact({ tenantId: TENANT, name, email: email ?? `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`, stage: 'lead' });
  await bindLead({ tenantId: TENANT, orgId: orgA, contactId: c.contactId, source: 'form', boundBy: admin });
  return c.contactId;
};
const note = async (contactId: string, body: string): Promise<string> =>
  (await createActivity({ tenantId: TENANT, orgId: orgA, kind: 'call', body, contactId, createdBy: o1, validators: makeLinkValidators(TENANT, orgA) })).activityId;
async function settled(runId: string): Promise<{ status: string; error?: { code: string; message: string } }> {
  for (let i = 0; i < 200; i += 1) {
    const r = await hostExtStorage().getRun(runId);
    if (r && ['completed', 'failed', 'cancelled'].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}
const qualify = async (contactId: string): Promise<string> => {
  const r = await call<{ runId: string }>('admin', 'POST', `/${orgA}/leads/${contactId}/qualify`);
  expect(r.status, r.raw).toBe(202);
  return r.body.runId;
};
async function newAnonymousStatementRun(): Promise<string> {
  return (await runAnonReadTurn({ storage: hostExtStorage(), tenantId: TENANT,
    agent: { agentId: 'a-lead', persona: 'Concierge', systemPrompt: 'You qualify leads.' },
    grant: { read: [], write: [] }, surfaceSessionKey: 'qualification-test:'+randomBytes(8).toString('hex'),
    fencedUserMessage: 'hi', callAIWithTools: async () => ({ content: 'done', toolCalls: [] }),
  })).runId;
}
const answer = (ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  answers: [{ criterionId: 'budget', value: 'large', confidence: 0.9, evidence: [{ ref }] }, { criterionId: 'timeline', value: 3, confidence: 0.7, evidence: [{ ref }] }],
  summary: 'Approved budget, buying within a quarter.', bandAdjustment: 0, ...extra,
});

beforeAll(async () => {
  vi.stubEnv('OPENWOP_MOCK_PROVIDER_ENABLED', 'true');
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  hostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await toggle('crm'); await toggle(LEAD_INTEL_TOGGLE);
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:lq-owner' })).tenantId;
  const mk = async (p: string): Promise<string> => (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:lq-${p}`, source: 'oidc' })).userId;
  admin = await mk('admin'); o1 = await mk('o1'); onlyB = await mk('only-b');
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  for (const u of [o1, onlyB]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: o1, displayName: 'o1', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: onlyB, displayName: 'onlyB', roles: ['editor'] });
  cookies.admin = cookieFor(admin, 'ws:home-admin');
  cookies.onlyB = cookieFor(onlyB, 'ws:home-only-b');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); vi.unstubAllEnvs(); });
// A failing case must not leave scripted replies for the next one.
beforeEach(() => { ai.queue.length = 0; ai.calls.length = 0; ai.providerCalls = 0; });

describe('ADR 0954 D4 — closed-world validation', () => {
  const read = new Set(['activity:a1', 'stated:budget']);
  it('refuses an unknown criterion, an out-of-range value, an invented or unread ref, and an empty assessment', () => {
    const bad = validateAssessment(CRITERIA, {
      answers: [
        { criterionId: 'authority', value: 'yes', confidence: 1, evidence: [{ ref: 'activity:a1' }] },
        { criterionId: 'budget', value: 'huge', confidence: 1, evidence: [{ ref: 'activity:a1' }] },
        { criterionId: 'timeline', value: 3, confidence: 1, evidence: [{ ref: 'activity:invented' }] },
      ],
      summary: 'x', bandAdjustment: 2,
    }, read, read);
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join('\n');
    expect(errors).toMatch(/"authority" is not a criterion/);
    expect(errors).toMatch(/must be one of: none, small, large/);
    expect(errors).toMatch(/"activity:invented" is not in the evidence/);
    expect(errors).toMatch(/bandAdjustment must be -1, 0 or 1/);
    expect(validateAssessment(CRITERIA, { answers: [], summary: 'x', bandAdjustment: 0 }, read, read).ok).toBe(false);
    // Read in this run but deleted since: refused too.
    expect(validateAssessment(CRITERIA, answer('activity:a1'), read, new Set(['stated:budget'])).ok).toBe(false);
    expect(validateAssessment(CRITERIA, answer('activity:a1'), read, read)).toMatchObject({ ok: true });
  });
});

describe('ADR 0954 D4 — the qualify chain', () => {
  beforeAll(async () => {
    const m = await saveModelVersion({ tenantId: TENANT, orgId: orgA, modelId: 'qual', expectedVersion: 0, actor: admin, content: {
      signals: [
        { signalId: 'funnel.view', weight: 1 },
        { signalId: 'qualifier.budget', weight: 50, values: ['large'] },
        { signalId: 'qualifier.timeline', weight: 2, cap: 12 },
      ],
      bands: { A: 100, B: 50, C: 25, D: 10, E: 1 }, criteria: CRITERIA, sla: {},
    } });
    model = { modelId: 'qual', version: m.version };
    await activateModel({ tenantId: TENANT, orgId: orgA, modelId: 'qual', version: m.version, actor: admin, expected: null });
  });

  it('a grounded assessment is recorded and feeds the qualifier signals; the model never sets the grade', async () => {
    const contactId = await newLead('Grounded');
    const act = await note(contactId, 'Budget approved (large). Buying in 3 months.');
    ai.calls.length = 0;
    ai.queue.push(answer(`activity:${act}`, { bandAdjustment: 1, adjustmentReason: 'Strong intent.' }));
    const runId = await qualify(contactId);
    expect((await settled(runId)).status).toBe('completed');
    const a = await getAssessmentForRun(TENANT, orgA, contactId, runId);
    expect(a).toMatchObject({ modelId: 'qual', modelVersion: model.version, adjustment: 'pending', bandAdjustment: 1 });
    // The evidence reached the model only inside the fence, with its refs.
    const prompt = JSON.stringify(ai.calls[0]!.messages);
    expect(prompt).toContain('<UNTRUSTED');
    expect(prompt).toContain(`[activity:${act}]`);
    const grade = (await getLeadGrade(TENANT, orgA, contactId))!;
    expect(grade).toMatchObject({ runId, assessmentRunId: runId, score: 50 + 3 * 2, band: 'B' });
    expect(grade.parts?.['qualifier.budget']).toEqual({ raw: 1, weighted: 50 });
    // The pending +1 did not move the band: B stays B until a person decides (P4b).
    expect((await computeGrade(TENANT, orgA, contactId, model, runId)).band).toBe('B');
    expect((await call<{ assessment: { answers: unknown[] } }>('admin', 'GET', `/${orgA}/leads/${contactId}/assessments/${runId}`)).body.assessment.answers).toHaveLength(2);
  });

  it('ungrounded twice ⇒ one error-fed repair, then a typed assessment_ungrounded failure; nothing recorded', async () => {
    const contactId = await newLead('Ungrounded');
    await note(contactId, 'Spoke briefly.');
    ai.calls.length = 0;
    ai.queue.push(answer('activity:invented'), answer('contact:budget'));
    const runId = await qualify(contactId);
    const run = await settled(runId);
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run.error)).toContain('assessment_ungrounded');
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.messages.at(-1)?.content).toContain('"activity:invented" is not in the evidence');
    expect(await getAssessmentForRun(TENANT, orgA, contactId, runId)).toBeNull();
    expect((await getLeadGrade(TENANT, orgA, contactId))?.runId).toBeUndefined();
    const providerCalls = ai.providerCalls;
    const replayResponse = await fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(runId, TENANT))}:fork`, {
      method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' }, body: JSON.stringify({ mode: 'replay', fromSeq: 0 }),
    });
    const replayBody = await replayResponse.text(); expect(replayResponse.status, replayBody).toBe(201);
    const replayId = fromWireRunId((JSON.parse(replayBody) as { runId: string }).runId, TENANT);
    if (!replayId.ok) throw new Error('Failed-source replay returned a foreign run id');
    const replay = await settled(replayId.runId); expect(replay.status).toBe('failed'); expect(replay.error?.code).toBe('assessment_ungrounded');
    expect(ai.providerCalls).toBe(providerCalls);
    expect((await hostExtStorage().listEvents(replayId.runId, { limit: 2000 })).some((ev) => ev.type === 'replay.diverged')).toBe(false);

  });

  it('one repair can succeed', async () => {
    const contactId = await newLead('Repaired');
    const act = await note(contactId, 'Small budget, maybe next year.');
    ai.queue.push(answer('activity:invented'), { ...answer(`activity:${act}`), answers: [{ criterionId: 'budget', value: 'small', confidence: 0.6, evidence: [{ ref: `activity:${act}` }] }] });
    const runId = await qualify(contactId);
    expect((await settled(runId)).status).toBe('completed');
    expect((await getAssessmentForRun(TENANT, orgA, contactId, runId))?.answers).toHaveLength(1);
  });

  // Superseded-run publication is covered at the physical SQLite write in
  // adr0954-assessment-primary-cas.test.ts, including the crossed newer stamp.

  it.each([false, true])('strict replay resolves the source assessment without another provider dispatch or write (repair=%s)', async (repair) => {
    const contactId = await newLead('Replayed'); const act = await note(contactId, 'Budget approved, buying soon.');
    if (repair) ai.queue.push(answer('activity:invented'));
    ai.queue.push(answer(`activity:${act}`)); const sourceId = await qualify(contactId);
    expect((await settled(sourceId)).status).toBe('completed');
    const providerCalls = ai.providerCalls; expect(providerCalls).toBe(repair ? 2 : 1);
    const grade = await getLeadGrade(TENANT, orgA, contactId);
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(sourceId, TENANT))}:fork`, {
      method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' }, body: JSON.stringify({ mode: 'replay', fromSeq: 0 }),
    });
    const body = await res.text(); expect(res.status, body).toBe(201);
    const decoded = fromWireRunId((JSON.parse(body) as { runId: string }).runId, TENANT);
    if (!decoded.ok) throw new Error('Replay returned a foreign run id');
    const replay = await settled(decoded.runId); expect(replay.status, JSON.stringify(replay)).toBe('completed');
    expect(ai.providerCalls).toBe(providerCalls);
    expect((await hostExtStorage().listEvents(decoded.runId, { limit: 2000 })).some((ev) => ev.type === 'replay.diverged')).toBe(false);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toEqual(grade);
    expect((await readLeadAssessments(TENANT, orgA, contactId)).map((a) => a.runId)).toEqual([sourceId]);
    const nested = await fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(decoded.runId, TENANT))}:fork`, {
      method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' }, body: JSON.stringify({ mode: 'replay', fromSeq: 0 }),
    });
    const nestedBody = await nested.text(); expect(nested.status, nestedBody).toBe(201);
    const nestedId = fromWireRunId((JSON.parse(nestedBody) as { runId: string }).runId, TENANT);
    if (!nestedId.ok) throw new Error('Nested replay returned a foreign run id');
    expect((await settled(nestedId.runId)).status).toBe('completed');
    expect(ai.providerCalls).toBe(providerCalls);
    expect((await hostExtStorage().listEvents(nestedId.runId, { limit: 2000 })).some((ev) => ev.type === 'replay.diverged')).toBe(false);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toEqual(grade);
    const events = await hostExtStorage().listEvents(sourceId, { limit: 2000 });
    expect(JSON.stringify(events.filter((ev) => ev.type === 'node.completed'))).not.toContain('Budget approved, buying soon.');
  });

  it.each(['branch', 'erased-replay'] as const)('a %s cannot obtain fresh qualification write authority or dispatch a provider', async (scenario) => {
    const contactId = await newLead('Closed-or-branched'); const act = await note(contactId, 'Budget approved.');
    ai.queue.push(answer(`activity:${act}`)); const sourceId = await qualify(contactId);
    expect((await settled(sourceId)).status).toBe('completed'); const providerCalls = ai.providerCalls;
    if (scenario === 'erased-replay') await eraseLeadIntelSubject(TENANT, contactId);
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(sourceId, TENANT))}:fork`, {
      method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' },
      body: JSON.stringify({ mode: scenario === 'branch' ? 'branch' : 'replay', fromSeq: 0 }),
    });
    const body = await res.text(); expect(res.status, body).toBe(201);
    const decoded = fromWireRunId((JSON.parse(body) as { runId: string }).runId, TENANT);
    if (!decoded.ok) throw new Error('Fork returned a foreign run id');
    const fork = await settled(decoded.runId); expect(fork.status, JSON.stringify(fork)).toBe('failed');
    expect(fork.error?.code).toBe(scenario === 'branch' ? 'forbidden_scope' : 'conflict');
    expect(ai.providerCalls).toBe(providerCalls);
    if (scenario === 'erased-replay') {
      expect(await getAssessmentForRun(TENANT, orgA, contactId, sourceId)).toBeNull();
      expect(await getLeadGrade(TENANT, orgA, contactId)).toBeNull();
    } else expect((await readLeadAssessments(TENANT, orgA, contactId)).map((a) => a.runId)).toEqual([sourceId]);
  });

  it('a param-less internal qualification chain refuses at its first node before any model call or write', async () => {
    const before = await listLeadProfiles(TENANT, orgA);
    const runId = await startWorkflowRun({ storage: hostExtStorage(), hostSuite }, { tenantId: TENANT, workflowId: 'crm-ops.qualify-lead', inputs: {}, orgScopeSubject: admin });
    if (!runId) throw new Error('The internal qualification chain did not resolve');
    const run = await settled(runId); expect(run.status).toBe('failed'); expect(run.error?.code).toBe('validation_error');
    const events = await hostExtStorage().listEvents(runId, { limit: 2000 });
    const failed = events.filter((ev) => ev.type === 'node.failed'); expect(failed).toHaveLength(1);
    expect(failed[0]?.nodeId).toMatch(/_evidence$/);
    expect(events.some((ev) => ev.type === 'node.started' && /_(assess|grade)$/.test(ev.nodeId ?? ''))).toBe(false);
    expect(ai.providerCalls).toBe(0); expect(await listLeadProfiles(TENANT, orgA)).toEqual(before);
  });

  it('the qualify route refuses a model without criteria and is client-scoped', async () => {
    const contactId = await newLead('Scoped');
    expect((await call('onlyB', 'POST', `/${orgA}/leads/${contactId}/qualify`)).status).toBe(404);
    expect((await call('onlyB', 'GET', `/${orgA}/leads/${contactId}/assessments/x`)).status).toBe(404);
    const c = await createContact({ tenantId: TENANT, name: 'B lead', email: `b-${randomBytes(3).toString('hex')}@example.test`, stage: 'lead' });
    await bindLead({ tenantId: TENANT, orgId: orgB, contactId: c.contactId, source: 'form', boundBy: admin });
    await createMember({ tenantId: TENANT, orgId: orgB, subject: admin, displayName: 'Admin', roles: ['admin'] });
    const r = await call('admin', 'POST', `/${orgB}/leads/${c.contactId}/qualify`); // client B runs v0: no criteria
    expect(r.status, r.raw).toBe(422);
    expect(r.raw).toContain('no_criteria');
  });
});

describe('ADR 0954 D7 — the widget cannot write a grade', () => {
  const AGENT = { agentId: 'a-lead', persona: 'Concierge', systemPrompt: 'You qualify leads.' };
  const scripted = (input: Record<string, unknown>) => {
    let round = 0;
    return async (_r: AiToolCallRequest): Promise<AiToolCallResult> => {
      round += 1;
      return round === 1 ? { content: '', toolCalls: [{ id: 'q1', name: CRM_LEAD_QUALIFY_TOOL_ID, input }] } : { content: 'done', toolCalls: [] };
    };
  };

  it('under hitl the answers are held, not stored', async () => {
    const email = `held-${randomBytes(3).toString('hex')}@example.test`;
    let held = 0;
    await runAnonReadTurn({
      storage: hostExtStorage(), tenantId: TENANT, agent: AGENT,
      grant: { read: [], write: [CRM_LEAD_QUALIFY_TOOL_ID], writeControl: 'hitl' },
      surfaceSessionKey: 'w:q1', fencedUserMessage: 'hi',
      callAIWithTools: scripted({ email, answers: [{ criterionId: 'budget', value: 'large' }] }),
      holdGrantedWrite: async () => { held += 1; return { status: 'held' }; },
    });
    expect(held).toBe(1);
    expect(await findContactByEmail(TENANT, email)).toBeNull();
  });

  it('is hold-only: an auto-run grant is refused, and an auto-run surface still holds the call (no attach to an existing contact)', async () => {
    // Grant time: pairing it with the auto-run control is refused.
    await expect(provisionWidget(TENANT, orgA, admin, {
      agentId: 'core.openwop.agents.lead-concierge.default', allowedDomains: ['acme.test'],
      caps: { maxAutoWritesPerSession: 3 },
      anonToolGrant: { write: [CRM_LEAD_QUALIFY_TOOL_ID], writeControl: 'rate-limit-session-cap' },
    })).rejects.toMatchObject({ code: 'validation_error', details: { field: 'anonToolGrant.writeControl' } });
    // Call time (a grant saved before the rule): the call is HELD, never auto-run,
    // so typing an existing contact's email attaches nothing.
    const email = `victim-${randomBytes(3).toString('hex')}@example.test`;
    const contactId = await newLead('Victim', email);
    let held = 0;
    let autoRun = 0;
    await runAnonReadTurn({
      storage: hostExtStorage(), tenantId: TENANT, agent: AGENT,
      grant: { read: [], write: [CRM_LEAD_QUALIFY_TOOL_ID], writeControl: 'rate-limit-session-cap' },
      surfaceSessionKey: 'w:q-auto', fencedUserMessage: 'hi',
      callAIWithTools: scripted({ email, answers: [{ criterionId: 'budget', value: 'large' }] }),
      autoWriteUnderCap: async () => { autoRun += 1; return { allowed: true }; },
      holdGrantedWrite: async () => { held += 1; return { status: 'held' }; },
    });
    expect({ held, autoRun }).toEqual({ held: 1, autoRun: 0 });
    expect(await getStatedAnswers(TENANT, contactId)).toEqual([]);
  });

  it('once run, it stores the visitor’s statement as evidence only: no grade, no signal', async () => {
    const email = `stated-${randomBytes(3).toString('hex')}@example.test`;
    const contactId = await newLead('Stated', email);
    const before = await getLeadGrade(TENANT, orgA, contactId);
    const provider = createScopedAgentToolProvider({ tenantId: TENANT, runId: await newAnonymousStatementRun() });
    const res = await provider.executeTool({ name: CRM_LEAD_QUALIFY_TOOL_ID, input: { email, answers: [{ criterionId: 'budget', value: 'large' }, { criterionId: 'timeline', value: 2 }] } });
    expect(res.isError, res.content).toBeFalsy();
    expect(res.content).not.toContain(contactId);
    expect((await getStatedAnswers(TENANT, contactId)).map((a) => [a.criterionId, a.value])).toEqual([['budget', 'large'], ['timeline', '2']]);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toEqual(before);
    // The visitor "said large", and the qualifier signal still counts nothing: only
    // an accepted assessment feeds it.
    const live = await computeGrade(TENANT, orgA, contactId, model);
    expect(live.parts['qualifier.budget']).toEqual({ raw: 0, weighted: 0 });
    // A signed-in turn is refused.
    const signedIn = await createScopedAgentToolProvider({ tenantId: TENANT, runId: 'r', actingUserId: admin }).executeTool({ name: CRM_LEAD_QUALIFY_TOOL_ID, input: { email, answers: [{ criterionId: 'budget', value: 'none' }] } });
    expect(signedIn.content).toContain('use_governed_write');
  });

  it('an assessment may cite what the visitor said', async () => {
    const email = `cite-${randomBytes(3).toString('hex')}@example.test`;
    const contactId = await newLead('Cited', email);
    await recordStatedAnswers(TENANT, contactId, [{ criterionId: 'budget', value: 'large' }], await newAnonymousStatementRun());
    const statedRef = `stated:${(await getStatedAnswers(TENANT, contactId))[0]!.submissionId}:budget`;
    ai.queue.push({ answers: [{ criterionId: 'budget', value: 'large', confidence: 0.5, evidence: [{ ref: statedRef }] }], summary: 'Visitor said large.', bandAdjustment: 0 });
    const runId = await qualify(contactId);
    expect((await settled(runId)).status).toBe('completed');
    expect((await getAssessmentForRun(TENANT, orgA, contactId, runId))?.answers[0]?.evidence).toEqual([{ kind: 'form-field', ref: statedRef }]);
  });

  it('erasure removes the stated answers and the assessments', async () => {
    const email = `erase-${randomBytes(3).toString('hex')}@example.test`;
    const contactId = await newLead('Erased', email);
    await recordStatedAnswers(TENANT, contactId, [{ criterionId: 'budget', value: 'small' }], await newAnonymousStatementRun());
    const statedRef = `stated:${(await getStatedAnswers(TENANT, contactId))[0]!.submissionId}:budget`;
    ai.queue.push({ answers: [{ criterionId: 'budget', value: 'small', confidence: 0.5, evidence: [{ ref: statedRef }] }], summary: 'Small.', bandAdjustment: 0 });
    const runId = await qualify(contactId);
    await settled(runId);
    expect(await getAssessmentForRun(TENANT, orgA, contactId, runId)).not.toBeNull();
    await eraseLeadIntelSubject(TENANT, contactId);
    expect(await getStatedAnswers(TENANT, contactId)).toEqual([]);
    expect(await getAssessmentForRun(TENANT, orgA, contactId, runId)).toBeNull();
  });
});
