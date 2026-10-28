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
 *
 * Tracker TST-BG1-14. Red when (probe-witnessed, wave 58): the producer stamps a
 * catalog version other than 0.9.1, retargets the button's action off `resume`,
 * or raises an interrupt kind other than `clarification`. The two settle polls
 * are an honest real-clock ceiling (the run API has no hook to await); they use
 * `vi.waitFor` instead of a fixed-length sleep.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';

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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
    const create = await jsonFetch<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'openwop-app.a2ui-clarify', inputs: {} }),
    });
    expect(create.status).toBe(201);
    const { runId } = create.body;

    // Wait until the run suspends on an open interrupt.
    const open = await vi.waitFor(async () => {
      const list = await jsonFetch<OpenInterruptBody>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`);
      const found = list.body.interrupts ?? [];
      expect(found.length, 'run MUST suspend on a clarification interrupt').toBe(1);
      return found;
    }, { timeout: 5_000, interval: 50 });
    const it0 = open[0]!;
    expect(it0.kind).toBe('clarification');

    // The interrupt carries the A2UI surface the chat bridge keys on.
    const data = it0.data;
    if (!isRecord(data)) throw new Error(`interrupt data is not an object: ${JSON.stringify(data)}`);
    // The workflow's config reaches the interrupt (the free-text fallback).
    expect(data.question).toBe('When should the kickoff be?');
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
    const resolve = await fetch(`${BASE}/runs/${runId}/interrupts/${it0.nodeId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ resumeValue: { action: 'confirm', date: '2026-07-01', duration: '60', reminder: true } }),
    });
    expect(resolve.status).toBe(200);

    const finalStatus = await vi.waitFor(async () => {
      const snap = await jsonFetch<{ status: string }>(`/runs/${runId}`);
      expect(['completed', 'failed', 'cancelled']).toContain(snap.body.status);
      return snap.body.status;
    }, { timeout: 5_000, interval: 50 });
    expect(finalStatus, 'run MUST complete after the surface is resolved').toBe('completed');
  });
});
