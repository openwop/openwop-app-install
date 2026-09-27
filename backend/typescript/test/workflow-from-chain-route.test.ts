/**
 * Workflow-chain templates — list + "Use template" (ADR 0163 Phase 2).
 *
 * GET /workflow-chains lists installed RFC 0013 chains; POST /workflows/from-chain
 * expands one into a fresh, owned, editable workflow (appears in the caller's
 * tenant-scoped list). Unresolved node typeIds surface as warnings, not failures
 * (R6). Each instantiation mints a distinct workflowId (R2, non-idempotent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const url = (p: string) => `http://127.0.0.1:${PORT}/v1/host/openwop-app${p}`;

async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

describe('workflow-chain templates (ADR 0163 Phase 2)', () => {
  it('GET /workflow-chains lists the installed market-intel chain', async () => {
    const r = await fetch(url('/workflow-chains'), { headers: { cookie: await cookie() } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { chains: { chainId: string; label: string; parameters: unknown }[] };
    const mi = body.chains.find((c) => c.chainId === 'market-intel.digest');
    expect(mi, 'market-intel.digest should be installed').toBeTruthy();
    expect(mi!.label.length).toBeGreaterThan(0);
    expect(mi!.parameters).toBeTruthy(); // the param schema (topic required)
  });

  it('POST /workflows/from-chain instantiates a fresh owned workflow that appears in the scoped list', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'AI ops tooling' } }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { workflowId: string; nodeCount: number; warnings?: string[] };
    expect(body.workflowId).toMatch(/^wf\.market-intel-digest\.[0-9a-f]{8}$/);
    expect(body.nodeCount).toBe(4);
    // the workflow now appears in the caller's tenant-scoped list (a real owned workflow)
    const list = (await (await fetch(url('/workflows'), { headers: { cookie: c } })).json()) as { workflows: { workflowId: string }[] };
    expect(list.workflows.map((w) => w.workflowId)).toContain(body.workflowId);
    // R6 — instantiate SUCCEEDS regardless of node availability (invitation, not
    // breakage); `warnings` is omitted when every typeId resolves (as here, the
    // market-intel node packs are present) or a string[] of unresolved typeIds.
    expect(body.warnings === undefined || Array.isArray(body.warnings)).toBe(true);
  });

  it('"Use template = just copy": copies without a form; RFC 0013 Path A freezes params (no residual tokens); unknown chainId → 404', async () => {
    const c = await cookie();
    // No params supplied — the template copies anyway (no up-front form). Under
    // Path A the chain's `{{params.topic}}` is substituted at expansion (empty
    // here, no value/default), NOT left as a run-time token. The persisted
    // definition is portable: no variables[] for the param, zero residual tokens.
    const noParam = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: {} }),
    });
    expect(noParam.status).toBe(201);
    const { workflowId } = (await noParam.json()) as { workflowId: string };
    const def = (await (await fetch(`http://127.0.0.1:${PORT}/v1/workflows/${workflowId}`, { headers: { cookie: c } })).json()) as { nodes: unknown[]; variables?: { name: string; required?: boolean }[] };
    expect(JSON.stringify(def.nodes)).not.toContain('{{inputs.topic}}');
    expect(JSON.stringify(def.nodes)).not.toContain('{{params.topic}}');
    const unknown = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'nope.missing', params: {} }),
    });
    expect(unknown.status).toBe(404);
  });

  it('each instantiation mints a distinct workflowId (non-idempotent "use template")', async () => {
    const c = await cookie();
    const mk = async () => ((await (await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'same topic' } }),
    })).json()) as { workflowId: string }).workflowId;
    const [a, b] = [await mk(), await mk()];
    expect(a).not.toBe(b);
  });

  it('instantiated workflow takes the template name; a collision appends -N', async () => {
    const c = await cookie();
    // the chain's human label — what "Your workflows" should show (never the id)
    const chains = (await (await fetch(url('/workflow-chains'), { headers: { cookie: c } })).json()) as { chains: { chainId: string; label: string }[] };
    const label = chains.chains.find((x) => x.chainId === 'market-intel.digest')!.label;
    const mk = async () => ((await (await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 't' } }),
    })).json()) as { workflowId: string }).workflowId;
    const id1 = await mk();
    const id2 = await mk();
    const list = (await (await fetch(url('/workflows'), { headers: { cookie: c } })).json()) as { workflows: { workflowId: string; name: string }[] };
    const byId = new Map(list.workflows.map((w) => [w.workflowId, w.name]));
    expect(byId.get(id1)).toBe(label);            // first copy keeps the template name
    expect(byId.get(id2)).toBe(`${label}-2`);     // collision → -2 (not the raw workflowId)
    // the DEFINITION name must match the list name so the builder canvas and the
    // dashboard never disagree (the -N suffix is stamped on the def too)
    const def2 = (await (await fetch(`http://127.0.0.1:${PORT}/v1/workflows/${id2}`, { headers: { cookie: c } })).json()) as { metadata?: { name?: string } };
    expect(def2.metadata?.name).toBe(`${label}-2`);
  });
});

describe('internal chains (RFC 0135) — omitted from the gallery, everything else unchanged', () => {
  const INTERNAL_CHILD = 'openwop-app.kicktodo.lesson-batch';
  const PARENT = 'openwop-app.kicktodo.challenge-factory';

  it('GET /workflow-chains omits the internal composition-only child but lists its parent', async () => {
    const c = await cookie();
    const body = (await (await fetch(url('/workflow-chains'), { headers: { cookie: c } })).json()) as { chains: { chainId: string }[] };
    const ids = body.chains.map((x) => x.chainId);
    expect(ids, 'the RFC 0133 child is composition-only — MUST NOT list').not.toContain(INTERNAL_CHILD);
    expect(ids, 'its parent is a real template — MUST list').toContain(PARENT);
  });

  it('the internal chain stays loaded + resolvable by id (presentational only, never authz)', async () => {
    const { getChain } = await import('../src/host/workflowChainPackLoader.js');
    const entry = getChain(INTERNAL_CHILD);
    expect(entry).toBeTruthy();
    expect(entry!.chain.internal).toBe(true);
  });

  it('a DELIBERATE from-chain instantiation of an internal chain still succeeds (RFC 0135 §UQ2)', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: INTERNAL_CHILD, params: { candidateId: 'cand-1', authorSubject: 'user:author', days: '[]' } }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { workflowId: string };
    expect(body.workflowId.length).toBeGreaterThan(0);
  });
});

/**
 * §Correction (code-review HIGH #1) — WIRING, not mechanism.
 *
 * The P3 work was unit-tested by calling `expandChain` directly, so nothing
 * noticed the runtime check had been wired to the sub-chain branch only — the
 * branch 2 of 169 chains take, excluding the chain from the production incident.
 * A green suite over the mechanism said nothing about the route. These drive the
 * REAL route, through HTTP, on the branch the incident actually took.
 */
describe('from-chain: a blank copy still mints a RUNNABLE workflow', () => {
  it('copies with blanks (the "just copy" contract) — no refusal', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      // `exec-ops.daily-briefing` requires `orgId` and takes the NON-sub-chain
      // branch — precisely the path the incident took.
      body: JSON.stringify({ chainId: 'exec-ops.daily-briefing', params: {} }),
    });
    expect(r.status, 'copying a template must not require a form').toBe(201);
  });

  it('THE INCIDENT ASSERTION: the minted AI node carries a concrete provider', async () => {
    const c = await cookie();
    const created = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'exec-ops.daily-briefing', params: {} }),
    });
    expect(created.status).toBe(201);
    const { workflowId } = (await created.json()) as { workflowId: string };
    const got = await fetch(`http://127.0.0.1:${PORT}/v1/workflows/${workflowId}`, { headers: { cookie: c } });
    expect(got.ok).toBe(true);
    const def = (await got.json()) as { nodes?: Array<{ typeId: string; config?: Record<string, unknown> }> };
    const ai = (def.nodes ?? []).filter((n) => n.typeId === 'core.ai.chatCompletion');
    expect(ai.length, 'fixture guard: no AI node in the minted definition').toBeGreaterThan(0);
    for (const n of ai) {
      // Before the fix these were absent entirely and dispatch reported
      // `Provider "undefined"`. A blank copy must still be runnable.
      expect(String(n.config?.provider)).toBe('anthropic');
      expect(String(n.config?.model)).not.toMatch(/undefined|\{\{/);
    }
  });
});

/**
 * §Correction (grade-ux TPI-3 / grade-code MEDIUM-2) — the host must TELL the
 * client what is still missing, and that must be test-pinned at the ROUTE.
 *
 * The host already computed this finding and only `log.warn`ed it, so a template
 * copied with blanks landed in the builder looking complete. Unit-testing the
 * rule said nothing about whether the response carried it — which is the same
 * gap that let the earlier "wired to the wrong branch" defect ship.
 */
describe('from-chain reports what the copy still needs', () => {
  it('returns incompleteNodes for a chain whose required config is blank', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      // post-purchase-thankyou's email-send requires `from`, which has no default.
      body: JSON.stringify({ chainId: 'commerce.post-purchase-thankyou', params: {} }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { incompleteNodes?: Array<{ nodeId: string; typeId: string; missing: string[] }> };
    expect(body.incompleteNodes, 'the copy is incomplete and the response must say so').toBeDefined();
    expect(body.incompleteNodes!.length).toBeGreaterThan(0);
    expect(body.incompleteNodes!.flatMap((n) => n.missing)).toContain('from');
  });

  it('OMITS incompleteNodes when the copy is complete (no false alarm)', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      // exec-ops' AI node carries provider/model defaults; orgId is a port, not config.
      body: JSON.stringify({ chainId: 'exec-ops.daily-briefing', params: { orgId: 'org-1' } }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { incompleteNodes?: unknown[] };
    expect(body.incompleteNodes).toBeUndefined();
  });
});
