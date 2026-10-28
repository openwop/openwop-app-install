/**
 * ADR 0723 — every tenant-bound id KIND rides the major-2 wire bound, and every
 * bound-kind path segment is accepted in its projected forms.
 *
 * `identity.md` §5 names five kinds (`runId`, `interruptId`, `subscriptionId`,
 * `deliveryId`, `effectId`); before this ADR the host projected ONE. Suite 2.2.1
 * has no v2 scenario naming `interruptId`, so a green suite proved nothing here —
 * these are the host's own witnesses, one leg per kind at the HTTP boundary,
 * cloned from `v2-bound-id-path-projection.test.ts` (RFC 0184, runs only).
 *
 * Tracker TST-BAA-4. Red when (sabotage-witnessed, wave 60): `interruptId` is
 * dropped from the bound-kind derivation; `projectV2RunIds` stops recursing into
 * arrays; `v2Identity` stops refusing a foreign tenant segment; the `~` segment
 * is no longer unprojected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';
import { V2_BOUND_ID_KEYS, projectV2RunIds } from '../src/host/v2Ids.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server; let base = ''; let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals['storage'] as Storage;
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Every body shape this file reads, as the narrow local view of each response. */
interface Body {
  subscriptionId?: string;
  error?: string;
  subscription?: { subscriptionId: string };
  outcome?: string;
  runId?: string;
  deliveries?: Array<{ deliveryId: string; subscriptionId?: string }>;
  events?: Array<{ type: string; payload: { interruptId?: string } }>;
}
async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: Body; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Body = {};
  try { json = JSON.parse(text) as Body; } catch { json = {}; }
  return { status: res.status, json, text };
}
const V2 = { 'OpenWOP-Version': '2' };
const BOUND = /^default\/[A-Za-z0-9._~-]{16,128}$/;

describe('ADR 0723 — the derived key set covers all five kinds', () => {
  it('V2_BOUND_ID_KEYS ⊇ every key the corpus binds to a kind other than runId', () => {
    for (const k of ['interruptId', 'subscriptionId', 'triggerSubscriptionId', 'deliveryId', 'effectId']) {
      expect(V2_BOUND_ID_KEYS.has(k), `${k} is typed as a tenant-bound kind in schemas/v2 and must be projected`).toBe(true);
    }
    // The run family is unchanged by the generalisation.
    for (const k of ['runId', 'parentRunId', 'sourceRunId', 'sourceRunIds', 'contributingRunIds']) expect(V2_BOUND_ID_KEYS.has(k)).toBe(true);
    // RFC 0187 §A binds the register-response `webhookId` to the
    // `subscriptionId` kind. The same bound value is the delivery dedup key in
    // OpenWOP-Webhook-Id, so the mint and the outbound header cannot diverge.
    expect(V2_BOUND_ID_KEYS.has('webhookId')).toBe(true);
  });

  it('effectId: a compensation/effect-ledger doc projects the effect id (no HTTP producer exists in-repo to drive it)', () => {
    const out = projectV2RunIds({ effectId: 'a'.repeat(32), effects: [{ effectId: 'b'.repeat(32), inverseActionId: 'x' }] }, 'default');
    expect(out).toEqual({
      effectId: `default/${'a'.repeat(32)}`,
      // a non-bound sibling key (`inverseActionId`) is untouched
      effects: [{ effectId: `default/${'b'.repeat(32)}`, inverseActionId: 'x' }],
    });
  });
});

describe('ADR 0723 — subscriptionId (webhooks)', () => {
  async function registerV2(): Promise<string> {
    const r = await req('POST', '/webhooks', V2, { url: 'https://hooks.example.test/adr0723', events: ['run.completed'] });
    expect(r.status, r.text.slice(0, 160)).toBe(201);
    expect(String(r.json.subscriptionId)).toMatch(BOUND);
    return String(r.json.subscriptionId);
  }
  // ADR 0812 P3c-0: the "under major 1 a bare one" half was deleted with major 1.
  it('POST /webhooks under major 2 returns a TENANT-BOUND subscriptionId', async () => {
    await registerV2();
  });
  it('DELETE /webhooks/{~-projected} resolves the bound segment (RFC 0184 §A.1 on a second kind)', async () => {
    const id = await registerV2();
    const projected = projectBoundId(id);
    expect(encodeURIComponent(projected)).toBe(projected);
    expect((await req('DELETE', `/webhooks/${projected}`, V2)).status).toBe(204);
    expect((await req('DELETE', `/webhooks/${projected}`, V2)).status, 'gone after the delete — the segment named THIS row').toBe(404);
  });
  it('DELETE /webhooks/{tenant%2Fopaque} — the percent form still resolves', async () => {
    const id = await registerV2();
    expect((await req('DELETE', `/webhooks/${encodeURIComponent(id)}`, V2)).status).toBe(204);
  });
  it("a bound id whose tenant is not the caller's is 403 id_tenant_mismatch, never 404", async () => {
    const id = await registerV2();
    const foreign = `other/${id.split('/')[1]}`;
    const r = await req('DELETE', `/webhooks/${encodeURIComponent(foreign)}`, V2);
    expect(r.status).toBe(403);
    expect(r.json?.error, 'v2 envelope: `error` IS the registry code').toBe('id_tenant_mismatch');
    expect((await req('DELETE', `/webhooks/${encodeURIComponent(id)}`, V2)).status, 'the refusal did not touch the row').toBe(204);
  });
  it("a foreign tenant's id is 403 even when it does NOT exist — the refusal is independent of existence (corpus finding, bus `4f4b`)", async () => {
    // The reference host looked the id up BEFORE checking the tenant segment, so
    // a foreign-tenant id that happened not to exist answered 404 not_found and
    // leaked "no such row" across a tenant boundary. Here the check lives in
    // `middleware/v2Identity.ts`, which runs BEFORE any route handler, so the
    // 403 cannot depend on the lookup — this pins that ordering.
    const ghost = `other/${'9'.repeat(36)}`;
    const r = await req('DELETE', `/webhooks/${encodeURIComponent(ghost)}`, V2);
    expect(r.status, 'a foreign tenant + a nonexistent id must still be 403').toBe(403);
    expect(r.json?.error).toBe('id_tenant_mismatch');
    // Control: the SAME nonexistent opaque under the CALLER's tenant is a 404 —
    // so the 403 above is the tenant rule firing, not a blanket refusal.
    const mine = await req('DELETE', `/webhooks/${encodeURIComponent(`default/${'9'.repeat(36)}`)}`, V2);
    expect(mine.status, 'own tenant, no such row ⇒ 404').toBe(404);
  });

  it('POST /webhooks/{projected}/test echoes the bound subscriptionId in the 202', async () => {
    const id = await registerV2();
    const r = await req('POST', `/webhooks/${projectBoundId(id)}/test`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(202);
    expect(r.json.subscriptionId).toBe(id);
  });
});

describe('ADR 0723 — subscriptionId + deliveryId (trigger subscriptions)', () => {
  it('register → read back by projected segment → ingest: subscription and delivery ids are bound on every read', async () => {
    const reg = await req('POST', '/trigger-subscriptions', V2, { source: 'form', workflowId: 'openwop-app.uppercase', verification: { mode: 'none' } });
    expect(reg.status, reg.text.slice(0, 200)).toBe(201);
    const id = String(reg.json.subscription?.subscriptionId);
    expect(id).toMatch(BOUND);

    const got = await req('GET', `/trigger-subscriptions/${projectBoundId(id)}`, V2);
    expect(got.status, got.text.slice(0, 160)).toBe(200);
    expect(got.json.subscription?.subscriptionId, 'resolved to the SAME row').toBe(id);

    const ingest = await req('POST', `/trigger-subscriptions/${projectBoundId(id)}/ingest`, V2, { fields: { q: 'hi' }, submissionId: 'adr0723-1' });
    expect(ingest.status, ingest.text.slice(0, 200)).toBe(200);
    expect(ingest.json.outcome).toBe('delivered');
    expect(String(ingest.json.runId), 'the started run is bound too').toMatch(BOUND);

    const after = await req('GET', `/trigger-subscriptions/${encodeURIComponent(id)}`, V2);
    expect(after.status).toBe(200);
    const deliveries = after.json.deliveries ?? [];
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      expect(String(d.deliveryId), 'deliveryId is a tenant-bound kind (identity.md §5)').toMatch(BOUND);
      expect(d.subscriptionId, 'each delivery names its (bound) subscription').toBe(id);
    }
    // ADR 0812 P3c-0: the "major 1 on the same row reads every id bare" control
    // was deleted with major 1.
  });
});

describe('ADR 0723 — interruptId (events read under major 2)', () => {
  it('a node.suspended payload written bare is read back with a TENANT-BOUND interruptId on /runs/{id}/events', async () => {
    // An IN-FLIGHT run: `node.suspended` is forward execution, which RFC 0194
    // refuses (at the store) behind a terminal event. `conformance-noop`
    // completes at once; `conformance-cancellable` holds until cancelled.
    const created = await req('POST', '/runs', V2, { workflowId: 'conformance-cancellable', inputs: {} });
    expect(created.status, created.text.slice(0, 160)).toBe(201);
    const bound = String(created.json.runId);
    const bare = bound.split('/')[1]!;
    const interruptId = 'f'.repeat(32);
    await storage.appendEvent({ eventId: randomUUID(), runId: bare, type: 'node.suspended', nodeId: 'n1', payload: { interruptId, kind: 'approval', nodeId: 'n1' }, timestamp: new Date().toISOString() });

    const v2 = await req('GET', `/runs/${projectBoundId(bound)}/events/poll`, V2);
    expect(v2.status, v2.text.slice(0, 200)).toBe(200);
    const ev2 = (v2.json.events ?? []).find((e) => e.type === 'node.suspended');
    expect(ev2, 'the seeded event is on the read').toBeDefined();
    expect(ev2!.payload.interruptId).toBe(`default/${interruptId}`);
    // ADR 0812 P3c-0: the "bare on /v1" control was deleted with major 1.
  });
});
