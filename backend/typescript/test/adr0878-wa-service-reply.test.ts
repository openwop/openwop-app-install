/**
 * ADR 0878 OQ-1 (decided by the user 2026-10-12, Option B) — the narrow WhatsApp
 * SUPPORT-REPLY lane. One permissive case, the rest refuse-side: every constraint the
 * decision named is pinned by a test that goes red if the lane widens.
 *
 *  - ONLY a session message (never a template), to the number on THIS connection;
 *  - only inside 24h of the customer's LAST inbound, from the server-written window ledger;
 *  - refused on an explicit opt-out (a STOP, or a full marketing opt-out) and on an
 *    erasure tombstone — only an ABSENT opt-in is waived;
 *  - every other send stays strict (the generic `sendWhatsApp` still needs the opt-in);
 *  - exactly ONE caller in the tree (the service desk's reply delivery), and nothing
 *    reaches it from the whatsapp surface, the node pack, chat tools or MCP.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const brokerCalls: Array<{ body?: string }> = [];
vi.mock('../src/host/brokeredEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/brokeredEgress.js')>();
  return {
    ...actual,
    brokeredPost: vi.fn(async (_deps: unknown, opts: { provider: string; url: string | ((s: string) => string); body?: string }) => {
      brokerCalls.push({ ...(opts.body ? { body: opts.body } : {}) });
      return { outcome: 'sent', res: { status: 201, json: async () => ({ sid: `SM-${brokerCalls.length}`, status: 'queued' }) }, provenance: { provider: opts.provider, connectionId: 'c', scope: 'tenant' } };
    }),
  };
});

const { createApp } = await import('../src/index.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { upsertOAuthConnection } = await import('../src/features/connections/connectionsService.js');
const { pairConnection } = await import('../src/features/connections/messagingOutbound.js');
const { recordConsent, writeErasureTombstone } = await import('../src/features/consent/consentService.js');
const { sendWhatsApp, sendTicketReplyWhatsApp, recordInboundMessage } = await import('../src/features/whatsapp/whatsappService.js');

const TENANT = 'org:test-wa-svc';
let server: import('node:http').Server;
let storage: import('../src/storage/storage.js').Storage;
let connectionId: string;
let otherConnectionId: string;
let n = 0;
const num = (): string => `+1555700${String(1000 + n++)}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['whatsapp', 'consent']) await saveConfig({ ...getToggleDefault(id)!, status: 'on' }, 'test');
  connectionId = (await upsertOAuthConnection({ tenantId: TENANT, provider: 'twilio', userId: 'u1', tokens: { accessToken: 'AC1:t', tokenType: 'Bearer', scopes: ['sms.send'] } })).connectionId;
  await pairConnection(connectionId, 'whatsapp-twilio', 'whatsapp:+15550002222');
  otherConnectionId = (await upsertOAuthConnection({ tenantId: TENANT, provider: 'twilio', userId: 'u2', tokens: { accessToken: 'AC2:t', tokenType: 'Bearer', scopes: ['sms.send'] } })).connectionId;
  await pairConnection(otherConnectionId, 'whatsapp-twilio', 'whatsapp:+15550003333');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const DEPS = () => ({ storage, tenantId: TENANT, runId: 'servicedesk:t', actingUserId: 'u1' });
const reply = (to: string, over: Partial<{ connectionId: string; body: string; idempotencyKey: string }> = {}) =>
  sendTicketReplyWhatsApp(DEPS(), { connectionId, to, body: 'We are on it.', idempotencyKey: `k-${n++}`, ...over });

describe('ADR 0878 OQ-1 — the support-reply lane', () => {
  it('PERMITS: an in-window session reply to a customer who wrote in, with NO marketing opt-in', async () => {
    const to = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${to}`, new Date());
    expect(await reply(to)).toMatchObject({ sent: true, kind: 'session' });
    // …while the strict lane, for the same customer, still refuses (every other send stays strict).
    expect(await sendWhatsApp(DEPS(), { connectionId, to, body: 'promo' })).toMatchObject({ sent: false, error: 'consent_denied' });
  });

  it('REFUSES outside the 24h window of the LAST inbound (server-recorded)', async () => {
    const to = num();
    expect(await reply(to)).toMatchObject({ sent: false, error: 'outside_window' }); // never wrote in
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${to}`, new Date(Date.now() - 25 * 3_600_000));
    expect(await reply(to)).toMatchObject({ sent: false, error: 'outside_window' }); // wrote in 25h ago
  });

  it('REFUSES on another connection than the one the customer wrote to', async () => {
    const to = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${to}`, new Date());
    expect(await reply(to, { connectionId: otherConnectionId })).toMatchObject({ sent: false, error: 'outside_window' });
  });

  it('REFUSES on an explicit STOP (marketing.whatsapp=false) and on a full marketing opt-out', async () => {
    const stop = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${stop}`, new Date());
    await recordConsent({ tenantId: TENANT, subjectKey: stop, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': false }, source: 'whatsapp:keyword:opt-out' });
    expect(await reply(stop)).toMatchObject({ sent: false, error: 'opted_out' });
    const all = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${all}`, new Date());
    await recordConsent({ tenantId: TENANT, subjectKey: all, categories: { necessary: true, analytics: false, marketing: false }, source: 'test' });
    expect(await reply(all)).toMatchObject({ sent: false, error: 'opted_out' });
  });

  it('REFUSES an erased customer (tombstone)', async () => {
    const to = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${to}`, new Date());
    await writeErasureTombstone(TENANT, to);
    expect(await reply(to)).toMatchObject({ sent: false, error: 'subject_erased' });
  });

  it('REFUSES a template — the lane is session messages only', async () => {
    const to = num();
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${to}`, new Date());
    const smuggled = { connectionId, to, body: 'x', idempotencyKey: 'k-t', templateId: 'HX1' } as unknown as Parameters<typeof sendTicketReplyWhatsApp>[1]; // test-only justified cast: smuggles a field the signature forbids, to pin the runtime refusal
    expect(await sendTicketReplyWhatsApp(DEPS(), smuggled)).toMatchObject({ sent: false, error: 'validation_error' });
  });
});

describe('ADR 0878 OQ-1 — exactly one caller (ratchet)', () => {
  const SRC = join(import.meta.dirname, '../src');
  const PACKS = join(import.meta.dirname, '../../../packs');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|mjs|js|json)$/.test(e) && !e.endsWith('.test.ts')) out.push(p);
    }
    return out;
  };

  it('only the service desk\'s reply delivery calls the support-reply lane', () => {
    const callers = walk(SRC)
      .filter((p) => /\bsendTicketReplyWhatsApp\s*\(/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).split('\\').join('/'))
      .filter((p) => p !== 'features/whatsapp/whatsappService.ts') // the definition
      .sort();
    expect(callers).toEqual(['features/service-desk/delivery.ts']);
  });

  it('no pack, surface or tool can name it', () => {
    const named = [...walk(PACKS), join(SRC, 'features/whatsapp/surface.ts'), join(SRC, 'features/whatsapp/agentTools.ts')]
      .filter((p) => { try { return /sendTicketReplyWhatsApp|service-reply/.test(readFileSync(p, 'utf8')); } catch { return false; } });
    expect(named).toEqual([]);
  });
});
