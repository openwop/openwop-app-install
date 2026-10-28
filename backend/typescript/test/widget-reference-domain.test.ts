/**
 * Reference domain slice (white-label PRD §4) — proves the conventions the
 * example exists to teach:
 *   - tenant scoping (A's widgets invisible to B),
 *   - idempotent per-entity seed (re-run = no-op; partial seed self-heals),
 *   - fail-closed mutation (409 + machine-readable reason; no silent success),
 *   - derived read-through projection (summary recomputes from the live store),
 *   - the env gate (routes absent unless OPENWOP_EXAMPLE_WIDGETS_ENABLED=true).
 *
 * Every service case owns its tenant, and every route case creates what it
 * mutates, so the file passes in any order (grade-tests wave 64: the cases used
 * to share `tenant-a` and passed only in file order).
 *
 * DOUBLE GUARD (named, so a probe on one copy is expected to stay green): the
 * cross-tenant archive is refused by the tenant-first row key
 * (`${tenantId}:${widgetId}`) AND by `getWidget`'s `row.tenantId === tenantId`
 * re-check. `listWidgets` has only its filter, which the scoping case witnesses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { createApp } from '../src/index.js';
import { registerWidgetRoutes } from '../src/routes/widgets.js';
import { assertFlatErrorEnvelope, detailOf, errorCodeOf } from './helpers/errorEnvelope.js';
import {
  archiveWidget,
  createWidget,
  listWidgets,
  seedExampleWidgets,
  widgetSummary,
} from '../src/host/examples/widgetService.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const DEMO_NAMES = ['Flux capacitor', 'Turbo encabulator'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_EXAMPLE_WIDGETS_ENABLED = 'true';
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
  if (server) await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_EXAMPLE_WIDGETS_ENABLED;
});

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
const freshTenant = (label: string): string => `tenant-${label}-${Date.now()}-${seq++}`;

describe('widget reference domain — service conventions', () => {
  it('seed is idempotent and per-entity', async () => {
    const t = freshTenant('seed');
    const first = await seedExampleWidgets(t);
    expect(first.seeded).toBe(true);
    expect(first.widgets).toBe(2);

    const second = await seedExampleWidgets(t);
    expect(second.seeded).toBe(false);
    expect(second.widgets).toBe(2);
    expect((await listWidgets(t)).map((w) => w.name).sort()).toEqual(DEMO_NAMES);

    // A seed that failed partway self-heals: only the MISSING entity is added.
    const healing = freshTenant('heal');
    await createWidget(healing, 'Flux capacitor');
    expect(await seedExampleWidgets(healing)).toEqual({ seeded: true, widgets: 2 });
    expect((await listWidgets(healing)).map((w) => w.name).sort()).toEqual(DEMO_NAMES);
  });

  it('tenant scoping: tenant B sees none of tenant A', async () => {
    const a = freshTenant('scope-a');
    const b = freshTenant('scope-b');
    await seedExampleWidgets(a);
    expect((await listWidgets(a)).length).toBe(2);
    expect(await listWidgets(b)).toEqual([]);
  });

  it('fail-closed mutation: second archive refuses with a typed reason', async () => {
    const t = freshTenant('mut');
    const other = freshTenant('mut-other');
    await seedExampleWidgets(t);
    const [w] = await listWidgets(t);
    const ok = await archiveWidget(t, w!.widgetId);
    expect(ok).toMatchObject({ ok: true, widget: { widgetId: w!.widgetId, status: 'archived' } });

    const again = await archiveWidget(t, w!.widgetId);
    expect(again).toEqual({ ok: false, reason: 'already_archived' });

    // Cross-tenant mutation is a not_found, never a hit (double guard: see header).
    const cross = await archiveWidget(other, w!.widgetId);
    expect(cross).toEqual({ ok: false, reason: 'not_found' });
  });

  it('derived projection recomputes from the live store', async () => {
    const t = freshTenant('proj');
    await seedExampleWidgets(t);
    expect(await widgetSummary(t)).toEqual({ total: 2, active: 2, archived: 0 });
    const [w] = await listWidgets(t);
    await archiveWidget(t, w!.widgetId);
    expect(await widgetSummary(t)).toEqual({ total: 2, active: 1, archived: 1 });
    expect(await widgetSummary(freshTenant('proj-empty'))).toEqual({ total: 0, active: 0, archived: 0 });
  });
});

interface WidgetRow { widgetId: string; name: string; status: string }

describe('widget reference domain — route conventions', () => {
  it('seed + list round-trip over HTTP (bearer-shared default tenant)', async () => {
    const seed = await api<{ seeded: boolean; widgets: number }>('/host/openwop-app/widgets/seed', { method: 'POST', body: '{}' });
    expect(seed.status).toBe(200);
    expect(seed.body.widgets).toBeGreaterThanOrEqual(2);
    const list = await api<{ widgets: WidgetRow[]; total: number }>('/host/openwop-app/widgets');
    expect(list.status).toBe(200);
    // The default tenant is shared with the other route cases, so assert the
    // seed's own effect: each demo entity exactly once, and total is the list.
    for (const name of DEMO_NAMES) expect(list.body.widgets.filter((w) => w.name === name)).toHaveLength(1);
    expect(list.body.total).toBe(list.body.widgets.length);
  });

  it('fail-closed mutation maps to 409 + machine-readable reason', async () => {
    const created = await api<WidgetRow>('/host/openwop-app/widgets', { method: 'POST', body: JSON.stringify({ name: `route-mut-${Date.now()}` }) });
    expect(created.status).toBe(201);
    const id = created.body.widgetId;

    const first = await api<WidgetRow>(`/host/openwop-app/widgets/${id}/archive`, { method: 'POST', body: '{}' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('archived');

    const second = await api<unknown>(`/host/openwop-app/widgets/${id}/archive`, { method: 'POST', body: '{}' });
    expect(second.status).toBe(409);
    // H27-b — INVERTED. The machine-readable discriminator was a NEW TOP-LEVEL
    // `reason`, which `error-envelope.schema.json` forbids
    // (`additionalProperties: false`); it now rides `details.reason`. The point
    // of this leg — that the 409 is machine-readable and not just a status — is
    // unchanged, and the full-envelope assertion is what keeps it that way.
    assertFlatErrorEnvelope(second.body, 'widget archive conflict');
    expect(errorCodeOf(second.body)).toBe('conflict');
    expect(detailOf(second.body, 'reason')).toBe('already_archived');
  });

  it('validation failures are 400 with the canonical envelope', async () => {
    const bad = await api<unknown>('/host/openwop-app/widgets', { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);
    const env = assertFlatErrorEnvelope(bad.body, 'widget create validation');
    expect(env.error).toBe('validation_error');
    expect(env.message).toBe('`name` is required (a non-empty string ≤ 80 chars).');
  });

  it('the env gate: the routes are absent unless OPENWOP_EXAMPLE_WIDGETS_ENABLED=true', async () => {
    const saved = process.env.OPENWOP_EXAMPLE_WIDGETS_ENABLED;
    delete process.env.OPENWOP_EXAMPLE_WIDGETS_ENABLED;
    const app = express();
    app.use(express.json());
    let gated: http.Server | undefined;
    try {
      registerWidgetRoutes(app);
      const base = await new Promise<string>((res) => { gated = app.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(gated!.address() as AddressInfo).port}`)); });
      const list = await fetch(`${base}/host/openwop-app/widgets`);
      expect(list.status).toBe(404);
      const seed = await fetch(`${base}/host/openwop-app/widgets/seed`, { method: 'POST' });
      expect(seed.status).toBe(404);
    } finally {
      if (gated) await new Promise<void>((res) => gated!.close(() => res()));
      process.env.OPENWOP_EXAMPLE_WIDGETS_ENABLED = saved;
    }
    // Positive control: the same registration with the flag on mounts the route.
    const on = express();
    let onServer: http.Server | undefined;
    try {
      registerWidgetRoutes(on);
      const base = await new Promise<string>((res) => { onServer = on.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(onServer!.address() as AddressInfo).port}`)); });
      expect((await fetch(`${base}/host/openwop-app/widgets`)).status).toBe(200);
    } finally {
      if (onServer) await new Promise<void>((res) => onServer!.close(() => res()));
    }
  });
});
