/**
 * commerce workflow-chain pack — REAL execution (RFC 0013, ADR 0221 gap
 * plan §5C C8).
 *
 * CHAINS CHOSEN: `commerce.post-purchase-thankyou` and
 * `commerce.low-stock-reorder` (both of the pack's approval-gated,
 * side-effectful chains — `commerce.order-exception-digest` is read-only
 * and ungated, less interesting to prove). Both DAGs put
 * `core.ai.chatCompletion` DIRECTLY BEFORE their `core.chat.approvalGate`
 * node (`order`→`compose`→`signoff`→`send` / `catalog`→`draft`→`approve`→
 * `send`+`notify`) — there is no path to the approval gate that does not
 * first require a working AI call. Per the task brief's honest-failure
 * precedent (`workflow-chain-exec-ops-execution.test.ts`), this session
 * has no established real-EXECUTOR fake-`ctx.callAI` seam, and faking
 * `ctx.suspend` (the primitive `core.chat.approvalGate` needs,
 * `packs/vendor.myndhyve.chat/index.mjs`) outside the real executor would
 * not faithfully reproduce the production suspend contract either — so,
 * unlike `csm-ops.renewal-risk` (whose gate sits directly downstream of a
 * plain CRM read, no AI in the way), **the suspend-at-gate behavior is not
 * reachable for either commerce chain** without a configured AI provider.
 * Both chains are therefore driven in HONEST-FAILURE mode instead: every
 * real upstream read runs for real (proving genuine `ctx.features.commerce`
 * wiring against REAL seeded catalog/order data), then the chain fails
 * cleanly at its first AI node with `error.code === 'provider_not_supported'`
 * — never silently skipped, never reaching the gate.
 *
 * BUG FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/commerce/
 * pack.json`):
 *
 * Multi-fan-in port collision on `commerce.post-purchase-thankyou`'s `send`
 * node (`core.openwop.integration.email-send`): TWO inbound edges
 * (`signoff`→`send`, `compose`→`send`) named neither `sourceOutput` nor
 * `targetInput`. The scheduler's `buildNodeInputs` (`executor/scheduler.ts`)
 * writes every edge's value to the SAME default port key `'input'` in
 * edge-array order, so the LATER edge (`compose`→`send`) silently clobbered
 * the EARLIER one (`signoff`→`send`) — meaning `send` could never actually
 * see the human approver's resume decision (approved/rejected/edited text),
 * only ever `compose`'s original AI draft, no matter what the approver
 * decided. (Empirically confirmed the general clobber mechanism against
 * this session's other multi-fan-in fixes — `csm-ops.health-from-crm`,
 * `exec-ops.*` — via a throwaway probe on `content.feed-watch`'s identical
 * defect class, see the content-pack execution test.) Fixed with explicit
 * dot-notation target ports (`signoff`→`send.approval`, `compose`→
 * `send.compose`) so each source lands on its own key. Not directly
 * provable at runtime in THIS test (the chain fails at `compose`, upstream
 * of `signoff`/`send`, before the bug's effect could ever be observed) —
 * documented here exactly as `exec-ops-execution.test.ts`'s BUG-1 (its own
 * unreachable-in-honest-failure-mode fan-in fixes) is documented, and fixed
 * regardless because a future run WITH a configured provider would hit it.
 *
 * `commerce.low-stock-reorder` has no fan-in defect (its `approve` node
 * fans OUT to `send` + `notify`, each via a single inbound edge — no
 * collision) and needed no pack.json change.
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

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const commerce = getToggleDefault('commerce');
  if (commerce) await saveConfig({ ...commerce, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
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
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:commercechain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `commercechain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

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

describe('commerce.post-purchase-thankyou — real order read, honest missing-credential failure', () => {
  it('reads the REAL seeded order then fails cleanly at compose (no BYOK credential)', async () => {
    const { owner, orgId } = await ownerOrg();
    const product = await owner.post(c(orgId, '/products'), { name: 'Widget', price: 25 });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const productId = product.body.productId as string;
    const order = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 2 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.orderId as string;

    const found = getChain('commerce.post-purchase-thankyou');
    expect(found, 'commerce.post-purchase-thankyou chain must be loaded at boot').toBeTruthy();
    const params = { orgId, orderId, tone: 'warm, brief, no upsell' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
      // §Correction (P3): this asserted `provider_not_supported`, which PINNED THE
      // BUG AS EXPECTED BEHAVIOUR — the chain had no `provider` in its AI node
      // config, so the run died with `Provider "undefined"`. The suite called that
      // "fails cleanly". Now the chain freezes a real provider at expansion, so a
      // credential-less test tenant fails one step LATER and honestly:
      // `byok_required` — configure a key — instead of naming a provider that
      // never existed.
    expect(snap.error?.code).toBe('byok_required');

    const events = await bundleEvents(owner, runId);
    const orderOutputs = completedOutputs(events, 'order');
    expect((orderOutputs.order as { orderId?: string }).orderId).toBe(orderId);
    expect((orderOutputs.order as { total?: number }).total).toBe(50);

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_compose')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_send'))).toBe(false);
  });
});

describe('commerce.low-stock-reorder — real catalog read, honest missing-credential failure', () => {
  it('reads the REAL seeded catalog then fails cleanly at draft (no BYOK credential)', async () => {
    const { owner, orgId } = await ownerOrg();
    const product = await owner.post(c(orgId, '/products'), { name: 'Low-stock Gadget', price: 12, inventory: 2, lowStockThreshold: 5 });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const productId = product.body.productId as string;

    const found = getChain('commerce.low-stock-reorder');
    expect(found, 'commerce.low-stock-reorder chain must be loaded at boot').toBeTruthy();
    const params = { orgId, productId, supplierHint: 'acme-supply@example.test' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('byok_required');

    const events = await bundleEvents(owner, runId);
    const catalogOutputs = completedOutputs(events, 'catalog');
    const products = catalogOutputs.products as Array<{ productId: string; name: string }> | undefined;
    expect(products, JSON.stringify(catalogOutputs)).toBeTruthy();
    expect(products!.some((p) => p.productId === productId && p.name === 'Low-stock Gadget')).toBe(true);

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_draft')).toBe(true);
    // Never reached the purchasing sign-off gate — proves the AI failure
    // stops the chain before the human is ever asked to approve anything.
    expect(events.some((e) => e.nodeId?.endsWith('_approve'))).toBe(false);
  });
});
