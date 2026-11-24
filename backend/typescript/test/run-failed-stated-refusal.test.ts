/**
 * A run that fails on a node's stated refusal tells its owner why.
 *
 * A node that throws `OpenwopError('conflict', 'Missing input: …')` used to reach
 * `run.failed` as `internal_error`: the executor's node catch kept `.code` only
 * for AiProviderError, McpError, ReplayEffectError and CredentialGateError. The
 * terminal classifier then fell to its generic arm, so the run-failed notice and
 * the dead-letter reason both said "Something went wrong. Check the server logs."
 * for a run that had failed correctly and named its cause.
 *
 * Red without the fix: drop `OpenwopError` from the node catch's allowlist and
 * the code reads `internal_error`; route the executor back through
 * `classifyDispatchError` and the user message is the generic sentence.
 * The notice reads the same `classified.userMessage` as the dead-letter
 * `reason`, so the reason stands in for it here.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { OpenwopError } from '../src/types.js';
import { classifyTerminalFailure } from '../src/observability/errorRecovery.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

const STATED = 'Missing input: brief. Add a brief and run again.';
const GENERIC = 'Something went wrong. Check the server logs.';
/** Key-shaped material a stated message must never carry into the notice. */
const LEAKY = 'sk-live-DEADBEEFdeadbeef0123456789';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.refuses-conflict',
    version: '1.0.0',
    async execute() { throw new OpenwopError('conflict', STATED, 409); },
  });
  registry.register({
    typeId: 'test.refuses-leaky',
    version: '1.0.0',
    async execute() { throw new OpenwopError('conflict', `Missing input: key ${LEAKY} was rejected.`, 409); },
  });
  registry.register({
    typeId: 'test.returns-not-found',
    version: '1.0.0',
    async execute() { return { status: 'failure', error: { code: 'not_found', message: 'The brief this step reads was deleted.' } }; },
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Ev { type?: string; payload?: Record<string, unknown> }

async function failedRun(workflowId: string, typeId: string): Promise<Ev[]> {
  await api('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'step', typeId, config: {} }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  let status = 'pending';
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  expect(status).toBe('failed');
  return (await api<{ events?: Ev[] }>(`/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`)).body.events ?? [];
}

function terminal(events: Ev[]): { error: Record<string, unknown>; reason: string } {
  const failed = events.find((e) => e.type === 'run.failed');
  const dead = events.find((e) => e.type === 'run.dead_lettered');
  return { error: (failed?.payload?.error ?? {}) as Record<string, unknown>, reason: String(dead?.payload?.reason ?? '') };
}

describe('a node that throws a stated refusal', () => {
  it('reaches run.failed with its own code and message as the user message', async () => {
    const { error, reason } = terminal(await failedRun('stated-refusal.conflict', 'test.refuses-conflict'));
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(STATED);
    expect(error.userMessage).toBe(STATED);
    expect(error.category).toBe('config');
    expect(error.action).toBe('abort');
    expect(reason).toBe(STATED);
    expect(reason).not.toBe(GENERIC);
  });

  it('scrubs key-shaped material before the message becomes the notice', async () => {
    const { error, reason } = terminal(await failedRun('stated-refusal.leaky', 'test.refuses-leaky'));
    expect(error.code).toBe('conflict');
    expect(reason).toContain('Missing input');
    expect(reason).not.toContain(LEAKY);
    expect(String(error.userMessage)).not.toContain(LEAKY);
  });
});

describe('a node that returns a stated failure', () => {
  it('shows its message, not the generic sentence', async () => {
    const { error, reason } = terminal(await failedRun('stated-refusal.not-found', 'test.returns-not-found'));
    expect(error.code).toBe('not_found');
    expect(reason).toBe('The brief this step reads was deleted.');
  });
});

describe('classifyTerminalFailure', () => {
  it('keeps the generic arm for codes that do not state a cause', () => {
    expect(classifyTerminalFailure({ code: 'internal_error', message: 'ENOENT /srv/secret/path' }).userMessage).toBe(GENERIC);
  });

  it('keeps every other classification', () => {
    expect(classifyTerminalFailure({ code: 'provider_rate_limited', message: 'x' }).category).toBe('rate_limit');
  });

  it('falls back to the generic arm for an empty stated message', () => {
    expect(classifyTerminalFailure({ code: 'conflict', message: '  ' }).userMessage).toBe(GENERIC);
  });

  it('keeps a stated message to one bounded line', () => {
    const out = classifyTerminalFailure({ code: 'validation_error', message: `Field\n  brief is required. ${'x'.repeat(400)}` }).userMessage;
    expect(out.startsWith('Field brief is required.')).toBe(true);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });
});
