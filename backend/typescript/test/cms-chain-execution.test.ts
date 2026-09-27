/**
 * CMSGAP-5 — execute `cms.localize-and-submit` END TO END: the REAL expanded
 * definition (loader → expandChain), the REAL node implementations
 * (`packs/feature.cms.nodes/index.mjs`), and the REAL `ctx.features.cms`
 * surface over a booted app — only `ctx.callAI` is faked. A mini scheduler
 * walks the definition's edges with the same port semantics as
 * `buildNodeInputs` (sourceOutput → targetInput), and config `{{inputs.*}}`
 * tokens resolve from the run params — pinning exactly the wiring the chain
 * relies on (chain params ride CONFIG via the RFC 0013 Path-A expansion-freeze).
 * NOTE (2026-07-04): the historical "static node `inputs` are stripped" bug is
 * FIXED (ADR 0237 / CHAINX-5, PR #1228 — `validateWorkflowDefinition` preserves
 * `inputs` and the executor resolves `{{inputs.*}}` at runtime); this harness
 * asserts on config because params freeze there, not because inputs are dropped.
 *
 * CMSGAP-1 — the same harness proves the translator-grant narrowing binds the
 * WORKFLOW path: with `scope.actingUserId` set to a granted translator, the
 * store step 403s for a foreign locale and submit-page 403s outright.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { loadWorkflowChainPacks, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { hasPendingApprovalForPage } from '../src/host/approvalService.js';
import { putLocaleGrant } from '../src/features/cms/cmsService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let BASE: string;
let server: http.Server;
let nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown>; error?: unknown }>>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs')] });
  expect(errors).toEqual([]);
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  nodes = ((await import('../../../packs/feature.cms.nodes/index.mjs')) as { nodes: typeof nodes }).nodes;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:chx-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `chx-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

/** Resolve `{{inputs.name}}` config tokens from the run params — the harness
 *  equivalent of the executor's per-run variable interpolation. */
function resolveConfig(config: Record<string, unknown> | undefined, params: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [
    k,
    typeof v === 'string' ? v.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => params[name] ?? '') : v,
  ]));
}

/**
 * Walk the expanded definition in edge order with `buildNodeInputs` port
 * semantics: `edge.sourceOutput` picks a field off the upstream node's
 * outputs; `edge.targetInput` names the ctx.inputs key it lands on.
 */
async function runChain(
  params: Record<string, string>,
  features: Record<string, unknown>,
  callAI: (args: unknown) => Promise<{ content: string }>,
): Promise<Record<string, { status: string; outputs: Record<string, unknown> }>> {
  const chain = getChain('cms.localize-and-submit')!.chain;
  const def = expandChain(chain, { params });
  const outputs = new Map<string, Record<string, unknown>>();
  const results: Record<string, { status: string; outputs: Record<string, unknown> }> = {};
  for (const node of def.nodes) {
    const inputs: Record<string, unknown> = {};
    for (const e of def.edges ?? []) {
      if (e.targetNodeId !== node.nodeId) continue;
      const src = outputs.get(e.sourceNodeId) ?? {};
      inputs[e.targetInput ?? 'input'] = e.sourceOutput ? src[e.sourceOutput] : src;
    }
    const impl = nodes[node.typeId];
    expect(impl, `node impl for ${node.typeId}`).toBeTruthy();
    const result = await impl!({ inputs, config: resolveConfig(node.config, params), features, callAI });
    const short = node.nodeId.slice(node.nodeId.lastIndexOf('_') + 1);
    results[short] = result as { status: string; outputs: Record<string, unknown> };
    if (result.status !== 'success') break;
    outputs.set(node.nodeId, result.outputs ?? {});
  }
  return results;
}

describe('cms.localize-and-submit — end-to-end execution', () => {
  it('reads the draft, translates, stores the overlay, and submits — approval queued when gated', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Chain Doc', sections: [{ type: 'hero', data: { heading: 'Welcome' } }] });
    expect(created.status).toBe(201);
    const pageId = created.body.pageId as string;
    const sectionId = created.body.sections[0].sectionId as string;

    const gate = getToggleDefault('cms-approval-gate');
    if (gate) await saveConfig({ ...gate, status: 'on' }, 'test');
    try {
      const features = buildFeatureSurfaces({ tenantId, runId: 'run:chain-test' });
      const results = await runChain(
        { orgId, pageId, sectionId, targetLocale: 'pt-BR' },
        features,
        async () => ({ content: '{"heading":"Bem-vindo"}' }), // the ONLY fake
      );

      expect(results.read?.status).toBe('success');
      expect((results.read?.outputs.sectionData as { heading?: string }).heading).toBe('Welcome');
      expect(results.translate?.status).toBe('success');
      expect((results.translate?.outputs.overlay as { heading?: string }).heading).toBe('Bem-vindo');
      expect(results.store?.outputs.updated).toBe(true);
      expect(results.submit?.outputs.submitted).toBe(true);

      // The overlay persisted through the sanitized write path…
      const page = await owner.get(u(orgId, `/pages/${pageId}`));
      expect(page.body.status).toBe('in_review');
      expect(page.body.sections[0].localizations['pt-BR'].heading).toBe('Bem-vindo');
      // …and the human gate was queued, not bypassed.
      expect(await hasPendingApprovalForPage(tenantId, pageId)).toBe(true);
    } finally {
      if (gate) await saveConfig({ ...gate, status: 'off' }, 'test');
    }
  });

  it('CMSGAP-1: a granted translator driving the chain is narrowed exactly like the editor path', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'] });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Granted', sections: [{ type: 'hero', data: { heading: 'Welcome' } }] });
    const pageId = created.body.pageId as string;
    const sectionId = created.body.sections[0].sectionId as string;
    await putLocaleGrant(tenantId, orgId, 'user:translator-1', ['pt-BR'], 'test');

    // The run carries the translator's durable principal (scope.actingUserId).
    const features = buildFeatureSurfaces({ tenantId, runId: 'run:granted', actingUserId: 'user:translator-1' });
    const cms = features.cms as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

    // Granted locale: the overlay write is allowed…
    const ok = await cms.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'pt-BR', data: { heading: 'Oi' } });
    expect((ok as { updated: boolean }).updated).toBe(true);
    // …a foreign locale is 403, base-data (no locale) is 403, and submit is 403.
    await expect(cms.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'es', data: { heading: 'Hola' } })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.updateSectionDraft!({ orgId, pageId, sectionId, data: { heading: 'HACK' } })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.submitPage!({ orgId, pageId })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.createDraftPage!({ orgId, title: 'Rogue' })).rejects.toMatchObject({ httpStatus: 403 });

    // A SYSTEM run (no actingUserId) is unchanged — no member, no grant.
    const system = buildFeatureSurfaces({ tenantId, runId: 'run:system' }).cms as typeof cms;
    const sys = await system.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'es', data: { heading: 'Hola' } });
    expect((sys as { updated: boolean }).updated).toBe(true);
  });
});
