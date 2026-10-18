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
import { toWireRunId } from '../src/host/v2Ids.js';
import type { Order, Product } from '../src/features/commerce/commerceService.js';

function portOf(s: http.Server): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}
let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const commerce = getToggleDefault('commerce');
  if (commerce) await saveConfig({ ...commerce, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  // The ONE deserialization boundary: `res.json()` is untyped, so each call site names the
  // body it expects (the product's exported row type where one exists, else a narrow local
  // interface). A 204 / non-JSON body reads as `null`.
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const text = await res.text();
    let out: T;
    try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); }
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:commercechain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `commercechain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId, userId: r.body.user.userId };
}
const c = (orgId: string, suffix = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get<RunSnapshot>(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

/** The node outputs these chains' reads produce (feature.commerce.nodes → commerce surface). */
interface NodeOutputs { order?: { orderId?: string; total?: number }; product?: { productId?: string; name?: string } }
interface BundleEvent { type?: string; nodeId?: string; payload?: { outputs?: NodeOutputs } & Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return b.body.events ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): NodeOutputs {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return ev?.payload?.outputs ?? {};
}

describe('commerce.post-purchase-thankyou — real order read, honest missing-credential failure', () => {
  it('reads the REAL seeded order then fails cleanly at compose (no BYOK credential)', async () => {
    const { owner, orgId } = await ownerOrg();
    const product = await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Widget', price: 25 });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const productId = product.body.productId;
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId, quantity: 2 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.orderId;

    const found = getChain('commerce.post-purchase-thankyou');
    expect(found, 'commerce.post-purchase-thankyou chain must be loaded at boot').toBeTruthy();
    const params = { orgId, orderId, tone: 'warm, brief, no upsell' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post<{ runId: string } & ErrBody>('/runs', { workflowId: expanded.workflowId, inputs: params });
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
    const orderOutputs = completedOutputs(events, 'order');
    expect(orderOutputs.order?.orderId).toBe(orderId);
    expect(orderOutputs.order?.total).toBe(50);

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_compose')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_send'))).toBe(false);
  });
});

describe('commerce.low-stock-reorder — real catalog read, honest missing-credential failure', () => {
  it('reads the REAL seeded catalog then fails cleanly at draft (no BYOK credential)', async () => {
    const { owner, orgId } = await ownerOrg();
    const product = await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Low-stock Gadget', price: 12, inventory: 2, lowStockThreshold: 5 });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const productId = product.body.productId;

    const found = getChain('commerce.low-stock-reorder');
    expect(found, 'commerce.low-stock-reorder chain must be loaded at boot').toBeTruthy();
    const params = { orgId, productId, supplierHint: 'acme-supply@example.test' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post<{ runId: string } & ErrBody>('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('openwop-app.byok_required');

    const events = await bundleEvents(owner, runId);
    // ADR 0875 D11 (WF-B3) — THE low product, not the whole list (`list-products`
    // ignored `productId`, so the model was handed every product in the store).
    const catalogOutputs = completedOutputs(events, 'catalog');
    const readProduct = catalogOutputs.product;
    expect(readProduct, JSON.stringify(catalogOutputs)).toMatchObject({ productId, name: 'Low-stock Gadget' });

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_draft')).toBe(true);
    // Never reached the purchasing sign-off gate — proves the AI failure
    // stops the chain before the human is ever asked to approve anything.
    expect(events.some((e) => e.nodeId?.endsWith('_approve'))).toBe(false);
  });
});

describe('ADR 0875 D10 — the commerce notifications carry their content (WF-row-37 B1)', () => {
  // The `notify` node reads `inputs.message` only. A bare `digest → notify` edge lands
  // on the default `input` port, so the run "succeeded" with a title-only notification
  // and the digest — the chain's whole deliverable — went nowhere. Asserted on the
  // EXPANDED definition through the real loader, not on the authored pack.
  for (const chainId of ['commerce.order-exception-digest', 'commerce.low-stock-reorder']) {
    it(`${chainId}: every edge into notify targets its message port`, () => {
      const found = getChain(chainId);
      expect(found, `${chainId} must be loaded at boot`).toBeTruthy();
      const params = chainId === 'commerce.order-exception-digest' ? { orgId: 'org-x' } : { orgId: 'org-x', productId: 'p', senderEmail: 'a@x.test', recipientEmail: 'b@x.test' };
      const expanded = expandChain(found!.chain, { params });
      const intoNotify = (expanded.edges ?? []).filter((e) => e.targetNodeId.endsWith('_notify'));
      expect(intoNotify.length, 'the chain has a notify edge').toBeGreaterThan(0);
      for (const e of intoNotify) expect(e.targetInput, JSON.stringify(e)).toBe('message');
    });
  }
});

/** `metadata.hostEvent.bindingId` (hostEventDispatcher stamps it) — narrowed, not cast. */
function bindingIdOf(r: RunRecord): string | undefined {
  const ev = r.metadata?.hostEvent;
  return typeof ev === 'object' && ev !== null && 'bindingId' in ev && typeof ev.bindingId === 'string' ? ev.bindingId : undefined;
}
/** The run a host-event binding started (the dispatcher fires asynchronously). */
async function runForBinding(tenantId: string, bindingId: string): Promise<RunRecord> {
  let run: RunRecord | undefined;
  for (let i = 0; i < 120 && (!run || run.status === 'pending' || run.status === 'running'); i++) {
    const runs = await storage.listRuns({ tenantId, limit: 50 });
    run = runs.find((r) => bindingIdOf(r) === bindingId);
    if (!run || run.status === 'pending' || run.status === 'running') await new Promise((res) => setTimeout(res, 25));
  }
  expect(run, `no run started for binding ${bindingId}`).toBeTruthy();
  return run!;
}

describe('ADR 0875 D11 — an EVENT-bound run reads the event\'s record (WF-B1)', () => {
  it('the in-repo pack is the copy that serves (ADR 0713: a stale registry copy can win)', () => {
    // MEASURED 2026-10-12: packs.openwop.dev latestVersion 1.0.3; ~/.openwop-packs has no
    // copy; same-name duplicates resolve HIGHER-semver-wins across roots, so the in-repo version
    // (1.4.0 since ADR 0903 D7) must be what loaded. If a newer stale copy ever shadows it, this names it.
    expect(getChain('commerce.post-purchase-thankyou')?.packVersion).toBe('1.4.0');
    expect(getChain('commerce.low-stock-reorder')?.chain.version).toBe('1.2.0');
  });

  // `hostEventDispatcher` passes the event only as `metadata.triggerData`; before
  // D11 neither chain had a trigger node, so `{{params.orderId}}` / `{{params.productId}}`
  // stayed '' and the read failed (or, for low-stock, read the whole catalog).
  it('post-purchase-thankyou: order.paid → the PAID order is the one read', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    const product = await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Widget', price: 25 });
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: product.body.productId, quantity: 1 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const expanded = expandChain(getChain('commerce.post-purchase-thankyou')!.chain, { params: { orgId, senderEmail: 'shop@acme.test', recipientEmail: 'ops@acme.test' } });
    registerWorkflow(expanded);
    const binding = await createHostEventBinding({ tenantId, eventType: 'host.commerce.order.paid', workflowId: expanded.workflowId, createdBy: userId });

    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(order.body.orderId)}/pay`), { paymentIntentId: 'manual:test' })).status).toBe(200);

    const run = await runForBinding(tenantId, binding.bindingId);
    const events = await bundleEvents(owner, toWireRunId(run.runId, run.tenantId));
    const read = completedOutputs(events, 'order');
    expect(read.order?.orderId, JSON.stringify(read)).toBe(order.body.orderId);
  });

  it('low-stock-reorder: inventory.low-stock → THAT product is the one read', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Other', price: 5, inventory: 50 });
    const product = await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Running Low', price: 12, inventory: 10, lowStockThreshold: 5 });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const expanded = expandChain(getChain('commerce.low-stock-reorder')!.chain, { params: { orgId, senderEmail: 'shop@acme.test', recipientEmail: 'buyer@acme.test' } });
    registerWorkflow(expanded);
    const binding = await createHostEventBinding({ tenantId, eventType: 'host.commerce.inventory.low-stock', workflowId: expanded.workflowId, createdBy: userId });

    // A sale crosses the threshold (10 → 3), which emits the low-stock event.
    const order = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: product.body.productId, quantity: 7 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);

    const run = await runForBinding(tenantId, binding.bindingId);
    const events = await bundleEvents(owner, toWireRunId(run.runId, run.tenantId));
    const read = completedOutputs(events, 'catalog');
    expect(read.product?.productId, JSON.stringify(read)).toBe(product.body.productId);
  });

  it('a missing record is a typed failure, never success-with-null', async () => {
    const { owner, orgId } = await ownerOrg();
    const expanded = expandChain(getChain('commerce.post-purchase-thankyou')!.chain, { params: { orgId, orderId: 'ord:does-not-exist', senderEmail: 'a@x.test', recipientEmail: 'b@x.test' } });
    registerWorkflow(expanded);
    const create = await owner.post<{ runId: string } & ErrBody>('/runs', { workflowId: expanded.workflowId, inputs: {} });
    const snap = await pollRun(owner, create.body.runId);
    expect(snap.status).toBe('failed');
    const events = await bundleEvents(owner, create.body.runId);
    const failed = events.find((e) => e.type === 'node.failed');
    expect(failed?.nodeId?.endsWith('_order')).toBe(true);
    // The TYPED not-found, not a TypeError from projecting a null row.
    expect(JSON.stringify(failed?.payload)).toMatch(/Order not found/);
  });
});

