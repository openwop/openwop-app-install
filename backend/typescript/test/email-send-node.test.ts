/**
 * core.email.send (ADR 0193 Phase 2) — provider-native send behind a MANDATORY
 * approval interrupt, driven directly with a fake ctx (the draft-node test
 * pattern). `createApp` wires the memory-storage singleton the shared
 * `email:sent` ledger needs.
 *
 * Pins the safety contract: sends ONLY after an interactive approve; reject /
 * headless never send (fail-closed); a replay/re-invoke dedups (no double
 * send); header injection is rejected; Gmail vs Graph endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  ensureNodesRegistered();
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const node = () => { const n = getNodeRegistry().get('core.email.send'); expect(n).toBeTruthy(); return n!; };

interface InvokeCall { id: string; url: string; body: string }
function makeCtx(over: Partial<NodeContext> & { _calls?: InvokeCall[]; _decision?: unknown }): NodeContext {
  const calls = over._calls ?? [];
  const base: NodeContext = {
    runId: 'run_send', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
    interactiveSession: true,
    suspend: async () => over._decision ?? { action: 'approve' },
    connectors: {
      invoke: async (id, request) => { calls.push({ id, url: request.url, body: String(request.body ?? '') }); return { ok: true, status: 200, data: { id: 'gmail-sent-1' } }; },
    } as NodeContext['connectors'],
  };
  const { _calls, _decision, ...rest } = over;
  void _calls; void _decision;
  return { ...base, ...rest };
}

describe('core.email.send (ADR 0193 Phase 2)', () => {
  it('interactive + approve → sends via Gmail messages/send, records the ledger, sent:true', async () => {
    const calls: InvokeCall[] = [];
    const out = await node().execute(makeCtx({ nodeId: 's-approve', _calls: calls, config: { to: 'b@y.com', subject: 'hi', body: 'go', connectorId: 'gmail' } }));
    expect(out.status).toBe('success');
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.sent).toBe(true);
    expect(o.messageId).toBe('gmail-sent-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(JSON.parse(calls[0]!.body)).toHaveProperty('raw'); // base64url RFC822, NOT a draft
  });

  it('interactive + reject → NOT sent (no connector call)', async () => {
    const calls: InvokeCall[] = [];
    const out = await node().execute(makeCtx({ nodeId: 's-reject', _calls: calls, _decision: { action: 'reject' }, config: { to: 'b@y.com', subject: 'hi', body: 'x', connectorId: 'gmail' } }));
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.sent).toBe(false);
    expect(o.reason).toBe('send_not_approved');
    expect(calls).toHaveLength(0);
  });

  it('headless (no interactive channel / no suspend) → NOT sent, run continues', async () => {
    const calls: InvokeCall[] = [];
    let suspended = false;
    const out = await node().execute(makeCtx({
      nodeId: 's-headless', _calls: calls, config: { to: 'b@y.com', subject: 'hi', body: 'x', connectorId: 'gmail' },
      interactiveSession: false,
      suspend: async () => { suspended = true; return { action: 'approve' }; },
    }));
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.sent).toBe(false);
    expect(o.reason).toBe('send_requires_approval');
    expect(suspended).toBe(false); // never even asked
    expect(calls).toHaveLength(0);
  });

  it('idempotency — a replay/re-invoke of the same (run,node) dedups, no second send', async () => {
    const calls: InvokeCall[] = [];
    const cfg = { nodeId: 's-idem', config: { to: 'b@y.com', subject: 'dedup', body: 'once', connectorId: 'gmail' } };
    const first = await node().execute(makeCtx({ ...cfg, _calls: calls }));
    const second = await node().execute(makeCtx({ ...cfg, _calls: calls })); // replay: same run/node
    expect((first as { outputs: Record<string, unknown> }).outputs.sent).toBe(true);
    const o2 = (second as { outputs: Record<string, unknown> }).outputs;
    expect(o2.sent).toBe(true);
    expect(o2.deduped).toBe(true);
    expect(calls).toHaveLength(1); // sent exactly once across the replay
  });

  it('rejects CR/LF header injection before any send', async () => {
    const calls: InvokeCall[] = [];
    const out = await node().execute(makeCtx({ nodeId: 's-inject', _calls: calls, config: { to: 'b@y.com', subject: 'hi\r\nBcc: evil@x.com', body: 'x', connectorId: 'gmail' } }));
    expect(out.status).toBe('failure');
    expect((out as { error: { code: string } }).error.code).toBe('invalid_config');
    expect(calls).toHaveLength(0);
  });

  it('Graph default → POSTs to /sendMail with { message, saveToSentItems }', async () => {
    const calls: InvokeCall[] = [];
    const out = await node().execute(makeCtx({ nodeId: 's-graph', _calls: calls, config: { to: 'b@y.com', subject: 'hi', body: 'x' } })); // no connectorId → microsoft-graph
    expect(out.status).toBe('success');
    expect(calls[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    const b = JSON.parse(calls[0]!.body);
    expect(b.saveToSentItems).toBe(true);
    expect(b.message.subject).toBe('hi');
  });
});
