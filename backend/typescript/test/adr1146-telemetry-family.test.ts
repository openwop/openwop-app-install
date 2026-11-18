/**
 * ADR 1146 (RFC 0262) — the v2 `telemetry` family, end to end through the real
 * app and its real OTLP exporter, with a capture listener standing in for the
 * collector:
 *   - the family is advertised only with BOTH the flag and an exporter endpoint;
 *   - a run exports `openwop.run` and a child `openwop.node.<typeId>` with the
 *     required attributes;
 *   - a run created with a `traceparent` exports into that trace, its run span
 *     parented on the caller's span;
 *   - a run that resumes under a later request (an approval resolved with a
 *     DIFFERENT `traceparent`) still exports into the creating trace. This is the
 *     case `runSpanParent` exists for: a new run executes inside the `POST /runs`
 *     request's context, so the plain case passes without it, but the resumed
 *     segment runs under the resolver's context. Removing `runSpanParent` from the
 *     run span turns only this case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { telemetryFamilyEnabled, v2TelemetryFamily } from '../src/observability/telemetryFamily.js';

type Json = Record<string, unknown>;
interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: Array<{ key: string; value: Json }> }
const spans: Span[] = [];
let collector: Server;
let server: Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OPENWOP_OTEL_COLLECTOR', 'OPENWOP_TELEMETRY_FAMILY'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> };
      for (const rs of body.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise<void>((ok) => collector.listen(0, '127.0.0.1', () => ok()));
  // Read by createTracer at boot, so set before the app is created.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  process.env.OPENWOP_OTEL_COLLECTOR = 'true';
  process.env.OPENWOP_TELEMETRY_FAMILY = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await new Promise<void>((ok) => collector.close(() => ok()));
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const attr = (s: Span, key: string): unknown => {
  const v = s.attributes.find((a) => a.key === key)?.value;
  return v?.['stringValue'] ?? (v?.['intValue'] !== undefined ? Number(v['intValue']) : undefined);
};
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}
/** Run `openwop-app.uppercase`, wait for its run span, return the run's spans. */
async function exported(headers: Record<string, string> = {}): Promise<{ runId: string; mine: Span[] }> {
  const c = await api('/runs', { method: 'POST', headers, body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { message: 'telemetry' } }) });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const runId = String(c.body['runId']);
  for (let i = 0; i < 400 && !spans.some((s) => s.name === 'openwop.run' && attr(s, 'openwop.run_id') === runId); i++) await new Promise((r) => setTimeout(r, 25));
  return { runId, mine: spans.filter((s) => attr(s, 'openwop.run_id') === runId) };
}

describe('ADR 1146 — RFC 0262 telemetry family', () => {
  it('is claimed only with both the flag and an exporter endpoint', () => {
    expect(telemetryFamilyEnabled({ OPENWOP_TELEMETRY_FAMILY: 'true' })).toBe(false);
    expect(telemetryFamilyEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' })).toBe(false);
    expect(telemetryFamilyEnabled({ OPENWOP_TELEMETRY_FAMILY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' })).toBe(true);
    expect(v2TelemetryFamily('2.0', '2.1')).toEqual({ telemetry: { status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated', otlp: { protocols: ['http/json'] }, genAiSemconv: '1.37.0' } });
  });

  it('discovery advertises the record', async () => {
    const d = (await api('/.well-known/openwop')).body;
    expect(d['telemetry']).toMatchObject({ witness: 'witnessable-gated', otlp: { protocols: ['http/json'] }, genAiSemconv: '1.37.0' });
  });

  it('a run exports openwop.run and a child node span with the required attributes', async () => {
    const { mine } = await exported();
    const run = mine.find((s) => s.name === 'openwop.run');
    expect(run, 'no openwop.run span').toBeDefined();
    expect(attr(run!, 'openwop.workflow_id')).toBe('openwop-app.uppercase');
    const node = mine.find((s) => s.name.startsWith('openwop.node.'));
    expect(node, 'no node span').toBeDefined();
    expect(node!.traceId).toBe(run!.traceId);
    for (const k of ['openwop.node_id', 'openwop.node_type']) expect(typeof attr(node!, k)).toBe('string');
    expect(attr(node!, 'openwop.node_attempt')).toBe(0);
  });

  it('a run created with a traceparent exports into that trace, the run span parented on the caller', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const { mine } = await exported({ traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((s) => s.traceId === traceId), JSON.stringify(mine.map((s) => [s.name, s.traceId]))).toBe(true);
    expect(mine.find((s) => s.name === 'openwop.run')!.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('a run resumed under another request still exports into the trace it was created in', async () => {
    const created = '0af7651916cd43dd8448eb211c80319c';
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const c = await api('/runs', { method: 'POST', headers: { traceparent: `00-${created}-b7ad6b7169203331-01` }, body: JSON.stringify({ workflowId: 'conformance-approval' }) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const wire = String(c.body['runId']);
    const runId = wire;
    for (let i = 0; i < 200; i++) {
      if ((await api(`/runs/${encodeURIComponent(wire)}`)).body['status'] === 'suspended') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await api(`/runs/${encodeURIComponent(wire)}/interrupts/gate`, { method: 'POST', headers: { traceparent: `00-${other}-00f067aa0ba902b7-01` }, body: JSON.stringify({ resumeValue: { action: 'approve' } }) });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const runSpans = (): Span[] => spans.filter((s) => s.name === 'openwop.run' && attr(s, 'openwop.run_id') === runId);
    for (let i = 0; i < 400 && runSpans().length < 2; i++) await new Promise((res) => setTimeout(res, 25));
    const mine = spans.filter((s) => attr(s, 'openwop.run_id') === runId);
    expect(mine.filter((s) => s.name === 'openwop.run').length, 'the resumed segment exported no run span').toBeGreaterThanOrEqual(2);
    expect(mine.every((s) => s.traceId === created), JSON.stringify(mine.map((s) => [s.name, s.traceId]))).toBe(true);
  });

  it('ADR 1146 D5 — the model-call span carries the GenAI chat-call set, and no prompt text reaches any span', async () => {
    const marker = 'conformance-prompt-marker-7f3a';
    const c = await api('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-callai-attempt-accounting', inputs: { request: { prompt: marker, maxTokens: 64 }, script: [{ kind: 'valid', outputTokens: 5 }] } }) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const runId = String(c.body['runId']);
    for (let i = 0; i < 400 && !spans.some((s) => s.name === 'openwop.run' && attr(s, 'openwop.run_id') === runId); i++) await new Promise((r) => setTimeout(r, 25));
    const mine = spans.filter((s) => attr(s, 'openwop.run_id') === runId);
    const call = mine.find((s) => s.attributes.some((a) => a.key === 'gen_ai.operation.name'));
    expect(call, JSON.stringify(mine.map((s) => s.name))).toBeDefined();
    expect(attr(call!, 'gen_ai.operation.name')).toBe('chat');
    expect(typeof attr(call!, 'gen_ai.provider.name')).toBe('string');
    expect(typeof attr(call!, 'gen_ai.request.model')).toBe('string');
    expect(attr(call!, 'gen_ai.usage.input_tokens')).toEqual(expect.any(Number));
    expect(attr(call!, 'gen_ai.usage.output_tokens')).toBe(5);
    // Only operation, provider, model and token counts: the prompt is on no span.
    expect(JSON.stringify(mine)).not.toContain(marker);
  });
});
