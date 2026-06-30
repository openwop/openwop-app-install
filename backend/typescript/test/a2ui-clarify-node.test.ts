/**
 * `local.openwop-app.a2ui-clarify` producer + the `openwop-app.a2ui-clarify`
 * sample workflow (ADR 0051 Phase 3).
 *
 * Integration test through the run API (the repo convention — see
 * `media-emit-node.test.ts`): runs the workflow, asserts it suspends with a
 * `clarification` interrupt carrying a catalog-valid A2UI surface (the shape
 * the chat's `a2uiInterruptCard` bridge keys on + the renderer validates),
 * then resolves it with form values and asserts the run completes — covering
 * the producer → suspend → resume → completion path end to end.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const SUPPORTED = new Set([
  'heading', 'text', 'field.text', 'field.date', 'field.select', 'field.checkbox', 'action.button',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface OpenInterruptBody {
  interrupts?: Array<{ nodeId: string; kind: string; data?: unknown }>;
}

describe('openwop-app.a2ui-clarify (ADR 0051 Phase 3 producer)', () => {
  it('suspends with a catalog-valid A2UI surface, then resumes to completion', async () => {
    const create = await jsonFetch<{ runId: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'openwop-app.a2ui-clarify', inputs: {} }),
    });
    expect(create.status).toBe(201);
    const { runId } = create.body;

    // Poll until the run suspends on an open interrupt.
    let open: NonNullable<OpenInterruptBody['interrupts']> = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const list = await jsonFetch<OpenInterruptBody>(`/v1/host/openwop-app/runs/${runId}/interrupts`);
      open = list.body.interrupts ?? [];
      if (open.length > 0) break;
    }
    expect(open.length, 'run MUST suspend on a clarification interrupt').toBe(1);
    const it0 = open[0]!;
    expect(it0.kind).toBe('clarification');

    // The interrupt carries the A2UI surface the chat bridge keys on.
    const data = it0.data;
    expect(isRecord(data)).toBe(true);
    if (!isRecord(data)) return;
    expect(data.catalogVersion).toBe('0.9.1');
    expect(isRecord(data.surface)).toBe(true);
    const surface = data.surface as Record<string, unknown>;
    const components = surface.components as Array<Record<string, unknown>>;
    expect(Array.isArray(components)).toBe(true);
    for (const c of components) expect(SUPPORTED.has(c.component as string)).toBe(true);
    const buttons = components.filter((c) => c.component === 'action.button');
    expect(buttons.length).toBe(1);
    expect((buttons[0]!.action as Record<string, unknown>).target).toBe('resume');

    // Resolve with the collected form values; the run resumes and completes.
    // Raw fetch (status only) — the resume endpoint may answer 204/empty.
    const resolve = await fetch(`${BASE}/v1/runs/${runId}/interrupts/${it0.nodeId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ resumeValue: { action: 'confirm', date: '2026-07-01', duration: '60', reminder: true } }),
    });
    expect([200, 202, 204]).toContain(resolve.status);

    let finalStatus = 'unknown';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const snap = await jsonFetch<{ status: string }>(`/v1/runs/${runId}`);
      finalStatus = snap.body.status;
      if (['completed', 'failed', 'cancelled'].includes(finalStatus)) break;
    }
    expect(finalStatus, 'run MUST complete after the surface is resolved').toBe('completed');
  });
});
