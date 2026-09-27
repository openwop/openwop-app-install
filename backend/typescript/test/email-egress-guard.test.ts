/**
 * ADR 0655 D1 / D8 — the recipient egress guard seam and the send spine.
 *
 * Born-red on the pre-ADR adapter: it consulted nothing, so a suppressed or erased
 * address was mailed by every chain send, and a ledger RESERVATION (empty messageId)
 * read as a delivered send. Three groups:
 *   1. the seam's own posture (no guard ⇒ marketing refused, transactional proceeds);
 *   2. the email feature's registered guard through the REAL adapter and a real
 *      SendGrid mock — suppression, erasure tombstone, consent, and the clean path;
 *   3. D8 — a reservation is in-flight, not sent; a stale one is released.
 * Plus the review-B1 ratchet: `sendViaSmtp` has exactly ONE importer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeEmailAdapter } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { __resetRecipientEgressGuardsForTests, __registerPermissiveEgressGuardForTests, consultRecipientEgressGuard } from '../src/host/recipientEgressGuard.js';
import { registerEmailEgressGuard } from '../src/features/email/egressGuard.js';
import { addSuppression, removeSuppression } from '../src/features/crm/suppressionService.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { reserveSend, priorSend, releaseSend } from '../src/host/emailSentLedger.js';

const T = 'tguard';

describe('ADR 0655 — recipient egress guard', () => {
  let sg: http.Server;
  let storage: Storage;
  let calls = 0;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18949, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    sg = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { calls += 1; res.writeHead(202, { 'x-message-id': `sg-${calls}` }); res.end(); });
    });
    await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
    await createSecretConnection({ tenantId: T, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-guard', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_SENDGRID_API_BASE;
    await new Promise<void>((r) => sg.close(() => r()));
  });
  beforeEach(() => { calls = 0; __resetRecipientEgressGuardsForTests(); registerEmailEgressGuard(); });

  const adapter = () => makeEmailAdapter({ storage, tenantId: T, runId: 'run-guard', actingUserId: 'u1', orgId: T });
  const msg = (to: string, extra: Record<string, unknown> = {}) => ({ from: 'ops@acme.test', to, subject: `hi ${Math.random()}`, text: 'body', provider: 'sendgrid', ...extra });

  describe('1. the seam posture (review B3)', () => {
    it('no guard registered: a MARKETING send is refused, a TRANSACTIONAL one proceeds', async () => {
      __resetRecipientEgressGuardsForTests();
      const refused = await consultRecipientEgressGuard({ channel: 'email', tenantId: T, addresses: ['a@x.test'], purpose: 'marketing' });
      expect(refused).toEqual({ ok: false, code: 'email_egress_guard_missing', refused: 1 });
      const ok = await consultRecipientEgressGuard({ channel: 'email', tenantId: T, addresses: ['a@x.test'], purpose: 'transactional' });
      expect(ok).toEqual({ ok: true });
      // …and through the adapter: the refusal reaches the caller as a typed error, no provider call.
      const out = await adapter().send(msg('a@x.test'));
      expect(out).toMatchObject({ sent: false, error: 'email_egress_guard_missing' });
      expect(calls).toBe(0);
    });

    it('a guard that THROWS refuses (never a permission to send); the fold is all-or-nothing with a count', async () => {
      __resetRecipientEgressGuardsForTests();
      __registerPermissiveEgressGuardForTests('email');
      expect(await consultRecipientEgressGuard({ channel: 'email', tenantId: T, addresses: ['a@x.test', 'b@x.test'], purpose: 'marketing' })).toEqual({ ok: true });
      const { registerRecipientEgressGuard } = await import('../src/host/recipientEgressGuard.js');
      registerRecipientEgressGuard('email', async ({ address }) => { if (address.startsWith('b')) throw new Error('kv down'); return { ok: true }; });
      expect(await consultRecipientEgressGuard({ channel: 'email', tenantId: T, addresses: ['a@x.test', 'b@x.test', 'b2@x.test'], purpose: 'marketing' }))
        .toEqual({ ok: false, code: 'email_suppression_unreadable', refused: 2 });
    });
  });

  describe('2. the email feature guard through the REAL adapter', () => {
    it('a clean address is sent (positive control)', async () => {
      const out = await adapter().send(msg('clean@x.test'));
      expect(out.sent).toBe(true);
      expect(calls).toBe(1);
    });

    it('a SUPPRESSED address is refused for marketing AND transactional (bounce/complaint apply to every purpose), no provider call', async () => {
      await addSuppression(T, 'gone@x.test', 'manual', 'test', 'test'); // 'manual' so the finally can lift it; kind is irrelevant to the guard
      try {
        expect(await adapter().send(msg('Gone@X.test'))).toMatchObject({ sent: false, error: 'email_recipient_suppressed' });
        expect(await adapter().send(msg('gone@x.test', { purpose: 'transactional' }))).toMatchObject({ sent: false, error: 'email_recipient_suppressed' });
        // all-or-nothing: one suppressed cc refuses the whole message
        expect(await adapter().send(msg('clean2@x.test', { cc: 'gone@x.test' }))).toMatchObject({ sent: false, error: 'email_recipient_suppressed' });
        expect(calls).toBe(0);
        expect(await priorSend(`${T}:x`)).toBeNull();
      } finally { await removeSuppression(T, 'gone@x.test'); }
    });

    it('an ERASED address (real deleteSubject tombstone, raw and folded forms) is refused', async () => {
      await deleteSubject(T, 'Erased@X.test');
      expect(await adapter().send(msg('erased@x.test'))).toMatchObject({ sent: false, error: 'email_recipient_erased' });
      expect(await adapter().send(msg('Erased@X.test', { purpose: 'transactional' }))).toMatchObject({ sent: false, error: 'email_recipient_erased' });
      expect(calls).toBe(0);
    });

    it('a refusal never holds a ledger reservation (a later clean retry of the same key sends)', async () => {
      await addSuppression(T, 'later@x.test', 'manual', 'test', 'test');
      const m = msg('later@x.test', { idempotencyKey: 'k-later' });
      try { expect((await adapter().send(m)).sent).toBe(false); expect(await priorSend(`${T}:k-later`)).toBeNull(); }
      finally { await removeSuppression(T, 'later@x.test'); }
      expect((await adapter().send(m)).sent).toBe(true);
      expect(calls).toBe(1);
    });
  });

  describe('3. D8 — a reservation is in-flight, not sent', () => {
    it('a FRESH reservation answers email_send_in_flight and never reaches the provider', async () => {
      const key = `${T}:k-inflight`;
      expect(await reserveSend({ key, tenantId: T, provider: 'sendgrid', messageId: '', createdAt: new Date().toISOString() })).toBe('reserved');
      try {
        const out = await adapter().send(msg('inflight@x.test', { idempotencyKey: 'k-inflight' }));
        expect(out).toMatchObject({ sent: false, error: 'email_send_in_flight' });
        expect(calls).toBe(0);
      } finally { await releaseSend(key); }
    });

    it('a STALE reservation (a crashed send) is released and the retry reaches the provider', async () => {
      const key = `${T}:k-stale`;
      const old = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      expect(await reserveSend({ key, tenantId: T, provider: 'sendgrid', messageId: '', createdAt: old })).toBe('reserved');
      const out = await adapter().send(msg('stale@x.test', { idempotencyKey: 'k-stale' }));
      expect(out.sent).toBe(true);
      expect(calls).toBe(1);
      expect((await priorSend(key))?.messageId).toBe('sg-1');
    });
  });

  it('review B1 ratchet — `sendViaSmtp` has exactly ONE importer (the adapter); a second is a fourth egress path', () => {
    const root = join(process.cwd(), 'src');
    const importers: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('smtpSend.ts') && /from '\.{1,2}\/(?:host\/)?smtpSend\.js'/.test(readFileSync(p, 'utf-8'))) importers.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(importers.sort()).toEqual(['host/emailAdapter.ts']);
  });
});
