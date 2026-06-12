/**
 * RFC 0093 §A.3 — webhook subscription tenant scoping, end-to-end:
 *
 *   - Registration captures the caller's tenant; an explicit foreign
 *     `tenantId` is refused 403 (registration-time membership gate per
 *     webhooks.md §Endpoints — never 201).
 *   - List + delete are tenant-scoped (a foreign tenant scope can neither
 *     see nor unregister a held subscription).
 *   - The test seam (`surface: "webhooks"`) registers per-tenant and proves
 *     cross-tenant invisibility — the contract the conformance scenario
 *     `webhook-tenant-isolation.test.ts` drives.
 *   - Delivery fanout matches ONLY subscriptions whose tenantId equals the
 *     originating run's tenant (cross-tenant delivery negative).
 *
 * Boots the full app (auth middleware included) so the membership gate runs
 * exactly as deployed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __deliverToSubscribersForTests } from '../src/routes/webhooks.js';
import type { EventRecord, RunRecord, WebhookSubscriptionRecord } from '../src/types.js';

const TOKEN = 'sample-token';
let server: http.Server;
let base = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function jsonFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const SAFE_URL = 'https://example.com/openwop-test/webhook-tenant';

async function seam(tenantId: string, op: string, args: Record<string, unknown>) {
  return jsonFetch('/v1/host/sample/test/surface', {
    method: 'POST',
    body: JSON.stringify({ tenantId, surface: 'webhooks', op, args }),
  });
}

describe('rfc0093 §A.3 — registration-time membership gate', () => {
  it('registers under the caller tenant and returns webhookId + secretFingerprint', async () => {
    const reg = await jsonFetch('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: SAFE_URL, events: ['run.completed'] }),
    });
    expect(reg.status).toBe(201);
    expect(typeof reg.body.webhookId).toBe('string');
    expect(reg.body.webhookId).toBe(reg.body.subscriptionId);
    expect(typeof reg.body.secret).toBe('string');
    expect(reg.body.secretFingerprint).toMatch(/^[0-9a-f]{8}$/);

    // Own-tenant list sees it.
    const list = await jsonFetch('/v1/webhooks');
    const ids = (list.body.subscriptions as Array<{ webhookId: string }>).map((s) => s.webhookId);
    expect(ids).toContain(reg.body.webhookId);

    // Cleanup.
    const del = await jsonFetch(`/v1/webhooks/${reg.body.webhookId as string}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('refuses registration under a tenant the caller is not a member of (never 201)', async () => {
    const reg = await jsonFetch('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: SAFE_URL,
        events: ['run.completed'],
        tenantId: `foreign-${Date.now()}`,
      }),
    });
    expect(reg.status).toBe(403);
    expect(reg.body.error).toBe('forbidden_tenant');
  });

  it('a held subscription cannot be seen or unregistered through a foreign tenant scope', async () => {
    const reg = await jsonFetch('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: SAFE_URL, events: ['run.completed'] }),
    });
    expect(reg.status).toBe(201);
    const webhookId = reg.body.webhookId as string;
    try {
      const del = await jsonFetch(`/v1/webhooks/${webhookId}?tenantId=foreign-${Date.now()}`, {
        method: 'DELETE',
      });
      expect(del.status).toBe(403); // not a member of that tenant — and never 204
      // Still held in the caller's own scope.
      const list = await jsonFetch('/v1/webhooks');
      const ids = (list.body.subscriptions as Array<{ webhookId: string }>).map((s) => s.webhookId);
      expect(ids).toContain(webhookId);
    } finally {
      await jsonFetch(`/v1/webhooks/${webhookId}`, { method: 'DELETE' });
    }
  });
});

describe('rfc0093 §A.3 — test seam two-tenant proof (webhook-tenant-isolation contract)', () => {
  it('a subscription registered under tenant A is invisible to tenant B', async () => {
    const reg = await seam('tenant-a', 'register', { url: SAFE_URL, events: ['run.completed'] });
    expect(reg.status).toBe(200);
    const webhookId = reg.body.webhookId as string;
    expect(typeof webhookId).toBe('string');
    try {
      const listB = await seam('tenant-b', 'list', {});
      expect(listB.status).toBe(200);
      const idsB = (listB.body.webhooks as Array<{ webhookId: string }>).map((w) => w.webhookId);
      expect(idsB).not.toContain(webhookId);

      const listA = await seam('tenant-a', 'list', {});
      const idsA = (listA.body.webhooks as Array<{ webhookId: string }>).map((w) => w.webhookId);
      expect(idsA).toContain(webhookId);

      // Foreign-tenant unregister is refused; own-tenant succeeds (below).
      const delB = await seam('tenant-b', 'unregister', { webhookId });
      expect(delB.status).toBe(404);
    } finally {
      const delA = await seam('tenant-a', 'unregister', { webhookId });
      expect(delA.status).toBe(200);
    }
  });
});

describe('rfc0093 §A.3 — delivery fanout tenant isolation (negative)', () => {
  it('only the run-tenant subscription is enqueued; the cross-tenant one never matches', async () => {
    // Isolated storage so the queue contents are fully attributable.
    const storage: Storage = await openStorage('memory://');
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'run-fanout-1',
      workflowId: 'wf-any',
      tenantId: 'tenant-a',
      status: 'completed',
      inputs: {},
      metadata: {},
      configurable: {},
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertRun(run);

    const mkSub = (id: string, tenantId: string): WebhookSubscriptionRecord => ({
      subscriptionId: id,
      tenantId,
      url: `https://example.com/${id}`,
      events: ['run.completed'],
      secret: 's',
      createdAt: now,
    });
    await storage.insertWebhook(mkSub('sub-tenant-a', 'tenant-a'));
    await storage.insertWebhook(mkSub('sub-tenant-b', 'tenant-b'));

    const event: EventRecord = {
      eventId: 'ev-1',
      runId: run.runId,
      sequence: 1,
      type: 'run.completed',
      payload: {},
      timestamp: now,
    };
    await __deliverToSubscribersForTests(storage, event);

    const queued = await storage.claimDueWebhookDeliveries('inspector', Date.now() + 1, 1, 10);
    expect(queued.map((d) => d.subscriptionId)).toEqual(['sub-tenant-a']);
    await storage.close();
  });
});
