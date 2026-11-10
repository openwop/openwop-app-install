/**
 * ADR 1042 D4 (security review (b)) — the Telegram bot token travels in the URL
 * path, so no outcome, error string or log line may carry the dial URL.
 *
 * The fetch is forced to fail with an error whose message INCLUDES the URL it
 * was given (what a careless transport would echo), and then to succeed with a
 * response whose `url` carries it; both go through the REAL broker and the REAL
 * Telegram reply transport. Every stdout/stderr write during the send is
 * captured.
 *
 * Red when: the broker or the transport surfaces the fetch error's message, the
 * response URL, or the dial URL in an outcome or a log line.
 * Sabotage-witnessed 2026-11-03: logging the fetch error's message in
 * `brokeredFetch`'s catch, and logging `r.res.url` in the Telegram transport,
 * each turned its case red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TOKEN = '424242:SECRETtokenVALUE_abc-123';
const mode = vi.hoisted(() => ({ fail: true }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn(async (url: string) => {
      if (mode.fail) throw new TypeError(`fetch failed for ${url}`);
      return { status: 500, url, json: async () => ({ ok: false, description: `bad request to ${url}` }) };
    }),
  };
});

const { openSqliteStorage } = await import('../src/storage/sqlite/index.js');
const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { configureSecretResolver } = await import('../src/byok/secretResolver.js');
const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
const { sendChannelReply } = await import('../src/features/connections/messagingOutbound.js');
const { registerChannelReplyTransports } = await import('../src/features/channel-ingress/transports.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const storage = openSqliteStorage(':memory:');
let connectionId = '';
beforeAll(async () => {
  initHostExtPersistence(storage);
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-c1042-tok-')) });
  registerChannelReplyTransports(storage);
  connectionId = (await createSecretConnection({ tenantId: 't-tok', provider: 'telegram', kind: 'bearer', secret: TOKEN, scope: 'user', userId: 'user:tok' })).connectionId;
});
afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const chunks: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { chunks.push(String(c)); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { chunks.push(String(c)); return true; });
  try { return { value: await fn(), output: chunks.join('') }; } finally { out.mockRestore(); err.mockRestore(); }
}

describe('the bot token never leaves the broker', () => {
  for (const fail of [true, false]) {
    it(fail ? 'on a fetch that throws with the URL in its message' : 'on a response that carries the URL', async () => {
      mode.fail = fail;
      const { value, output } = await captured(() => sendChannelReply({
        tenantId: 't-tok', lane: { kind: 'connection', connectionId, provider: 'telegram' },
        chatId: '42', inboundMessageId: fail ? 'tok-1' : 'tok-2', text: 'hi', actingUserId: 'user:tok',
      }));
      expect(value.delivered).toBe(false);
      expect(JSON.stringify(value)).not.toContain('SECRETtoken');
      expect(output).not.toContain('SECRETtoken');
      // Non-vacuity: the send really reached the dial (the mock ran) and failed there.
      expect(value.reason).toMatch(fail ? /^telegram_request_failed$/ : /^telegram_rejected_500$/);
    });
  }
});
