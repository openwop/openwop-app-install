/**
 * devops workflow-chain pack — REAL execution (ADR 0190 Phase 4, RFC 0013).
 *
 * Structural coverage already exists (`workflow-chain-devops.test.ts`: expand +
 * the node-pack typeId set). This adds
 * REAL-executor coverage for `devops.ci-failure-explainer`, the only chain in
 * this pack with a trigger node — driving it the same way `triggers-surface.
 * test.ts` proves `core.trigger.webhook` for real: a direct `POST /v1/runs`
 * carrying `metadata.triggerData` (the shape the host's webhook-subscription /
 * `POST /v1/runs` paths both populate — RFC 0099 §F's `ctx.triggerData`
 * envelope; `openwop-app.trigger.webhook`'s own fixture test seeds it this
 * exact way).
 *
 * MODE CHOSEN: the chain freezes a real provider into `diagnose`
 * (`core.ai.chatCompletion`) at expansion (ADR 0903 P3), and the test tenant has
 * no BYOK credential, so this drives the REAL executor through the REAL trigger
 * node to a genuine `completed` state for `hook`, then asserts the HONEST FAILURE
 * contract at the AI node (`error.code === 'openwop-app.byok_required'`). AI and
 * web-search keys are cleared around the case, so it never depends on the
 * runner's environment and never calls a live provider.
 *
 * Sabotages witnessed (/grade-tests 8f W5): the trigger's passthrough of
 * `triggerData` (8fw5g6-dvx-passthrough) and the diagnose→notify gating
 * (8fw5g6-dvx-notify-gated).
 *
 * BUG FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/devops/
 * pack.json`): `devops.ci-failure-explainer` chained `hook` (`core.trigger.
 * webhook`) → `verify` (`core.openwop.http.webhook-verify`) → `diagnose`. But
 * `core.trigger.webhook`'s real implementation (`packs/core.openwop.triggers/
 * index.mjs`'s `webhookTrigger`) forwards ONLY `{method, headers, query, body,
 * ...ctx.triggerData}` — it never produces `signatureHeader` or `secret`, the
 * TWO fields `core.openwop.http.webhook-verify`'s real implementation
 * (`packs/core.openwop.http/index.mjs`'s `webhookVerify`) requires as `ctx.
 * inputs.signatureHeader` / `ctx.inputs.secret` (its input schema marks both
 * `required`). No node in the shipped catalog can extract a single named header
 * value out of a headers object into a bare-scalar input port (no `core.flow.*`
 * "pick"/"transform" node reshapes across ports that way — `core.openwop.data.
 * object-get-path` gets closest but still can't fan two different upstream
 * shapes into two flat sibling keys on one target's `ctx.inputs` — see
 * `buildNodeInputs`, `executor/scheduler.ts` — each edge writes ONE key per
 * edge), and `secret` has NO data-flow source at all (chain params surface into
 * `ctx.config` — string-interpolated, not `ctx.inputs` — or into `ctx.inputs`
 * only via the "zero-incoming-edges source node gets the whole flat run.inputs
 * object" mechanism documented in `workflow-chain-data-ops-execution.test.ts`
 * bug #2/#3, which `verify` can't use since it already has ONE real inbound
 * edge from `hook`). Verified empirically: driving the pre-fix DAG with a real
 * signed webhook payload throws inside `webhookVerify` (`secret` undefined →
 * `crypto.createHmac` throws), surfacing as `error.code: 'internal_error'` —
 * an ugly, uninformative crash instead of the chain's own documented behavior.
 * That documented behavior is also the actual fix: the chain's own description
 * says CI webhooks are bound "via the trigger-subscriptions API (signature-
 * verified — the secret stays host-side)" — RFC 0099 §F's `ingestExternalEvent`
 * (`src/host/triggerIngestionService.ts`) verifies the HMAC HOST-SIDE, before
 * the run ever starts, keeping the raw secret out of the workflow entirely
 * (`trigger-ingestion.test.ts` pins this: a bad-signature `required`-mode
 * subscription starts NO run at all). The in-DAG `verify` node duplicated —
 * and, per the above, could never actually perform — work the host already
 * does upstream of any run start. Removed `verify` (and the now-orphaned
 * `family` parameter) and wired `hook` directly to `diagnose`; the chain now
 * matches its own documented trust model instead of crashing on every real
 * delivery.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Provider / search keys the host or a node could read: cleared per case, restored after. */
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENWOP_WEBSEARCH_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPAPI_API_KEY', 'OPENWOP_MOCK_PROVIDER_ENABLED'] as const;
const savedKeys = new Map<string, string | undefined>();
beforeEach(() => { for (const k of PROVIDER_KEYS) { savedKeys.set(k, process.env[k]); delete process.env[k]; } });
afterEach(() => { for (const k of PROVIDER_KEYS) { const v = savedKeys.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

interface Res<T> { status: number; body: T }
interface Client { get: <T>(p: string) => Promise<Res<T>>; post: <T>(p: string, b?: unknown) => Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json()) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; tenantId: string }> {
  const tenantId = `org:devopschain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<unknown>('/host/openwop-app/test/login', { email: `devopschain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { owner, tenantId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
const POLLS = 80;
/** Poll until the run settles; THROWS (naming the run and the poll count) if it never does. */
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < POLLS; i++) {
    const r = await owner.get<RunSnapshot>(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) return snap;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not settle after ${POLLS} polls (last status: ${snap.status})`);
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return b.body.events ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

describe('devops.ci-failure-explainer — real webhook trigger, honest missing-credential failure', () => {
  it('forwards the REAL CI webhook payload through the trigger node (verify-node fix), then fails cleanly at the AI node', async () => {
    const { owner } = await ownerOrg();

    const found = getChain('devops.ci-failure-explainer');
    expect(found, 'devops.ci-failure-explainer chain must be loaded at boot').toBeTruthy();
    const expanded = expandChain(found!.chain, { params: {} });
    registerWorkflow(expanded);

    // The direct run-start path with `metadata.triggerData` — the same
    // contract `triggers-surface.test.ts` pins for `core.trigger.webhook`
    // (`ctx.triggerData` sourced from `run.metadata.triggerData`).
    const ciPayload = {
      action: 'completed',
      workflow_run: { id: 42, name: 'CI', conclusion: 'failure', head_branch: 'main' },
    };
    const create = await owner.post<{ runId: string }>('/runs', {
      workflowId: expanded.workflowId,
      inputs: {},
      metadata: {
        triggerData: {
          method: 'POST',
          headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': 'sha256=deadbeef' },
          body: ciPayload,
        },
      },
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
      // §Correction (P3): this asserted `provider_not_supported`, which PINNED THE
      // BUG AS EXPECTED BEHAVIOUR — the chain had no `provider` in its AI node
      // config, so the run died with `Provider "undefined"`. The suite called that
      // "fails cleanly". Now the chain freezes a real provider at expansion, so a
      // credential-less test tenant fails one step LATER and honestly:
      // `byok_required` — configure a key — instead of naming a provider that
      // never existed.
    expect(snap.error?.code).toBe('openwop-app.byok_required');

    const events = await bundleEvents(owner, runId);
    // The trigger node genuinely forwarded the real webhook body/headers —
    // proving the hook→diagnose rewiring (post verify-node removal) still
    // threads real data, not an empty/default payload.
    const hookOut = completedOutputs(events, 'hook');
    expect(hookOut).toMatchObject({
      method: 'POST',
      body: { workflow_run: { conclusion: 'failure' } },
      headers: { 'x-github-event': 'workflow_run' },
    });

    // The AI node is where it fails — never silently skipped or reached notify.
    // Also confirms `verify` no longer exists in the expanded definition at all
    // (no node.started/failed for it — removed, not merely skipped).
    expect(events.some((e) => e.nodeId?.endsWith('_verify'))).toBe(false);
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_diagnose')).toBe(true);
    // notify never STARTED (no event of any type), not merely never completed.
    expect(events.filter((e) => e.nodeId?.endsWith('_notify')).map((e) => e.type)).toEqual([]);
  });
});
