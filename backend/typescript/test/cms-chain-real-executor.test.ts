/**
 * ADR 0861 D7 / CMSLWF-3 — `cms.localize-and-submit` through the REAL executor.
 *
 * `cms-chain-execution.test.ts` drove this chain with a hand-rolled
 * mini-scheduler that re-implemented edge/port semantics and `{{inputs.*}}`
 * interpolation itself — so it proved the NODES, not that the chain runs the
 * way production runs it. This file closed that gap, and since w16 it is the
 * chain's ONLY execution witness (the mini-scheduler case was cut as superseded
 * by this one). Everything is the production path:
 *
 *   - instantiation: `POST /host/openwop-app/workflows/from-chain` (the
 *     builder's "Use template" — `expandChain → registerWorkflow →
 *     recordOwnership`), params frozen at expansion;
 *   - dispatch: `POST /runs` with the owner's session → `startWorkflowRun`
 *     → the real scheduler + `executeRun`, the real node registry entries for
 *     `feature.cms.nodes.*` (the pack the app mounts), the real
 *     `ctx.features.cms` surface bound to the run's acting user;
 *   - the ONLY fake is the model: `createAiProvidersAdapter` (the factory the
 *     executor builds `ctx.callAI` from) is wrapped so `callAI` returns a canned
 *     completion. Every other adapter method is the real one.
 *
 * Asserts after the run reaches `completed`: the pt-BR overlay is persisted on
 * the page, the page is `in_review`, and exactly ONE pending `content-publish`
 * approval row exists for the page.
 *
 * Sabotage-witnessed (w16): the update-section-draft node dropping its `locale`
 * (`w16g2-chain-store-locale-real`, packs/feature.cms.nodes) and the surface's
 * submit not queueing the approval (`w16g2-chain-surface-queue-real`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiCallRequest, AiCallResult } from '../src/executor/types.js';
import { bareRunId } from './support/bareRunId.js';

const ai = vi.hoisted(() => ({ calls: [] as AiCallRequest[] }));
vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  return {
    ...actual,
    createAiProvidersAdapter: ((...args: Parameters<typeof actual.createAiProvidersAdapter>) => {
      const real = actual.createAiProvidersAdapter(...args);
      return {
        ...real,
        // The model call is the only stand-in: the translation of `Welcome`,
        // plus a key `hero` does not declare (dropped by the sanitized write).
        callAI: async (req: AiCallRequest): Promise<AiCallResult> => {
          ai.calls.push(req);
          return { content: '{"heading":"Bem-vindo","notAHeroField":"x"}' };
        },
      };
    }) as typeof actual.createAiProvidersAdapter,
  };
});

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listApprovals } from '../src/host/approvalService.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { Page } from '../src/features/cms/cmsService.js';

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
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  expect(loc, 'cms-localization toggle must be registered').toBeTruthy();
  await saveConfig({ ...loc!, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
type PageBody = Page;
interface Client {
  get: <T = PageBody>(p: string) => Promise<Res<T>>;
  post: <T = PageBody>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T = PageBody>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

describe('cms.localize-and-submit — REAL executor (CMSLWF-3)', () => {
  it('from-chain → POST /runs → overlay persisted, page in_review, ONE pending content-publish row', async () => {
    const tenantId = `org:cmsrx-${Date.now()}`;
    const owner = client();
    const login = await owner.post<unknown>('/host/openwop-app/test/login', { email: `cmsrx-${Date.now()}@acme.test`, tenantId });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId;

    const lang = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(lang.status, JSON.stringify(lang.body)).toBe(200);
    const created = await owner.post(u(orgId, '/pages'), { title: 'Chain Doc', sections: [{ type: 'hero', data: { heading: 'Welcome' } }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId;
    const sectionId = created.body.sections[0]!.sectionId;
    expect(created.body.status).toBe('draft');

    // Instantiate the chain exactly as the builder's "Use template" does.
    const inst = await owner.post<{ workflowId: string; warnings?: unknown[] }>('/host/openwop-app/workflows/from-chain', {
      chainId: 'cms.localize-and-submit',
      params: { orgId, pageId, sectionId, targetLocale: 'pt-BR' },
    });
    expect(inst.status, JSON.stringify(inst.body)).toBe(201);
    expect(inst.body.warnings ?? [], 'every feature.cms.nodes typeId must resolve on this host').toEqual([]);
    const workflowId = inst.body.workflowId;

    // Start it through the public run-create route (real scheduler + executor).
    const start = await owner.post<{ runId: string }>('/runs', { workflowId, inputs: {} });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    // The protocol answers a tenant-bound id; storage keys the bare one (ADR 0812).
    const runId = bareRunId(start.body.runId);
    expect(runId).toBeTruthy();

    // No hook to await the run's settle — poll the REAL condition (terminal status).
    const run: RunRecord | null = await vi.waitFor(async () => {
      const r = await storage.getRun(runId);
      expect(TERMINAL.has(r?.status ?? '')).toBe(true);
      return r;
    }, { timeout: 5000, interval: 25 });
    expect(run?.status, `run did not complete: ${JSON.stringify(run)}`).toBe('completed');
    // The model was really consulted through ctx.callAI (the executor-built adapter).
    expect(ai.calls.length).toBe(1);
    expect(JSON.stringify(ai.calls[0]?.messages)).toContain('Welcome');

    // The overlay is persisted on the page for pt-BR (sanitized: undeclared key dropped)…
    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.sections[0]!.localizations?.['pt-BR']).toEqual({ heading: 'Bem-vindo' });
    // …the base data is untouched…
    expect(page.body.sections[0]!.data.heading).toBe('Welcome');
    // …the page reached review…
    expect(page.body.status).toBe('in_review');
    // …and exactly ONE pending content-publish row exists for it.
    const rows = (await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
    expect(rows.length).toBe(1);
  });
});
