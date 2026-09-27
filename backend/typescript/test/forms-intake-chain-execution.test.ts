/**
 * ADR 0246 (STRAT-PORTAL) — execute `forms-intake.route-submission` END TO END
 * through the REAL production path: a public form submit → `recordSubmission` →
 * `emitHostEvent('host.forms.submission.created')` → the bound workflow starts
 * through `startWorkflowRun` → the REAL executor runs the REAL nodes
 * (`feature.forms.nodes.get-submission` over `ctx.features.forms`, then
 * `feature.priority-matrix.nodes.submit-idea` over `ctx.features['priority-
 * matrix']`). Mirrors the `crm-ops.route-new-lead` precedent
 * (`crm-chain-execution.test.ts`). Pins the two things a static expansion test
 * can't: the anonymous submitter's values are re-fetched under authz and land
 * as an idea on the OWNER-configured list, and a form with NO intake binding
 * cleanly no-ops (the conditional edge).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createHostEventBinding } from '../src/host/hostEventDispatcher.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'priority-matrix']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:formschain-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `fc-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const PM = '/v1/host/openwop-app/priority-matrix';
const forg = (orgId: string, s = ''): string => `/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}${s}`;
const pub = (formId: string): string => `/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`;

/** Register + bind the bridge chain to this tenant. */
async function bindChain(tenantId: string): Promise<string> {
  const found = getChain('forms-intake.route-submission');
  expect(found, 'forms-intake.route-submission must load at boot').toBeTruthy();
  const expanded = expandChain(found!.chain, { params: {} });
  registerWorkflow(expanded);
  const binding = await createHostEventBinding({ tenantId, eventType: 'host.forms.submission.created', workflowId: expanded.workflowId, createdBy: 'test' });
  return binding.bindingId;
}

async function waitForRun(tenantId: string, bindingId: string): Promise<RunRecord | undefined> {
  let run: RunRecord | undefined;
  for (let i = 0; i < 80 && (!run || run.status === 'pending' || run.status === 'running'); i++) {
    const runs = await storage.listRuns({ tenantId, limit: 50 });
    run = runs.find((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === bindingId);
    if (!run || run.status === 'pending' || run.status === 'running') await new Promise((res) => setTimeout(res, 25));
  }
  return run;
}

/** WF-FORM-1 — the outputs the chain's PRIMARY terminal (`done`) actually
 *  emitted, read off the run event log. The run summary carries no aggregate
 *  output field, and asserting against the whole record would pass on any
 *  incidental mention of the id; this reads the one map the port-qualified edge
 *  is supposed to fill. */
async function terminalOutput(owner: Client, runId: string): Promise<unknown> {
  const events = (await owner.get(`/v1/runs/${runId}/events/poll`)).body as { events?: Array<Record<string, unknown>> };
  const done = (events.events ?? []).filter((e) => String(e.type ?? '').includes('node')
    && String(JSON.stringify(e)).includes('_done'));
  return done.map((e) => (e.payload as { outputs?: unknown } | undefined)?.outputs ?? (e as { outputs?: unknown }).outputs);
}

describe('forms-intake.route-submission — end-to-end (ADR 0246)', () => {
  it('a bound form files a public submission as an idea on the owner-configured list', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Feature requests' })).body.id as string;
    expect(listId).toBeTruthy();

    // Owner creates + publishes a form BOUND to that list (title ← `summary`).
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Request a feature',
      fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }, { key: 'detail', label: 'Detail', type: 'textarea', required: false }],
      intakeBinding: { listId, titleField: 'summary', notesField: 'detail' },
    });
    expect(form.status, JSON.stringify(form.body)).toBe(201);
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);

    const bindingId = await bindChain(tenantId);

    // The anonymous public submit — the ONLY thing the submitter controls.
    const sub = await client().post(pub(formId), { values: { summary: 'Dark mode please', detail: 'Easier on the eyes at night.' } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const submissionId = sub.body.submissionId as string;

    const run = await waitForRun(tenantId, bindingId);
    expect(run?.status, `run did not complete: ${JSON.stringify(run)}`).toBe('completed');

    // The idea landed on the OWNER-configured list, titled from the bound field.
    const ideas = (await owner.get(`${PM}/lists/${listId}/ideas`)).body.ideas as Array<{ card: { id: string; title: string } }>;
    const filed = ideas.find((r) => r.card.title === 'Dark mode please');
    expect(filed, JSON.stringify(ideas)).toBeTruthy();

    // ADR 0247 OQ-5 — the idea's intake overlay carries the form provenance.
    const intake = (await owner.get(`${PM}/lists/${listId}/ideas/${filed!.card.id}/intake`)).body.intake as { sourceChannel?: string; sourceSubmissionId?: string };
    expect(intake?.sourceChannel).toBe('form');
    expect(intake?.sourceSubmissionId).toBe(submissionId);
  });

  it('a deleted bound list still CAPTURES the submission AND completes the run cleanly (ADR 0247 OQ-2, RFC 0125)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Doomed list' })).body.id as string;
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Request', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }],
      intakeBinding: { listId, titleField: 'summary' },
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);
    const bindingId = await bindChain(tenantId);

    // The owner deletes the bound list AFTER binding — submit-idea will 404.
    expect((await owner.del(`${PM}/lists/${encodeURIComponent(listId)}`)).status).toBe(204);

    // The submission is ALWAYS captured (recordSubmission persists before the
    // emit) — the lead is never lost, even though routing can't file it.
    const sub = await client().post(pub(formId), { values: { summary: 'orphaned' } });
    expect(sub.status).toBe(201);
    const subs = (await owner.get(forg(orgId, `/forms/${formId}/submissions`))).body.submissions as unknown[];
    expect(subs.length).toBe(1);

    // submit-idea 404s on the deleted list — but the chain's `done` terminal is
    // reached from `file` by an `all_complete` edge (RFC 0125 fan-in / error-
    // routing, now Active + carried through expansion by this host). So `done`
    // fires whether the file step succeeded OR failed, and the run COMPLETES
    // cleanly instead of failing. This is the ADR 0247 OQ-2 close: a stale
    // binding degrades gracefully — the lead is captured, no noisy failed run.
    const run = await waitForRun(tenantId, bindingId);
    expect(run?.status, `expected the stale-binding run to complete cleanly (OQ-2 / RFC 0125): ${JSON.stringify(run)}`).toBe('completed');
  });

  it('a form with NO intake binding cleanly no-ops (run completes, files nothing)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Unbound list' })).body.id as string;
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Contact us', fields: [{ key: 'msg', label: 'Message', type: 'textarea', required: true }],
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);
    const bindingId = await bindChain(tenantId);

    expect((await client().post(pub(formId), { values: { msg: 'just saying hi' } })).status).toBe(201);
    const run = await waitForRun(tenantId, bindingId);
    expect(run?.status, `run did not complete: ${JSON.stringify(run)}`).toBe('completed');
    // No idea filed anywhere on the (unbound) list.
    const ideas = (await owner.get(`${PM}/lists/${listId}/ideas`)).body.ideas as unknown[];
    expect(ideas.length).toBe(0);
  });

  it('a blank OPTIONAL title field falls back to the form title — run completes, not fails (grade-code BE#2)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Feedback' })).body.id as string;
    // titleField bound to an OPTIONAL field; the submitter leaves it blank.
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Beta feedback',
      fields: [{ key: 'headline', label: 'Headline', type: 'text', required: false }, { key: 'body', label: 'Body', type: 'textarea', required: true }],
      intakeBinding: { listId, titleField: 'headline', notesField: 'body' },
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);
    const bindingId = await bindChain(tenantId);

    expect((await client().post(pub(formId), { values: { body: 'love it' } })).status).toBe(201); // headline blank
    const run = await waitForRun(tenantId, bindingId);
    // Before BE#2 this failed (submit-idea 400 on empty title). Now it completes.
    expect(run?.status, `run did not complete: ${JSON.stringify(run)}`).toBe('completed');
    const ideas = (await owner.get(`${PM}/lists/${listId}/ideas`)).body.ideas as Array<{ card: { title: string } }>;
    expect(ideas.some((r) => r.card.title === 'Beta feedback'), JSON.stringify(ideas)).toBe(true);
  });

  /**
   * WF-FORM-1 (ADR 0584) — the declared output was structurally unreachable.
   *
   * `outputRole:'primary'` lands on `done` (the LAST terminal in declaration
   * order), `core.flow.noop` returns exactly `{value: ctx.inputs.value}`, and
   * the `file → done` edge was BARE — so `done` received `{cardId,title,status}`,
   * a map with no key named `value`, and every run reported `{value: undefined}`.
   * Three consequences, all closed by port-qualifying both ends: the declared
   * output `cardId` could never be read, the run's deliverable artifact was
   * always empty, and — the one that matters operationally — the ADR 0247 OQ-2
   * DEGRADE path (bound list deleted ⇒ `file` fails ⇒ `all_complete` still fires
   * `done`) was byte-identical at the run boundary to a successful file.
   */
  it('WF-FORM-1: a filed run carries the card id in its output, and a DEGRADED run does not', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Reachable output' })).body.id as string;
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Ideas', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }],
      intakeBinding: { listId, titleField: 'summary' },
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);
    const bindingId = await bindChain(tenantId);

    expect((await client().post(pub(formId), { values: { summary: 'Reachable at last' } })).status).toBe(201);
    const run = await waitForRun(tenantId, bindingId);
    expect(run?.status).toBe('completed');
    const runId = run!.runId;
    const filed = (await owner.get(`${PM}/lists/${listId}/ideas`)).body.ideas as Array<{ card: { id: string } }>;
    expect(filed).toHaveLength(1);
    const cardId = filed[0]!.card.id;
    // The whole point: the run's OUTPUT names the card it filed. Before this
    // change it was `{value: undefined}` on every path, so the filed run and the
    // degraded run below were byte-identical here.
    // Read the TERMINAL's own outputs off the run event log: `done` is the
    // `outputRole:'primary'` node, so what it emits IS the run's aggregate
    // output and its `role:'deliverable'` artifact.
    const doneOutput = await terminalOutput(owner, runId);
    expect(JSON.stringify(doneOutput), `done emitted ${JSON.stringify(doneOutput)}`).toContain(cardId);

    // …and the degrade path is now DISTINGUISHABLE: same chain, deleted list.
    const gone = await ownerOrg();
    const goneList = (await gone.owner.post(`${PM}/lists`, { orgId: gone.orgId, name: 'Doomed' })).body.id as string;
    const goneForm = await gone.owner.post(forg(gone.orgId, '/forms'), {
      title: 'Ideas', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }],
      intakeBinding: { listId: goneList, titleField: 'summary' },
    });
    const goneFormId = goneForm.body.formId as string;
    expect((await gone.owner.patch(forg(gone.orgId, `/forms/${goneFormId}/status`), { status: 'published' })).status).toBe(200);
    const goneBinding = await bindChain(gone.tenantId);
    expect((await gone.owner.del(`${PM}/lists/${encodeURIComponent(goneList)}`)).status).toBe(204);
    expect((await client().post(pub(goneFormId), { values: { summary: 'orphaned' } })).status).toBe(201);
    const degraded = await waitForRun(gone.tenantId, goneBinding);
    expect(degraded?.status, 'OQ-2 — a stale binding still degrades gracefully').toBe('completed');
    // FRMWF-5 / ADR 0648 D4 — this used to be `not.toContain(cardId)`, where `cardId`
    // is a DIFFERENT tenant's card from the run above. That discriminates "not
    // byte-identical to the other run", which the skip path also satisfies, and it
    // passes on an EMPTY read. The honest boundary claim is that `done` emitted no
    // value at all: `file` failed, so `all_complete` fired `done` with nothing on
    // its `value` input. Assert that directly, on the terminal's own output.
    // `terminalOutput` already maps each `_done` event to its OUTPUTS bag. On the
    // degrade path that bag is absent altogether (the array is `[undefined]`) — a
    // stronger fact than `{value: undefined}`, and discriminating against the filed
    // run above, whose bag carries the card id at :250.
    const outs = (await terminalOutput(gone.owner, degraded!.runId)) as Array<{ value?: unknown } | undefined>;
    expect(outs.length, 'the terminal node must have completed — an empty read is not a witness').toBeGreaterThan(0);
    expect(outs[0]?.value, 'degrade: done must emit NO value — not another tenant\'s id, not a card').toBeUndefined();
  });

  /**
   * WF-FORM-2 (ADR 0584) — a manual run used to be GREEN, EMPTY and SILENT.
   *
   * `required: []` makes this chain zero-config, so the seeder mints a
   * tenant-owned, picker-runnable copy of it. Run it from `/` and there is no
   * `metadata.triggerData`, so `eventTrigger` emits its default `payload: null`,
   * the three ids coerce to `''`, `getSubmission` answers `{found:false}`, the
   * skip branch fired, and the run reported COMPLETED with no output and no
   * message — success-with-empty on a surface a user can click. It is a TYPED
   * failure now, with copy that names the actual mistake.
   */
  it('WF-FORM-2: a MANUAL run (no trigger payload) fails honestly instead of no-opping green', async () => {
    const { owner, tenantId } = await ownerOrg();
    const found = getChain('forms-intake.route-submission');
    const expanded = expandChain(found!.chain, { params: {} });
    registerWorkflow(expanded);
    // Exactly what the `/` picker does: create a run with no trigger payload.
    const created = await owner.post('/v1/runs', { workflowId: expanded.workflowId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = created.body.runId as string;
    let run: RunRecord | undefined;
    for (let i = 0; i < 120; i++) {
      run = (await storage.listRuns({ tenantId, limit: 50 })).find((r) => r.runId === runId);
      if (run && run.status !== 'pending' && run.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(run?.status, `expected a TYPED failure, got: ${JSON.stringify(run)}`).toBe('failed');
    expect(JSON.stringify(run ?? {})).toMatch(/FORMS_SUBMISSION_NOT_FOUND|no submission to route/i);
  });

  /**
   * WF-FORM-5 (ADR 0584 §Correction) — the three branches off `get` are
   * MUTUALLY EXCLUSIVE.
   *
   * They shipped as `equals willFile 'yes'` / `notEquals willFile 'yes'` /
   * `falsy found`, and on a miss the last two were BOTH true: `skip` and
   * `refuse` fired together. The WF-FORM-2 test above passed anyway, because
   * `core.flow.stop-and-error` terminates the run — i.e. it was pinned to a
   * TERMINAL-RESOLUTION rule rather than to the routing, and a change to how
   * this host resolves a terminated run beside a completed noop would have
   * re-greened the manual run silently. Assert the exclusivity itself, in the
   * pack, so the routing is what is pinned.
   */
  it('WF-FORM-5: no two branch conditions off `get` can be satisfied by one output map', () => {
    const chain = getChain('forms-intake.route-submission')!.chain as unknown as {
      dag: { edges: Array<{ from: string; to: string; condition?: { type: string; left?: string; right?: string } }> };
    };
    const branches = chain.dag.edges.filter((e) => e.from === 'get' && e.condition);
    expect(branches.map((b) => b.to).sort()).toEqual(['file', 'refuse', 'skip']);

    // Every branch switches on the SAME single field with `equals`, so at most
    // one can hold for any output map — exclusivity is structural, not a
    // property of what the node happens to emit.
    const fields = new Set(branches.map((b) => b.condition!.left));
    expect(fields.size, `branches read ${[...fields].join(', ')} — one discriminator, or exclusivity is not structural`).toBe(1);
    expect([...new Set(branches.map((b) => b.condition!.type))]).toEqual(['equals']);
    const values = branches.map((b) => b.condition!.right);
    expect(new Set(values).size, 'two branches on the same value would both fire').toBe(values.length);

    // And the OLD shape must not creep back: `falsy` beside a `notEquals` on a
    // two-valued field is exactly the overlap this closed.
    expect(branches.some((b) => b.condition!.type === 'falsy' || b.condition!.type === 'notEquals')).toBe(false);
  });

  /**
   * FORM-QUAR-1 (ADR 0584 §Correction) — a QUARANTINED submission is never
   * filed as intake.
   *
   * The host does not fire `host.forms.submission.created` for a held row, so
   * this path is not reachable through the normal trigger — which is precisely
   * why it needed closing at the NODE: that absence is not a refusal, and a
   * tenant who binds this chain to another trigger (or authors one over
   * `list-submissions`, which returns flagged rows) would file bot leads as
   * real intake. Driven here through the surface + node directly, because the
   * defect is that the guard did not exist, not that the event fires.
   */
  it('FORM-QUAR-1: `get-submission` answers willFile:no / route:skip for a held submission', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Should stay empty' })).body.id as string;
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Ideas', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }],
      intakeBinding: { listId, titleField: 'summary' },
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);

    // A honeypot trip on a form that IS bound — the case where the only thing
    // between a bot and the owner's intake board was the un-fired event.
    expect((await client().post(pub(formId), { values: { summary: 'buy pills', _hp_ref: 'x' } })).status).toBe(201);
    const held = (await owner.get(forg(orgId, `/forms/${formId}/submissions`))).body.submissions[0] as { submissionId: string; flagged?: string };
    expect(held.flagged).toBe('honeypot');

    const { buildFormsSurface } = await import('../src/features/forms/surface.js');
    // Through the pack's exported node MAP — the same lookup the resolver does,
    // and the shape `test/feature-packs.d.ts` declares.
    const node = (await import('../../../packs/feature.forms.nodes/index.mjs')).nodes['feature.forms.nodes.get-submission']!;
    const surface = buildFormsSurface({ tenantId } as never);
    const out = await node({
      features: { forms: surface },
      inputs: { orgId, formId, submissionId: held.submissionId },
    });
    expect(out.status).toBe('success');
    // Found — so this is NOT the "nothing to route" refusal — and yet refused.
    expect(out.outputs!.found).toBe(true);
    expect(out.outputs!.flagged).toBe('honeypot');
    expect(out.outputs!.willFile).toBe('no');
    expect(out.outputs!.route).toBe('skip');
  });

  it('FORM-QUAR-1: a CLEAN submission on the same bound form still files (the guard is not a blanket)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const listId = (await owner.post(`${PM}/lists`, { orgId, name: 'Real intake' })).body.id as string;
    const form = await owner.post(forg(orgId, '/forms'), {
      title: 'Ideas', fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }],
      intakeBinding: { listId, titleField: 'summary' },
    });
    const formId = form.body.formId as string;
    expect((await owner.patch(forg(orgId, `/forms/${formId}/status`), { status: 'published' })).status).toBe(200);
    expect((await client().post(pub(formId), { values: { summary: 'a real request' } })).status).toBe(201);
    const row = (await owner.get(forg(orgId, `/forms/${formId}/submissions`))).body.submissions[0] as { submissionId: string };

    const { buildFormsSurface } = await import('../src/features/forms/surface.js');
    // Through the pack's exported node MAP — the same lookup the resolver does,
    // and the shape `test/feature-packs.d.ts` declares.
    const node = (await import('../../../packs/feature.forms.nodes/index.mjs')).nodes['feature.forms.nodes.get-submission']!;
    const out = await node({
      features: { forms: buildFormsSurface({ tenantId } as never) },
      inputs: { orgId, formId, submissionId: row.submissionId },
    });
    expect(out.outputs!.willFile).toBe('yes');
    expect(out.outputs!.route).toBe('file');
  });
});
