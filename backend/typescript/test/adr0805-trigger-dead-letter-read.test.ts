/**
 * ADR 0805 / RFC 0232 — `listTriggerDeadLetters`, the trigger subscription's
 * dead-letter read.
 *
 * Pinned through the real app (HTTP), against what the corpus judge checks per
 * record: the facet is advertised; a refused signed post appears as
 * `verification_failed` with NO `stateChange`; retry exhaustion appears as
 * `retries_exhausted` WITH the state change it caused; `attempt` carries exactly
 * the `trigger.delivery.attempted` fields with `outcome: "dead-lettered"`;
 * `expiresAt − deadLetteredAt` is `retentionDays`; newest first; `limit` is
 * validated and paged with a `nextCursor`; a cursor from another subscription
 * is refused 400; another tenant's id and an unknown id are the same 404; and
 * the canary body, the signature, the secret and the raw `webhook-id` appear
 * nowhere in the read. Tracker: TST-BTR-2.
 *
 * Red when (wave 60 probes w60g4-dl-*): the advert drops `maxPageSize`; a
 * refused post names a `stateChange`, keeps the raw webhook-id as its dedupKey,
 * or a retention other than 7 days; retry exhaustion loses its state change;
 * the page is not newest-first; `limit=0` is accepted; a cursor carries across
 * subscriptions; another tenant's record is served.
 * The cursor check is a DOUBLE guard: the cursor names its subscription (`s`)
 * AND its row key must start with that subscription's prefix; only breaking
 * both carries a cursor across. The clamp to `maxPageSize` is NOT witnessed
 * here (3 rows < 100): this file pins only that an over-large limit is not
 * refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';

const OP = 'k-op-0805-operator';   // wildcard operator key (the conformance harness posture)
const TB = 'k-tb-0805-tenant-b';   // a key scoped to tenant-b
const DAY_MS = 24 * 60 * 60 * 1000;
let server: http.Server; let base = '';
const saved: Record<string, string | undefined> = {};

// The corpus page schema (vendored at the suite pin), with the payload defs it
// `$ref`s — so a record that is not the RFC 0232 §C shape fails here first.
const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of ['run-event-payloads.schema.json', 'trigger-dead-letter-page.schema.json']) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8')) as Record<string, unknown>);
}
const pageSchema = ajv.getSchema('https://openwop.dev/spec/v1/trigger-dead-letter-page.schema.json');
function pageErrors(doc: unknown): string[] {
  if (!pageSchema) throw new Error('trigger-dead-letter-page did not register — validation would be vacuous');
  return pageSchema(doc) ? [] : (pageSchema.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

const freshId = (): string => `msg_${randomBytes(12).toString('hex')}`;
const now = (): string => String(Math.floor(Date.now() / 1000));
function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

/** The response shapes this file reads. */
interface Attempt { subscriptionId: string; dedupKey: string; attempt: number; outcome: string }
interface DeadLetter { subscriptionId: string; attemptEventId: string; attempt: Attempt; stateChange?: Record<string, unknown>; reason: string; deadLetteredAt: string; expiresAt: string }
interface Body {
  error?: string;
  deliveries?: DeadLetter[];
  nextCursor?: string;
  subscription?: { subscriptionId: string; state?: string };
  binding?: { ingestUrl: string; signingSecret: string };
  subscriptionId?: string;
}
/** RFC 0232 §C.1's opaque dedup key, derived here independently of the host's helper. */
const dedupKeyOf = (...parts: string[]): string => createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}): Promise<{ status: number; body: Body }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key ?? OP}` },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Body };
}
async function ingest(url: string, body: string, headers: Record<string, string>) {
  const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: r.status };
}
async function register(mode: 'none' | 'required') {
  const r = await call('POST', '/trigger-subscriptions', { body: { source: 'webhook', workflowId: 'openwop-app.uppercase', verification: { mode } } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (!r.body.subscription || !r.body.binding) throw new Error('registration answered no subscription/binding');
  return { subscription: r.body.subscription, binding: r.body.binding };
}
/** A badly signed post under `required` — refused 401, dead-lettered. */
async function refuse(ingestUrl: string, body: string, webhookId = freshId()) {
  const r = await ingest(ingestUrl, body, { 'webhook-id': webhookId, 'webhook-timestamp': now(), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  expect(r.status).toBe(401);
}
async function deadLetters(id: string, query = '', key?: string) {
  const r = await call('GET', `/trigger-subscriptions/${id}/dead-letters${query}`, key ? { key } : {});
  if (r.status === 200) expect(pageErrors(r.body), 'every 200 is a schema-valid TriggerDeadLetterPage').toEqual([]);
  return r;
}

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_TRIGGER_INBOUND_SIGNING']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${OP}:*,${TB}:tenant-b`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0805 / RFC 0232 — listTriggerDeadLetters', () => {
  // ADR 0812 P3c-0 — read off the v2 document (the v1 one is retired); ADR 0810
  // carries the same `triggerBridge.deadLetter` facets on the v2 record.
  it('v2 discovery advertises triggerBridge.deadLetter with the values the read honours', async () => {
    const disco = (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as { triggerBridge?: { deadLetter?: unknown } };
    expect(disco.triggerBridge?.deadLetter).toEqual({ retentionDays: 7, maxPageSize: 100 });
  });

  it('a refused signed post is a `verification_failed` record with no stateChange, and carries no inbound content (§C.1, §C.3)', async () => {
    const { subscription, binding } = await register('required');
    const id = subscription.subscriptionId;
    const canary = `canary-${randomBytes(8).toString('hex')}`;
    const webhookId = freshId();
    await refuse(binding.ingestUrl, JSON.stringify({ canary }), webhookId);

    const page = await deadLetters(id);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.deliveries).toHaveLength(1);
    const rec = page.body.deliveries![0]!;
    expect(Object.keys(rec).sort()).toEqual(['attempt', 'attemptEventId', 'deadLetteredAt', 'expiresAt', 'reason', 'subscriptionId']);
    expect(rec.subscriptionId).toBe(id);
    expect(rec.reason).toBe('verification_failed');
    expect(rec.stateChange, 'a refused post changes no state, so it names none').toBeUndefined();
    expect(rec.attempt).toEqual({ subscriptionId: id, dedupKey: dedupKeyOf(bareRunId(id), webhookId), attempt: 1, outcome: 'dead-lettered' });
    expect(Date.parse(rec.expiresAt) - Date.parse(rec.deadLetteredAt)).toBe(7 * DAY_MS);
    expect(page.body.nextCursor).toBeUndefined();

    const wire = JSON.stringify(page.body);
    for (const leak of [canary, webhookId, binding.signingSecret, 'whsec_', 'AAAAAAAAAAAAAAAA']) {
      expect(wire, `the read must not carry ${leak.slice(0, 12)}…`).not.toContain(leak);
    }
    // §C.1 of RFC 0230 still holds: the refusal left the subscription active.
    expect((await call('GET', `/trigger-subscriptions/${id}`)).body.subscription?.state).toBe('active');
  });

  it('a delivered post is not a dead letter', async () => {
    const { subscription, binding } = await register('required');
    const body = '{}'; const wid = freshId(); const ts = now();
    const ok = await ingest(binding.ingestUrl, body, { 'webhook-id': wid, 'webhook-timestamp': ts, 'webhook-signature': sign(binding.signingSecret, wid, ts, body) });
    expect(ok.status).toBe(202);
    expect((await deadLetters(subscription.subscriptionId)).body).toEqual({ deliveries: [] });
  });

  it('retry exhaustion is a `retries_exhausted` record carrying the state change it caused', async () => {
    const seam = await call('POST', '/host/openwop-app/trigger-bridge/deliver', { body: { scenario: 'exhaust', source: 'queue' } });
    expect(seam.status, JSON.stringify(seam.body)).toBe(200);
    // The host seam answers the BARE id; the major-2 surface reads and answers it
    // tenant-bound (`identity.md` §5), so bind it to the dev key's tenant.
    const id = `default/${seam.body.subscriptionId ?? ''}`;
    const page = await deadLetters(id);
    expect(page.status).toBe(200);
    expect(page.body.deliveries).toHaveLength(1);
    const rec = page.body.deliveries![0]!;
    expect(rec.reason).toBe('retries_exhausted');
    expect(rec.attempt).toMatchObject({ subscriptionId: id, attempt: 2, outcome: 'dead-lettered' });
    expect(rec.stateChange).toEqual({ subscriptionId: id, source: 'queue', fromState: 'active', toState: 'dead-lettered', reason: 'retry-exhausted' });
  });

  it('pages newest first; `limit` pages with a nextCursor, and an invalid limit is 400', async () => {
    const { subscription, binding } = await register('required');
    const id = subscription.subscriptionId;
    // Distinct, ordered instants without a sleep: only `Date` is faked, one
    // second apart, so "newest first" cannot pass on a tie.
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(t0 + i * 1000);
        await refuse(binding.ingestUrl, `{"n":${i}}`);
      }
    } finally {
      vi.useRealTimers();
    }
    const all = (await deadLetters(id)).body.deliveries ?? [];
    expect(all).toHaveLength(3);
    const instants = all.map((r) => Date.parse(r.deadLetteredAt));
    expect([...instants].sort((a, b) => b - a), 'newest first').toEqual(instants);

    const p1 = await deadLetters(id, '?limit=2');
    expect(p1.body.deliveries?.map((r) => r.attemptEventId)).toEqual(all.slice(0, 2).map((r) => r.attemptEventId));
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await deadLetters(id, `?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor ?? '')}`);
    expect(p2.body.deliveries?.map((r) => r.attemptEventId)).toEqual([all[2]!.attemptEventId]);
    expect(p2.body.nextCursor, 'the last page carries no cursor').toBeUndefined();

    // Not refused (the clamp itself needs > maxPageSize rows to show; see header).
    expect((await deadLetters(id, '?limit=100000')).body.deliveries, 'an over-large limit is accepted, not refused').toHaveLength(3);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const r = await deadLetters(id, `?limit=${bad}`);
      expect(r.status, `limit=${bad}`).toBe(400);
      expect(r.body.error).toBe('validation_error');
    }
  });

  it('a cursor minted for another subscription, or a forged one, is refused 400 validation_error (§B.3)', async () => {
    const a = await register('required');
    const b = await register('required');
    for (let i = 0; i < 2; i++) { await refuse(a.binding.ingestUrl, '{}'); await refuse(b.binding.ingestUrl, '{}'); }
    const cursor = (await deadLetters(a.subscription.subscriptionId, '?limit=1')).body.nextCursor ?? '';
    expect(typeof cursor).toBe('string');
    const carried = await deadLetters(b.subscription.subscriptionId, `?cursor=${encodeURIComponent(cursor)}`);
    expect(carried.status).toBe(400);
    expect(carried.body.error).toBe('validation_error');
    for (const forged of ['not-a-cursor', Buffer.from('{"s":1}').toString('base64url')]) {
      const r = await deadLetters(a.subscription.subscriptionId, `?cursor=${forged}`);
      expect(r.status, forged).toBe(400);
      expect(r.body.error).toBe('validation_error');
    }
  });

  it('another tenant\'s subscription and an unknown id are the same 404 not_found (§B.2)', async () => {
    const { subscription, binding } = await register('required');
    await refuse(binding.ingestUrl, '{}');
    // ADR 0812 P2b — under major 2 the victim's id is tenant-BOUND. Presented as-is by
    // another tenant, it is refused one layer earlier, by `identity.md` §5
    // (`403 id_tenant_mismatch`, which names the rule and not the id)...
    const asIs = await deadLetters(subscription.subscriptionId, '', TB);
    expect(asIs.status).toBe(403);
    expect(asIs.body.error).toBe('id_tenant_mismatch');
    expect(JSON.stringify(asIs.body)).not.toContain('verification_failed');
    // ...so §B.2's indistinguishability is witnessed where it still applies: the
    // victim's opaque id RE-BOUND to the caller's own tenant, beside an unknown id
    // bound the same way. Both pass the segment check, and both must be the same 404.
    const foreign = await deadLetters(`tenant-b/${bareRunId(subscription.subscriptionId)}`, '', TB);
    const unknown = await deadLetters(`tenant-b/tgsub-${randomBytes(8).toString('hex')}`, '', TB);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body.error).toBe('not_found');
    expect(unknown.body.error).toBe(foreign.body.error);
    expect(JSON.stringify(foreign.body)).not.toContain('verification_failed');
  });
});
