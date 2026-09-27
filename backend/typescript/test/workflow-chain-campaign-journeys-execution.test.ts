/**
 * campaign-journeys workflow-chain pack — REAL execution (ADR 0222, RFC 0013).
 *
 * Mirrors the `crm-ops.route-new-lead` / `csm-ops.*` / `exec-ops.*` precedents:
 * the REAL expanded definition (loader → `expandChain`), the REAL node
 * implementations (`packs/feature.campaign-journeys.nodes`, `packs/
 * feature.crm.nodes`), the REAL `ctx.features['campaign-journeys']`/
 * `ctx.features.crm` surfaces reading REAL seeded data, and the REAL executor
 * (`executeRun`, dispatched off `POST /v1/runs` — both chains are on-demand,
 * not host-event-triggered here; see the trigger-node note below).
 *
 * MODE CHOSEN: direct run-start for both chains, driven to the sign-off
 * gate's SUSPEND — the same "genuine terminal state, never forced past a
 * designed human gate" contract `csm-ops.renewal-risk` established. For
 * `re-engage-contact` this test additionally RESUMES the gate (`POST
 * /v1/interrupts/:token`, the `chat-suspend-resume.test.ts` mechanic) to
 * drive the chain all the way to `completed`, because doing so is the only
 * way to prove the `orgId` fix on the follow-up-task node with real data.
 *
 * ============================================================================
 * HEADLINE FINDING — node-level `inputs` is silently dropped by the shared
 * validator, breaking `enroll`'s hardcoded `journeyId` on EVERY real-executor
 * invocation of EITHER chain (found while writing this test; documented here
 * because it is NOT fixable inside `examples/workflow-chain-packs/campaign-
 * journeys/pack.json` — the fix belongs in shared host code out of this
 * task's edit scope).
 * ============================================================================
 *
 * Both chains wire `enroll`'s per-node `inputs` block with a hardcoded
 * `journeyId` literal (`"welcome-series"` / `"re-engage"`) plus a
 * `"{{params.contactId}}"` token — e.g. `{"id":"enroll", …, "inputs":
 * {"journeyId":"welcome-series","contactId":"{{params.contactId}}"}}`. This
 * is the ONLY place either chain declares `journeyId` at all (it is not a
 * chain `parameter` — it's meant to be a per-chain constant baked in at
 * authoring time).
 *
 * `expandChain` (`workflowChainPackLoader.ts:430`) faithfully copies that
 * block onto the expanded node (`...(n.inputs ? {inputs: renameParamTokens
 * (n.inputs)} : {})`), and `WorkflowDefinition.nodes[].inputs` is a
 * documented, type-declared field for exactly this purpose ("per-port input
 * declarations from the fixture's `inputs:` block", `executor/types.ts`
 * ~826-833). But `expandChain` immediately re-validates its own output
 * through `validateWorkflowDefinition` and RETURNS that result
 * (`workflowChainPackLoader.ts:469`, `return validateWorkflowDefinition
 * (definition)`) — and that validator's per-node mapper
 * (`workflowDefinitionValidation.ts:203-208`) copies only `{nodeId, typeId,
 * config?, outputRole?}` onto the returned node. `inputs` is never in the
 * allow-list. Confirmed empirically: `expandChain(getChain('campaign-
 * journeys.welcome-series')!.chain, {params:{…}})` returns nodes with
 * `config: {}` and NO `inputs` key at all for every node that declared one
 * in `pack.json` — the field vanishes between authoring and execution.
 *
 * `feature.campaign-journeys.nodes.enroll` (`packs/feature.campaign-
 * journeys.nodes/index.mjs`) reads `journeyId`/`contactId` from `ctx.inputs`
 * ONLY (`const i = ctx.inputs ?? {}`) — it never merges `ctx.config` the way
 * `feature.crm.nodes`' shared `args(ctx)` helper does. Since chain-level
 * `inputs` never reaches `ctx.inputs`, and `journeyId` isn't reachable via
 * `config` either (the node doesn't read config at all), `enroll` throws
 * `validation_error` ("journeyId and contactId … are required") on every
 * undoctored real-executor run of either chain — 100% reproducible, not a
 * corner case. This is a HOST bug (shared `workflowDefinitionValidation.ts`),
 * not a campaign-journeys pack.json wiring bug, so it is documented here
 * rather than "fixed" — no pack.json-only rewiring closes it without either
 * breaking the chain's documented event-triggered shape or resorting to the
 * workaround below.
 *
 * WORKAROUND THIS TEST USES to still exercise the real chain past `enroll`:
 * `core.trigger.event`'s implementation (`packs/core.openwop.triggers/
 * index.mjs`, `passThrough`) spreads `ctx.triggerData` directly into its own
 * output, and the executor sets `ctx.triggerData = run.metadata.triggerData
 * ?? run.inputs` for every node (`executor.ts` ~466-469) — for a directly
 * started run (no host-event binding) that's exactly `run.inputs`. In
 * `re-engage-contact`, `enroll` has ZERO inbound edges (a graph SOURCE node),
 * so its `ctx.inputs` is `run.inputs` verbatim; in `welcome-series`, `enroll`
 * has one inbound edge from `trigger`, whose OWN output — per the mechanism
 * above — also echoes `run.inputs`. Either way, supplying an UNDOCUMENTED
 * extra `journeyId` key in the `POST /v1/runs` `inputs` payload (outside the
 * chain's own declared `parameters` schema) lands it on `ctx.inputs.journeyId`
 * and routes around the bug. This is flagged as a workaround for an
 * unfixed-in-scope bug, not a supported integration path — a caller
 * following only the chain's documented `parameters` would hit the failure
 * every time.
 *
 * Separately (not exercised by this test, which never uses a host-event
 * binding): `feature.campaign-journeys.nodes`' `contactIdOf` fallback reads
 * `ctx.triggerData.payload.contactId`, but the REAL `host.crm.contact.created`
 * event payload is `{entityType, entityId, …}` (`features/crm/emit.ts`) — no
 * `contactId` key at all. So the pack's own documented "Bind it to
 * host.crm.contact.created (the contact rides the event payload)" invocation
 * mode is ALSO broken, independently of the `journeyId` bug above, by a
 * field-name mismatch in the node pack (`packs/feature.campaign-journeys.
 * nodes/index.mjs`, out of this task's pack.json-only edit scope).
 *
 * ============================================================================
 * BUGS FOUND + FIXED (`examples/workflow-chain-packs/campaign-journeys/
 * pack.json` — in scope):
 * ============================================================================
 *
 * 1. Multi-fan-in port collision (the same defect class as `csm-ops.health-
 *    from-crm` / `exec-ops.*`): `welcome-series`'s `welcome` node (2 inbound:
 *    `signoff`, `gate1`) and `re-engage-contact`'s `send` node (2 inbound:
 *    `signoff`, `gate`) both named neither `sourceOutput` nor `targetInput`
 *    on their fan-in edges, so `buildNodeInputs` (`executor/scheduler.ts`)
 *    clobbered the first edge with the second (edge-array order) into the
 *    shared default port key `'input'`. A full re-scan of the pack found
 *    exactly these two instances — no others (every other multi-node fan-in
 *    in either chain resolves to a single inbound edge). Fixed with explicit
 *    dot-notation target ports (`welcome.signoff`/`welcome.gate1`,
 *    `send.signoff`/`send.gate`).
 *
 *    ASSESSED CONSEQUENCE, per the task's own "cosmetic vs. real" framing:
 *    real but not currently CONSUMED. `core.chat.approvalGate`'s outputs
 *    (`{decision, approved, …}`) are never read by the downstream
 *    `core.openwop.integration.email-send` node — `emailSend` reads only
 *    `ctx.inputs.{to,cc,bcc,subject,text,html}`, none of which `signoff`
 *    produces — so before the fix, `gate1`/`gate`'s data (which DOES contain
 *    a usable `to` field) happened to survive (it's the later edge in the
 *    array) while `signoff`'s data was silently dropped, and nothing in the
 *    current node graph currently depends on `signoff`'s survival. Fixed for
 *    correctness anyway per the task brief — a future node reading `decision`
 *    off this edge would otherwise silently see nothing.
 *
 *    NOTE: this fix does NOT make `welcome`/`followup`/`send` deliver mail
 *    correctly — see the separate, unfixed email-envelope gap below, which
 *    is a consequence of the SAME headline `inputs`-stripping bug, not of
 *    the fan-in collision.
 *
 * 2. Missing `orgId` parameter (the same defect class as `exec-ops.*`):
 *    `re-engage-contact`'s `task` node (`feature.crm.nodes.create-task`) is
 *    ORG-scoped (`crm.createTask({orgId, …})`, `packs/feature.crm.nodes/
 *    index.mjs`) but the chain declared no `orgId` parameter and wired none
 *    into the node at all — so `createTask` always received `orgId: ''`.
 *    Fixed by declaring `orgId` as a required chain parameter and wiring
 *    `config: {"orgId": "{{params.orgId}}"}` on the `task` node (the
 *    established `crm-ops`/`csm-ops`/`exec-ops` convention: literal
 *    templated values go in `config`, never in the dead `inputs` field —
 *    `feature.crm.nodes`' shared `args(ctx)` merges `{...ctx.config,
 *    ...ctx.inputs}`, so `config` values DO survive the stripping bug above,
 *    unlike `feature.campaign-journeys.nodes.enroll`'s inputs-only read).
 *    Also moved the node's `title` off the dead `inputs` field onto `config`
 *    for the same reason — it was equally inert before this fix (the task
 *    was created with an EMPTY title, `str(i.title)` on an always-`{}`
 *    `ctx.inputs`). Dropped the node's `contactId` fixture value entirely:
 *    `feature.crm.nodes.create-task` has no `contactId` parameter at all
 *    (only `orgId`/`taskId`/`title`/`dueDate`/`dealId`) — it was dead weight
 *    either way, a separate node-capability gap (the follow-up task can
 *    never be linked back to the contact) this pack.json cannot fix.
 *
 * ============================================================================
 * ALSO FOUND (and now FIXED — ADR 0237) — a third, independent host bug,
 * surfaced by this test's two negative-path assertions below.
 * ============================================================================
 *
 * `feature.campaign-journeys.nodes.enroll`/`eligibility` signal failure by
 * RETURNING `{status:'failed', error:{code,message}}` (never throwing) — the
 * same convention used throughout this codebase's pack nodes. But
 * `packs/tarballLoader.ts`'s node-execute wrapper (~line 150-154) only
 * special-cases `result.status === 'success'`; for ANY other returned
 * status it unconditionally replaces the outcome with a generic
 * `{status:'failure', error:{code:'pack_node_error', message:'Pack node
 * returned non-success outcome'}}` — silently discarding the node's own,
 * deliberately-computed `error.code` (`not_eligible`, `already_enrolled`,
 * `no_email`, …). The wrapper's `catch` block DOES correctly preserve
 * `error.code` — but only for a THROWN error (the file's own comment: "we
 * don't downgrade errors with `code`… policy-denied / model-not-allowed
 * errors need their canonical code to propagate"), which is why
 * `exec-ops-execution.test.ts`'s `provider_not_supported` assertion (a
 * THROWN error from `ctx.callAI`) sees its real code while this test's
 * `not_eligible`/`already_enrolled` assertions (RETURNED failures) do not.
 * This test asserts the actual, current, reproducible behavior
 * (`error.code === 'pack_node_error'`) rather than the code the node
 * intended, and pins the failing NODE via the debug-bundle's `node.failed`
 * event instead (which is unaffected — it still fails at the right node).
 *
 * FIXED 2026-07-30 — this section previously read "NOT FIXED (out of
 * pack.json's authority)". The claim was that "no upstream node's OUTPUT in
 * either chain carries a `to`/`subject`/`text` key … so there is no
 * pack.json-only edge/config combination that populates them." That is wrong
 * in two ways:
 *
 *  - a dot-notation edge does not need the key names to line up — `{from:
 *    'gate1.email', to: 'welcome.to'}` maps ANY output port onto ANY input
 *    port (`executor/scheduler.ts` `buildInputs`); and
 *  - the upstream node was BUILT to supply exactly this. The eligibility
 *    node's own docstring reads "Eligible ⇒ outputs {email, name} for the
 *    downstream send step" (`packs/feature.campaign-journeys.nodes/
 *    index.mjs`). The producer existed the whole time; the chain simply never
 *    connected it — the same "a capability shipped by one author is invisible
 *    to the next" failure as `feature.kb.nodes.rag` (#2692).
 *
 * `welcome`/`followup`/`send` now take `to` from their gate's `email` output,
 * and their node-level `inputs` use `text` (the key the impl destructures)
 * instead of the non-existent `body`; the bogus `from` input is gone — `from`
 * is config, and `email-send.input.json` is `additionalProperties:false`
 * without it.
 *
 * The observability caveat below still holds and is why this defect survived:
 * `ctx.email.send` degrades every unconfigured-provider call to
 * `{sent:false, error:'email_not_connected'}` (`host/emailAdapter.ts`) without
 * throwing or echoing the attempted `to` back, so a real-executor test cannot
 * distinguish "right recipient, no connection" from "`to: undefined`". The
 * assertion below therefore still pins the degrade — but the wiring itself is
 * now pinned structurally by `chain-email-envelope-wiring.test.ts`.
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

let BASE: string;
let server: http.Server;

let sgCalls = 0;
let sgServer: http.Server | undefined;
beforeAll(async () => {
  // ADR 0655 D2 — a REAL send target so the approval path can complete: a failed
  // send is a typed node failure now, so the old "no provider ⇒ sent:false ⇒ run
  // still completes" shape no longer proves the downstream task lands.
  sgServer = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { sgCalls += 1; res.writeHead(202, { 'x-message-id': `sg-${sgCalls}` }); res.end(); }); });
  await new Promise<void>((r) => sgServer!.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sgServer.address() as AddressInfo).port}`;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  const campaignJourneys = getToggleDefault('campaign-journeys');
  if (campaignJourneys) await saveConfig({ ...campaignJourneys, status: 'on' }, 'test');
});
afterAll(async () => { delete process.env.OPENWOP_SENDGRID_API_BASE; if (sgServer) await new Promise<void>((r) => sgServer!.close(() => r())); await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:cjchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `cjchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId, userId: String(r.body.user?.userId ?? '') };
}
/** ADR 0655 — bind a SendGrid connection to the run's acting user so the executor's
 *  `ctx.email.send` reaches the mock (the brokered egress resolves the USER's connection). */
async function connectSendgrid(tenantId: string, userId: string): Promise<void> {
  const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
  await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId });
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get(`/v1/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get(`/v1/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return (b.body.events as BundleEvent[]) ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

/** Resolve the open interrupt whose nodeId ends with `nodeSuffix` via the
 *  RFC 0093 capability-token resume path (`chat-suspend-resume.test.ts`). */
async function resumeInterrupt(owner: Client, runId: string, nodeSuffix: string, resumeValue: Record<string, unknown>): Promise<void> {
  const ints = await owner.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
  expect(ints.status, JSON.stringify(ints.body)).toBe(200);
  const interrupts = ints.body.interrupts as Array<{ token: string; nodeId: string }>;
  const target = interrupts.find((i) => i.nodeId.endsWith(nodeSuffix));
  expect(target, `expected an open interrupt for a node ending in "${nodeSuffix}": ${JSON.stringify(interrupts)}`).toBeTruthy();
  const resolve = await owner.post(`/v1/interrupts/${target!.token}`, { resumeValue });
  expect([200, 202, 204]).toContain(resolve.status);
}

describe('campaign-journeys.re-engage-contact — end-to-end execution (real executor, direct run-start)', () => {
  it('suspends at the sign-off gate with real eligibility data, then on approval creates the follow-up task in the correct org', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    sgCalls = 0;
    await connectSendgrid(tenantId, userId);
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Quiet Customer', email: 'quiet@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, fromAddress: 'sender@acme.test', orgId, subject: 'We miss you', body: 'Come back!' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    // `journeyId` is the documented workaround for the headline bug (see file
    // header) — `enroll` is this chain's graph SOURCE node, so its
    // `ctx.inputs` is exactly this run-input object.
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { ...params, journeyId: 're-engage' } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `expected the run to suspend at the sign-off gate: ${JSON.stringify(snap)}`).toBe(true);

    const events = await bundleEvents(owner, runId);
    // Real CRM read: the eligibility gate saw the REAL seeded contact.
    expect(completedOutputs(events, 'gate')).toMatchObject({ eligible: true, contactId, email: 'quiet@acme.test', name: 'Quiet Customer' });

    await resumeInterrupt(owner, runId, '_signoff', { decision: 'accept' });

    const done = await pollRun(owner, runId);
    // ADR 0655 D2 (WF-EM-7 / EMWF-5) — this used to pin `completed` with
    // `{sent:false, error:'email_not_connected'}`: a run that mailed nobody
    // completed green. A failed send is now a typed NODE FAILURE (its own test
    // below), so this happy path connects a REAL send target and asserts the send.
    expect(done.status, `run should complete after approval: ${JSON.stringify(done)}`).toBe('completed');
    const doneEvents = await bundleEvents(owner, runId);
    expect(completedOutputs(doneEvents, 'send')).toMatchObject({ sent: true });
    expect(sgCalls, 'the mock provider received exactly one send').toBe(1);

    // BUG-2 fix proof: the follow-up task landed in the RIGHT org.
    const tasks = await owner.get(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/tasks`);
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    const followUp = (tasks.body.tasks as Array<{ title: string }>).find((t) => t.title === 'Follow up on re-engagement');
    expect(followUp, `expected a follow-up task in org ${orgId}: ${JSON.stringify(tasks.body)}`).toBeTruthy();
  });

  // ADR 0655 D2 — with NO email Connection for this tenant, the approved send is a
  // typed NODE FAILURE (`email_not_connected`) and the run FAILS. It used to
  // complete green with `sent:false`.
  it('ADR 0655 D2: with no email Connection the approved send FAILS the run typed (email_not_connected)', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Unwired', email: 'unwired@acme.test' });
    expect(contact.status).toBe(201);
    const contactId = contact.body.contactId as string;
    const found = getChain('campaign-journeys.re-engage-contact');
    const params = { contactId, fromAddress: 'sender@acme.test', orgId, subject: 'Hello', body: 'Hi' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { ...params, journeyId: 're-engage-unwired' } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), JSON.stringify(snap)).toBe(true);
    await resumeInterrupt(owner, runId, '_signoff', { decision: 'accept' });
    const done = await pollRun(owner, runId);
    expect(done.status, JSON.stringify(done)).toBe('failed');
    const failed = (await bundleEvents(owner, runId)).filter((e) => e.type === 'node.failed');
    expect(JSON.stringify(failed)).toContain('email_not_connected');
  });

  // ADR 0655 D1 — checklist item 1: through the REAL executor, a chain send to a
  // SUPPRESSED recipient fails TYPED at the send node with `email_recipient_suppressed`
  // — not `email_not_connected` — which proves the floor sits BEFORE the provider.
  // Born red on the pre-ADR adapter (it consulted nothing; the run would have
  // reached the provider and reported not-connected).
  it('ADR 0655 D1: a chain send to a SUPPRESSED recipient fails at the send node BEFORE the provider', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Opted Out', email: 'optedout@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;
    const { addSuppression } = await import('../src/features/crm/suppressionService.js');
    await addSuppression(tenantId, 'optedout@acme.test', 'unsubscribed', `contact:${contactId}`, 'test');

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 're-engage chain must load').toBeTruthy();
    const params = { contactId, fromAddress: 'sender@acme.test', orgId, subject: 'We miss you', body: 'Come back!' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { ...params, journeyId: 're-engage-sup' } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    const snap = await pollRun(owner, runId);
    if (snap.status.startsWith('waiting')) {
      await resumeInterrupt(owner, runId, '_signoff', { decision: 'accept' });
    }
    const done = await pollRun(owner, runId);
    expect(done.status, JSON.stringify(done)).toBe('failed');
    const events = await bundleEvents(owner, runId);
    const failed = events.filter((e) => e.type === 'node.failed');
    expect(failed.length, JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(failed);
    expect(text, 'the eligibility recheck OR the send must refuse the suppressed recipient').toMatch(/email_recipient_suppressed|suppressed/);
    expect(text).not.toContain('email_not_connected');
  });

  it('fails cleanly for an ineligible contact at the enroll pre-check — never enrolls or reaches the sign-off gate (JRNY-1)', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'No Email Contact' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, fromAddress: 'sender@acme.test', orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { ...params, journeyId: 're-engage-noemail' } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status, `run should fail at the enroll pre-check: ${JSON.stringify(snap)}`).toBe('failed');
    // ADR 0237 preserves a node's OWN returned error.code (a node that RETURNS
    // `{status:'failed', error}`, as every `feature.campaign-journeys.nodes`
    // function does, no longer gets masked to the generic `pack_node_error`).
    // JRNY-1: the enroll pre-check rejects the no-email contact as not_eligible.
    expect(snap.error?.code).toBe('not_eligible');

    const events = await bundleEvents(owner, runId);
    const failedEvent = events.find((e) => e.type === 'node.failed');
    // JRNY-1: enroll now runs an eligibility pre-check BEFORE the irreversible
    // ledger claim, so an ineligible contact fails at `enroll` (never enrolled),
    // not at the later `gate` — and never reaches sign-off.
    expect(failedEvent?.nodeId?.endsWith('_enroll'), `expected the enroll node to fail on the eligibility pre-check: ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBe(true);
    expect(events.some((e) => e.nodeId?.endsWith('_signoff')), 'the run must never reach the sign-off gate').toBe(false);
  });

  it('enrollment guard: a second run for the same (journey, contact) fails with already_enrolled', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Repeat Customer', email: 'repeat@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, fromAddress: 'sender@acme.test', orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const inputs = { ...params, journeyId: 're-engage-idem' };

    const first = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstSnap = await pollRun(owner, first.body.runId as string);
    expect(firstSnap.status.startsWith('waiting'), `first run should reach the sign-off gate: ${JSON.stringify(firstSnap)}`).toBe(true);

    const second = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondSnap = await pollRun(owner, second.body.runId as string);
    expect(secondSnap.status, `second run should fail — already enrolled: ${JSON.stringify(secondSnap)}`).toBe('failed');
    // ADR 0237: the enrollment guard's own `already_enrolled` code now
    // propagates (was masked to `pack_node_error`).
    expect(secondSnap.error?.code).toBe('already_enrolled');

    const secondEvents = await bundleEvents(owner, second.body.runId as string);
    const failedEvent = secondEvents.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_enroll'), `expected the enroll node to fail on the second run: ${JSON.stringify(secondEvents.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBe(true);
  });
});

describe('campaign-journeys.welcome-series — end-to-end execution (real executor, trigger-fed direct run-start)', () => {
  it('walks the REAL trigger → enroll → eligibility path and suspends at the sign-off gate with real contact data', async () => {
    const { owner } = await ownerOrg();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'New Signup', email: 'newsignup@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.welcome-series');
    expect(found, 'campaign-journeys.welcome-series chain must be loaded at boot').toBeTruthy();
    const params = { contactId, fromAddress: 'sender@acme.test' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    // `core.trigger.event` spreads `ctx.triggerData` (= `run.inputs` for a
    // directly started run) into its own output — that's how the extra
    // `journeyId` workaround key reaches `enroll` through the trigger edge
    // (see file header).
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { ...params, journeyId: 'welcome-series' } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `expected the run to suspend at the sign-off gate: ${JSON.stringify(snap)}`).toBe(true);

    const events = await bundleEvents(owner, runId);
    // Real CRM read via the trigger→enroll→eligibility path (a DIFFERENT
    // ctx.inputs-threading route than re-engage-contact's source-node path —
    // worth proving separately).
    expect(completedOutputs(events, 'gate1')).toMatchObject({ eligible: true, contactId, email: 'newsignup@acme.test', name: 'New Signup' });

    const ints = await owner.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    expect(ints.status, JSON.stringify(ints.body)).toBe(200);
    const gate = (ints.body.interrupts as Array<{ nodeId: string }>).find((i) => i.nodeId.endsWith('_signoff'));
    expect(gate, `expected a pending interrupt for the sign-off gate: ${JSON.stringify(ints.body)}`).toBeTruthy();
  });
});
