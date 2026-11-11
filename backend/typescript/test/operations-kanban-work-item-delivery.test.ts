/**
 * ADR 1081 — the Operations route is an auth and projection boundary, not a
 * second Kanban service. Core-worker outcome simulation lives in
 * `kanban-work-item-daemon.test.ts`; these cases prove that the fleet summary
 * is gated and cannot leak the identities that its source rows contain.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { __resetKanbanStore, applyBoardCommand, createBoard } from '../src/host/kanbanService.js';

const SUPER_TENANT = 'org:test-kanban-delivery-super';
const OPS = '/host/openwop-app/operations';

let base: string;
let server: http.Server;
let serial = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}, 60_000);

beforeEach(async () => {
  await __resetKanbanStore();
});

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ErrorBody { error: string; message: string }
interface SummaryBody {
  queue: { pending: number; claimed: number; delivered: number; deadLettered: number; oldestPendingCreatedAt: string | null; oldestPendingAgeS: number | null };
  outcomes: Record<'started' | 'not-eligible' | 'deferred' | 'workflow-unresolved' | 'retried' | 'dead-lettered', number>;
  window: { startsAt: string; endsAt: string };
  perInstance: boolean;
  fetchedAt: string;
}

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const setCookie of getSetCookies(res.headers) as string[]) {
      const match = /(__session=[^;]+)/.exec(setCookie);
      if (match) cookie = match[1]!;
    }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return { get: <T>(path: string) => call<T>('GET', path), post: <T>(path: string, body?: unknown) => call<T>('POST', path, body) };
}

async function login(tenantId: string) {
  const c = client();
  const response = await c.post('/host/openwop-app/test/login', { email: `kanban-delivery-${serial++}@acme.test`, tenantId });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return c;
}

describe('ADR 1081 — Kanban WorkItem fleet delivery summary', () => {
  it('refuses a plain tenant admin before reading shared delivery state', async () => {
    const c = await login('org:not-super');
    const response = await c.get<ErrorBody>(`${OPS}/kanban-work-items/summary`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(response.body.message).toContain('requires a superadmin principal');
  });

  it('returns aggregate-only durable queue state and explicitly says it is fleet-wide', async () => {
    const board = await createBoard({ tenantId: 'tenant-private', name: 'Do not project this title' });
    await applyBoardCommand({
      type: 'work-items.materialize', tenantId: 'tenant-private', boardId: board.id,
      scope: { kind: 'canvas.private', externalRef: 'private-ref' },
      source: { kind: 'private.plan', id: 'private-plan', revision: '1' },
      idempotencyKey: 'private-work',
      items: [{
        key: 'private', title: 'Do not project this work item', columnId: 'todo', workflowId: 'private-workflow',
        input: { apiKey: 'must-never-leave-the-core' }, execution: { mode: 'auto', maxAttempts: 2 },
      }],
    });
    const c = await login(SUPER_TENANT);
    const response = await c.get<SummaryBody>(`${OPS}/kanban-work-items/summary`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.perInstance).toBe(false);
    expect(response.body.queue.pending).toBe(1);
    expect(response.body.queue).toEqual({
      pending: 1, claimed: 0, delivered: 0, deadLettered: 0,
      oldestPendingCreatedAt: expect.any(String), oldestPendingAgeS: expect.any(Number),
    });
    expect(response.body.outcomes).toEqual({
      started: 0, 'not-eligible': 0, deferred: 0, 'workflow-unresolved': 0, retried: 0, 'dead-lettered': 0,
    });
    expect(Object.keys(response.body).sort()).toEqual(['fetchedAt', 'outcomes', 'perInstance', 'queue', 'window']);
    // Projection proof: durable source rows contain this tenant/work/card/input,
    // but a fleet operator gets only counts and times.
    expect(JSON.stringify(response.body)).not.toContain('tenant-private');
    expect(JSON.stringify(response.body)).not.toContain('must-never-leave-the-core');
    expect(JSON.stringify(response.body)).not.toContain('Do not project');
  });
});
