/**
 * ADR 0632 / bus finding `4024` — `events.md` §Stream modes: under major 2 a
 * `values` stream is ONE synthesized `state.snapshot` per `updates`-tier
 * transition (never the raw event), and a `Last-Event-ID` resumption emits a
 * snapshot FIRST. v1 `values` keeps its raw `node.completed`/`run.completed`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const V1 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function completedRun(headers: Record<string, string>, path: string): Promise<string> {
  const c = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
  expect(c.status, await c.clone().text()).toBe(201);
  const { runId } = await c.json() as { runId: string };
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = await (await fetch(`${base}${path}/${encodeURIComponent(runId)}`, { headers })).json() as { status: string };
    if (['completed', 'failed'].includes(s.status)) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not complete');
}

interface Frame { id?: string; event?: string; data?: string }
function frames(text: string): Frame[] {
  return text.split('\n\n').map((block) => block.trim()).filter((b) => b && !b.startsWith(':')).map((block) => {
    const f: Frame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('event:')) f.event = line.slice(6).trim();
      else if (line.startsWith('data:')) f.data = (f.data ?? '') + line.slice(5).trim();
    }
    return f;
  }).filter((f) => f.event !== undefined);
}

describe('v2 values stream = synthesized state.snapshot frames', () => {
  it('a fresh values stream carries ONLY state.snapshot frames, each a run-snapshot with a bound runId', async () => {
    const id = await completedRun(V2, '/runs');
    const r = await fetch(`${base}/runs/${encodeURIComponent(id)}/events?streamMode=values`, { headers: { ...V2, Accept: 'text/event-stream' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const fs = frames(await r.text());
    expect(fs.length, 'at least one updates-tier transition').toBeGreaterThan(0);
    expect(new Set(fs.map((f) => f.event))).toEqual(new Set(['state.snapshot']));
    for (const f of fs) {
      expect(/^\d+$/.test(f.id ?? '')).toBe(true);
      const snap = JSON.parse(f.data ?? '{}') as Record<string, unknown>;
      expect(snap.runId).toBe(id);
      expect(typeof snap.status).toBe('string');
      expect(snap.owner, 'v2 snapshot carries owner').toBeDefined();
    }
    expect((JSON.parse(fs[fs.length - 1]!.data!) as { status: string }).status).toBe('completed');
  });
  it('a Last-Event-ID resumption emits a state.snapshot FIRST, and never re-emits the resumption point', async () => {
    const id = await completedRun(V2, '/runs');
    const r = await fetch(`${base}/runs/${encodeURIComponent(id)}/events?streamMode=values`, { headers: { ...V2, Accept: 'text/event-stream', 'Last-Event-ID': '1' } });
    expect(r.status).toBe(200);
    const fs = frames(await r.text());
    expect(fs[0]?.event).toBe('state.snapshot');
    expect(fs[0]?.id).toBe('1');
    expect(fs.every((f) => f.event === 'state.snapshot')).toBe(true);
    // No frame after the leading snapshot names sequence 1 (the resumption point).
    expect(fs.slice(1).some((f) => f.id === '1')).toBe(false);
  });
  it('v1 values mode is untouched: raw node.completed / run.completed frames', async () => {
    const id = await completedRun(V1, '/v1/runs');
    const r = await fetch(`${base}/v1/runs/${encodeURIComponent(id)}/events?streamMode=values`, { headers: { ...V1, Accept: 'text/event-stream' } });
    expect(r.status).toBe(200);
    const fs = frames(await r.text());
    expect(fs.some((f) => f.event === 'state.snapshot')).toBe(false);
    expect(fs.some((f) => f.event === 'run.completed' || f.event === 'node.completed')).toBe(true);
  });
});

describe('a failed snapshot projection is surfaced, never silent (measured on prod 2026-09-05)', () => {
  it('when the projector throws, the values stream carries an `error` frame and closes', async () => {
    const runs = await import('../src/routes/runs.js');
    const spy = vi.spyOn(runs, 'projectRunSnapshot').mockImplementation(() => { throw new Error('projector exploded'); });
    try {
      const id = await completedRun(V2, '/runs');
      const r = await fetch(`${base}/runs/${encodeURIComponent(id)}/events?streamMode=values`, { headers: { ...V2, Accept: 'text/event-stream' } });
      expect(r.status).toBe(200);
      const fs = frames(await r.text());
      expect(fs.length, 'silence is not an option').toBeGreaterThan(0);
      expect(fs[0]?.event).toBe('error');
      const body = JSON.parse(fs[0]?.data ?? '{}') as { error?: string; details?: { sequence?: number } };
      expect(body.error).toBe('openwop-app.snapshot_failed');
      expect(typeof body.details?.sequence).toBe('number');
    } finally { spy.mockRestore(); }
  });
});
