/**
 * Issue #5897 (ISS-045) — a deferred chain copy runs with the provider and model
 * the run chose, not the ones frozen when the copy was made.
 *
 * Before: `expandChain({deferred:true})` lifted only prompt bodies and froze every
 * other config token, so the Run dialog offered `model` (its variable was declared)
 * and the run used the copy-time value anyway — run `a7ee7b9a` asked for haiku and
 * billed sonnet. RFC 0124's rewrite table, row 3, binds a whole-value config token
 * to a variable-sourced PortValue; this host now does that for `provider`/`model`
 * and resolves it per run (`executor/nodeCtxInputs.ts` `resolveNodeConfig`).
 *
 *   1. Shape: `provider`/`model` become `{type:'variable'}`; `orgId` stays frozen.
 *   2. Over the real `POST /runs`: a model chosen as a run input (what the Run
 *      dialog sends, keyed by the materialized variable) reaches
 *      `ctx.config.model`; without one, the copy's default does.
 *   3. Over the real `:fork` route: a forked run keeps the source's chosen model
 *      even after the copy's default has changed (it is read from the run's
 *      recorded inputs, never re-resolved from the current definition).
 *   4. `resolveNodeConfig`: an unbound variable DROPS the key (so the ADR 0903 run
 *      default fills it), and look-alike objects with extra keys are left alone.
 *
 * Sabotage (2026-11-13): passing raw `nodeRef.config` to the node again reds 2 and
 * 3 (the node sees the descriptor object); freezing provider/model in the loader
 * again reds 1, 2 and 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflowDurable } from '../src/host/workflowsRegistry.js';
import { resolveNodeConfig } from '../src/executor/nodeCtxInputs.js';
import { bareRunId } from './support/bareRunId.js';

const NODE = 'test.iss5897.capture-config';
const seen = new Map<string, Record<string, unknown>>();

const chain: WorkflowChain = {
  chainId: 'test.iss5897',
  version: '1.0.0',
  label: 'Deferred AI config',
  description: 'd',
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string', default: 'copy-default' },
      orgId: { type: 'string', default: 'org-frozen' },
    },
  },
  dag: {
    nodes: [{ id: 'gen', typeId: NODE, config: { provider: '{{params.provider}}', model: '{{params.model}}', orgId: '{{params.orgId}}' } }],
  },
};

let server: http.Server;
let storage: Storage;
let BASE = '';
let def: ReturnType<typeof expandChain>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  getNodeRegistry().register({
    typeId: NODE,
    version: '1.0.0',
    async execute(ctx) {
      seen.set(bareRunId(ctx.runId), { ...(ctx.config as Record<string, unknown>) });
      return { status: 'success', outputs: {} };
    },
  });
  def = expandChain(chain, { deferred: true });
  await registerWorkflowDurable(def);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...((init.headers as Record<string, string>) ?? {}) } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
}

/** Wait for the capture node to have run in `runId`, then return what it saw. */
async function configSeenBy(runId: string): Promise<Record<string, unknown>> {
  const id = bareRunId(runId);
  for (let i = 0; i < 200 && !seen.has(id); i++) await new Promise((r) => setTimeout(r, 25));
  const run = await storage.getRun(id);
  expect(seen.has(id), `the node never ran in ${id} (status ${run?.status})`).toBe(true);
  return seen.get(id)!;
}

/** The materialized variable a node config key is bound to. */
const varOf = (key: 'provider' | 'model'): string => (def.nodes[0]!.config as Record<string, { variableName: string }>)[key]!.variableName;

/** Start a run the way the Run dialog does: values keyed by the materialized variable. */
async function startRun(model?: string): Promise<string> {
  const inputs = model === undefined ? {} : { [varOf('model')]: model };
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: def.workflowId, inputs }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}

describe('issue #5897 — deferred copies bind provider/model per run', () => {
  it('binds provider and model to run variables and leaves other whole-value keys frozen', () => {
    const cfg = def.nodes[0]!.config as Record<string, unknown>;
    expect(cfg.provider).toEqual({ type: 'variable', variableName: expect.stringMatching(/_provider$/) });
    expect(cfg.model).toEqual({ type: 'variable', variableName: expect.stringMatching(/_model$/) });
    expect(cfg.orgId).toBe('org-frozen');
  });

  it('a model chosen as a run input reaches ctx.config; without one the copy default does', async () => {
    const chosen = await configSeenBy(await startRun('claude-haiku-5-5'));
    expect(chosen).toMatchObject({ provider: 'mock', model: 'claude-haiku-5-5', orgId: 'org-frozen' });
    const plain = await configSeenBy(await startRun());
    expect(plain).toMatchObject({ provider: 'mock', model: 'copy-default' });
  });

  it('a fork keeps the source run\'s model after the copy default changes', async () => {
    const src = await startRun('claude-haiku-5-5');
    expect((await configSeenBy(src)).model).toBe('claude-haiku-5-5');
    // The copy is edited after the run: its model default moves on.
    const modelVar = varOf('model');
    await registerWorkflowDurable({
      ...def,
      variables: (def.variables ?? []).map((v) => (v.name === modelVar ? { ...v, defaultValue: 'changed-default' } : v)),
    });
    const fork = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'branch' }) });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect((await configSeenBy(fork.body.runId)).model).toBe('claude-haiku-5-5');
    // A fresh run on the edited copy does see the new default.
    expect((await configSeenBy(await startRun())).model).toBe('changed-default');
  });
});

describe('issue #5897 — resolveNodeConfig', () => {
  it('drops an unbound variable so the run default can fill it, and leaves look-alikes alone', () => {
    const lookAlike = { type: 'variable', variableName: 'x', extra: 1 };
    const out = resolveNodeConfig({ provider: { type: 'variable', variableName: 'p' }, model: { type: 'variable', variableName: 'm' }, data: lookAlike }, { p: 'google' });
    expect(out).toEqual({ provider: 'google', data: lookAlike });
    expect('model' in out).toBe(false);
  });

  it('returns the same object when nothing needs resolving, and still interpolates {{inputs.X}}', () => {
    const plain = { provider: 'anthropic', n: 2 };
    expect(resolveNodeConfig(plain, { a: 1 })).toBe(plain);
    expect(resolveNodeConfig({ subject: 'Hi {{inputs.who}}' }, { who: 'Ada' })).toEqual({ subject: 'Hi Ada' });
  });
});
