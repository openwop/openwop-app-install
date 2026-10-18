/**
 * ADR 0820 §8.2 — the core → bundle moves, proven at the boundaries that matter.
 *
 * Each moved feature gets a refusal case AND a positive control on the same tenant
 * (it is served once the bundle is owned, or once the toggle is back on), so no
 * case can pass for the wrong reason:
 *  - the operator routes of evals / model-router (Governance), scheduled agent chats
 *    (Agents) and the chat widget (Support) refuse a free-plan tenant with the plan
 *    403, then serve it after the bundle subscription event;
 *  - model-router DEGRADES on the chat hot path: refused ⇒ no route, no throw, the
 *    turn keeps its own model; entitled ⇒ the rule routes;
 *  - code-exec refuses in the shared sandbox runner, before any execution;
 *  - scheduled agent chats stamp `featureId` on their scheduler job (the daemon gate);
 *  - the two VISITOR lanes (chat widget, service-desk widget) are NOT paywalled on
 *    the owner's plan, but do honour the tenant's own toggle.
 *
 * Sabotage witnesses (observed red, 2026-10-05):
 *  - `distributions/bundles.json` reverted to its pre-ADR-0820 composition: the 14
 *    catalog cases, the 4 route refusals, the router refusal and the code-exec
 *    refusal fail (20 of 30) — the features were core, so never sellable;
 *  - the chat-widget toggle check disabled in `publicGateway.ts`, and the
 *    service-desk visitor lane switched back to `resolveOne`: both visitor cases fail
 *    (the first stops honouring the toggle; the second 404s a free-plan owner's
 *    visitors — the architect #5 hazard).
 *
 * w35 (grade-tests): the router legs each set their own config (they used to lean
 * on the first leg's, so shuffle reddened the control and made toggle-off
 * vacuous), stamp a REAL stored run and read it back, and the route refusals assert
 * the PLAN refusal body, not just 403. Re-witnessed: the router/code-exec/widget
 * gates disabled, the service-desk sub-toggle disabled, the visitor lane on
 * `resolveOne`, the scheduled-chat stamp dropped, `evals` taken out of Governance.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { isSellableBundleFeature } from '../src/host/featureBundles.js';
import { __resetBilling, processStripeEvent } from '../src/features/billing/billingService.js';
import { setRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';
import { resolveModelRoute } from '../src/features/model-router/resolveRoute.js';
import { maybeStampModelRoute } from '../src/host/exchange/dispatchTurn.js';
import { createSandboxRunner } from '../src/host/sandboxAdapter.js';
import { createScheduledChat } from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { getJob } from '../src/host/schedulingService.js';
import { provisionWidget } from '../src/features/chat-widget/widgetService.js';
import { mintPublicIntakeKey } from '../src/features/service-desk/widgetRoutes.js';
import { setIntakeConfig } from '../src/features/service-desk/intake.js';
import type { RunRecord } from '../src/types.js';
import { openStorage } from '../src/storage/index.js';

let server: http.Server;
let BASE: string;
let cookie = '';
const T = 't-reclass';
let sandbox: http.Server;
let SANDBOX_PORT = 0;

const BUNDLE_PRICES = { price_gov: 'governance', price_agents: 'agents', price_support: 'support', price_dev: 'developer' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify(BUNDLE_PRICES);
  // Narrow the free plan so every bundle feature is locked until bought.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'service-desk', 'service-desk.widget']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reclass@acme.test', tenantId: T }),
  });
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!;
  }
  sandbox = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exitCode: 0, stdout: 'ran', stderr: '', files: [] })); });
  await new Promise<void>((r) => sandbox.listen(0, '127.0.0.1', () => { SANDBOX_PORT = (sandbox.address() as AddressInfo).port; r(); }));
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((res) => sandbox.close(() => res()));
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); });

const authed = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
let evt = 0;
const own = (tenantId: string, bundleId: string) => processStripeEvent(tenantId, {
  id: `evt_reclass_${++evt}`, type: 'customer.subscription.created',
  data: { object: { id: `sub_${evt}`, status: 'active', metadata: { tenantId, bundleId }, items: { data: [{ price: { id: 'price_gov' } }] } } },
});
async function newOrg(): Promise<string> {
  const res = await authed('/host/openwop-app/orgs', { method: 'POST', body: JSON.stringify({ name: `Acme ${++evt}` }) });
  return (await res.json() as { orgId: string }).orgId;
}
async function setTenantToggle(id: string, tenantId: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id)!;
  await saveConfig({ ...d, tenantOverrides: { [tenantId]: { status } } }, 'test');
}

describe('ADR 0820 §8.2 — the moved ids are sellable; consent is not', () => {
  it.each(['evals', 'model-router', 'environments', 'code-exec', 'claude-code', 'scheduled-agent-chats',
    'chat-widget', 'chat-deployment', 'service-desk', 'service-desk.widget', 'code-export', 'code-publish', 'code-sync'])('%s is in a bundle', (id) => {
    expect(isSellableBundleFeature(id)).toBe(true);
  });
  it('consent is core (OFF makes consent permissive — a protection is never paid)', () => {
    expect(isSellableBundleFeature('consent')).toBe(false);
  });
  it.each(['evals', 'model-router', 'code-exec', 'scheduled-agent-chats', 'chat-widget'])('%s registers a default-ON toggle (it was always-on)', (id) => {
    expect(getToggleDefault(id)?.status).toBe('on');
  });
});

/** The 403 must be the PLAN refusal naming this feature (`entitlementGuard.ts`), not a scope 403. */
async function expectPlanRefusal(path: string, featureId: string): Promise<void> {
  const res = await authed(path);
  const text = await res.text();
  expect(res.status, text).toBe(403);
  expect(text).toContain('does not include this feature');
  expect(text).toContain(`"feature":"${featureId}"`);
}

describe('ADR 0820 §8.2 — operator routes refuse a free plan, serve an owner', () => {
  it('evals (Governance): leaderboard 403 → served after Governance', async () => {
    const orgId = await newOrg();
    const path = `/host/openwop-app/evals/orgs/${orgId}/leaderboard`;
    await expectPlanRefusal(path, 'evals');
    await own(T, 'governance');
    expect((await authed(path)).status).toBe(200);
  });

  it('model-router (Governance): config 403 → served after Governance', async () => {
    const orgId = await newOrg();
    const path = `/host/openwop-app/model-router/orgs/${orgId}/config`;
    await expectPlanRefusal(path, 'model-router');
    await own(T, 'governance');
    expect((await authed(path)).status).toBe(200);
  });

  it('scheduled agent chats (Agents): list 403 → served after Agents', async () => {
    const orgId = await newOrg();
    const path = `/host/openwop-app/scheduled-chats/orgs/${orgId}/chats`;
    await expectPlanRefusal(path, 'scheduled-agent-chats');
    await own(T, 'agents');
    expect((await authed(path)).status).toBe(200);
  });

  it('chat widget (Support): operator list 403 → served after Support', async () => {
    const orgId = await newOrg();
    const path = `/host/openwop-app/chat-widget/orgs/${orgId}/widgets`;
    await expectPlanRefusal(path, 'chat-widget');
    await own(T, 'support');
    expect((await authed(path)).status).toBe(200);
  });
});

describe('ADR 0820 §8.2 — model-router degrades on the chat hot path, never errors', () => {
  const TM = 't-reclass-router';
  const ORG = 'org-router';
  const cfg = {
    rules: [{ when: { kind: 'tokensOver', threshold: 10 }, target: { provider: 'anthropic', model: 'big' } }],
    fallback: { provider: 'anthropic', model: 'small' },
  };
  /** A REAL run in a real store: the stamp is read back from storage, not from a recorder. */
  async function realRun(): Promise<{ storage: Awaited<ReturnType<typeof openStorage>>; run: RunRecord }> {
    const storage = await openStorage('memory://');
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-reclass-${++evt}`, workflowId: 'wf.reclass', tenantId: TM, scopeId: ORG, status: 'running',
      inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    return { storage, run };
  }
  // A spaced turn text: ~100 tokens, over the rule's 10-token threshold.
  const TURN = 'please route this turn '.repeat(18);
  beforeEach(async () => {
    // Every case gets the SAME enabled config, so no case leans on another's setup.
    await setRouterConfig(TM, ORG, 'u1', cfg);
    await setRouterEnabled(TM, ORG, 'u1', true);
  });

  it('plan-refused: resolveModelRoute returns null and the stamp leaves the run on its own model', async () => {
    expect(await resolveModelRoute(TM, ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
    const { storage, run } = await realRun();
    await expect(maybeStampModelRoute(run, TURN, storage)).resolves.toBeUndefined();
    expect((await storage.getRun(run.runId))?.metadata['modelRoute']).toBeUndefined();
    expect(run.metadata['modelRoute']).toBeUndefined();
  });

  it('positive control: once Governance is owned, the SAME config routes and stamps', async () => {
    await own(TM, 'governance');
    const decision = await resolveModelRoute(TM, ORG, { tokenEstimate: 9000 }, 0);
    expect(decision?.target).toEqual({ provider: 'anthropic', model: 'big' });
    const { storage, run } = await realRun();
    await maybeStampModelRoute(run, TURN, storage);
    expect((await storage.getRun(run.runId))?.metadata['modelRoute']).toEqual({ provider: 'anthropic', model: 'big' });
    expect(run.metadata['modelRoute']).toEqual({ provider: 'anthropic', model: 'big' });
  });

  it('toggle-off (owned plan, tenant switched it off): degrades to null too', async () => {
    await own(TM, 'governance');
    // Control in-case: with the toggle on, this exact state routes.
    expect((await resolveModelRoute(TM, ORG, { tokenEstimate: 9000 }, 0))?.target).toEqual({ provider: 'anthropic', model: 'big' });
    await setTenantToggle('model-router', TM, 'off');
    try {
      expect(await resolveModelRoute(TM, ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
    } finally {
      await setTenantToggle('model-router', TM, 'on');
    }
  });
});

describe('ADR 0820 §8.2 — code-exec refuses in the shared runner, before executing', () => {
  const TC = 't-reclass-code';
  it('free plan: feature_disabled, no execution; positive control after Developer', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${SANDBOX_PORT}/run`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const runner = createSandboxRunner(TC)!;
    expect(runner).toBeTypeOf('function');
    await expect(runner({ language: 'python', code: 'print(1)' })).rejects.toMatchObject({ code: 'feature_disabled' });
    await own(TC, 'developer');
    expect((await runner({ language: 'python', code: 'print(1)' })).stdout).toBe('ran');
  });
});

describe('ADR 0820 §8.2 — scheduled agent chats stamp featureId on their scheduler job', () => {
  it('the job carries featureId, so the daemon gates its fires per tenant', async () => {
    const chat = await createScheduledChat('t-reclass-sched', { orgId: 'org-s' }, 'u1', {
      agentId: 'vendor.openwop-app.code-exec.agents.default', conversationId: 'conv-1', prompt: 'status?', cronExpr: '0 9 * * *',
    });
    const job = await getJob(`schedchat-${chat.chatId}`);
    expect(job?.featureId).toBe('scheduled-agent-chats');
  });
});

describe('ADR 0820 §8.2 — visitor lanes are not paywalled on the owner plan, but honour the toggle', () => {
  it('chat widget: a free-plan owner’s widget still serves visitors; the tenant toggle OFF stops it', async () => {
    const TW = 't-reclass-widget';
    const w = await provisionWidget(TW, 'org-w', 'admin', { agentId: 'vendor.openwop-app.code-exec.agents.default', allowedDomains: ['acme.com'] });
    const cfgPath = `/host/openwop-app/public/widget/config?token=${w.token}`;
    // Support is priced and TW owns nothing: the visitor is still served (ADR 0176).
    expect((await fetch(`${BASE}${cfgPath}`, { headers: { origin: 'https://acme.com' } })).status).toBe(200);
    await setTenantToggle('chat-widget', TW, 'off');
    try {
      expect((await fetch(`${BASE}${cfgPath}`, { headers: { origin: 'https://acme.com' } })).status).toBe(404);
    } finally {
      await setTenantToggle('chat-widget', TW, 'on');
    }
  });

  it('service-desk widget: a free-plan owner’s intake still accepts visitors; the sub-toggle OFF stops it', async () => {
    const TS = 't-reclass-sd';
    await setIntakeConfig(TS, 'org-sd', 'admin-1');
    const key = await mintPublicIntakeKey(TS);
    const send = () => fetch(`${BASE}/host/openwop-app/public-service-desk/${key}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello there' }),
    });
    expect((await send()).status).toBe(201);
    await setTenantToggle('service-desk.widget', TS, 'off');
    try {
      expect((await send()).status).toBe(404);
    } finally {
      await setTenantToggle('service-desk.widget', TS, 'on');
    }
  });
});
