/**
 * ADR 0175 — Messaging Gateway inbound verifiers (Discord Ed25519 + Telegram
 * secret-token). Pure crypto unit tests over the net-new verification added to the
 * connections inbound-webhook seam (ADR 0024 §6). Slack HMAC + the trigger-bridge
 * dispatch are covered by connections-feature.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDiscordSignature, verifyTelegramSecret, inboundSupported, slashReply, type InboundConfig } from '../src/features/connections/inboundWebhooks.js';

/** A real Ed25519 keypair; return the RAW 32-byte public key as hex (Discord's format). */
function ed25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }); // 12-byte SPKI prefix + 32-byte key
  const publicKeyHex = Buffer.from(der).subarray(-32).toString('hex');
  return { publicKeyHex, privateKey };
}

describe('inboundSupported', () => {
  it('accepts slack/discord/telegram, rejects others', () => {
    expect(inboundSupported('slack')).toBe(true);
    expect(inboundSupported('discord')).toBe(true);
    expect(inboundSupported('telegram')).toBe(true);
    expect(inboundSupported('whatsapp')).toBe(false);
  });
});

describe('verifyDiscordSignature (Ed25519)', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = JSON.stringify({ type: 1 });

  it('accepts a correctly-signed request', () => {
    const { publicKeyHex, privateKey } = ed25519Pair();
    const signature = sign(null, Buffer.from(`${ts}${body}`, 'utf8'), privateKey).toString('hex');
    expect(verifyDiscordSignature({ publicKeyHex, timestampHeader: ts, signatureHeader: signature, rawBody: body, now }).ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { publicKeyHex, privateKey } = ed25519Pair();
    const signature = sign(null, Buffer.from(`${ts}${body}`, 'utf8'), privateKey).toString('hex');
    const v = verifyDiscordSignature({ publicKeyHex, timestampHeader: ts, signatureHeader: signature, rawBody: body + 'x', now });
    expect(v).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp', () => {
    const { publicKeyHex, privateKey } = ed25519Pair();
    const oldTs = String(Math.floor((now - 10 * 60_000) / 1000));
    const signature = sign(null, Buffer.from(`${oldTs}${body}`, 'utf8'), privateKey).toString('hex');
    expect(verifyDiscordSignature({ publicKeyHex, timestampHeader: oldTs, signatureHeader: signature, rawBody: body, now })).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects missing headers', () => {
    const { publicKeyHex } = ed25519Pair();
    expect(verifyDiscordSignature({ publicKeyHex, timestampHeader: undefined, signatureHeader: undefined, rawBody: body, now })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a signature from a different key (no cross-key acceptance)', () => {
    const a = ed25519Pair();
    const b = ed25519Pair();
    const signature = sign(null, Buffer.from(`${ts}${body}`, 'utf8'), a.privateKey).toString('hex');
    expect(verifyDiscordSignature({ publicKeyHex: b.publicKeyHex, timestampHeader: ts, signatureHeader: signature, rawBody: body, now }).ok).toBe(false);
  });
});

describe('verifyTelegramSecret (constant-time token)', () => {
  it('accepts a matching token, rejects a mismatch/missing', () => {
    expect(verifyTelegramSecret({ expected: 's3cret-token', provided: 's3cret-token' }).ok).toBe(true);
    expect(verifyTelegramSecret({ expected: 's3cret-token', provided: 'wrong' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyTelegramSecret({ expected: 's3cret-token', provided: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('slashReply (Phase 2 host-local commands)', () => {
  const cfg: InboundConfig = { connectionId: 'c1', tenantId: 't1', provider: 'discord', workflowId: 'wf:abc', enabled: true, createdAt: '', updatedAt: '' };
  it('/help, /status, /pair reply host-locally; /run + unknown fall through (null)', () => {
    expect(slashReply('help', cfg)).toMatch(/Commands/);
    expect(slashReply('status', cfg)).toContain('wf:abc');
    expect(slashReply('status', { ...cfg, enabled: false })).toMatch(/paused/);
    expect(slashReply('pair', cfg)).toMatch(/linked/);
    expect(slashReply('run', cfg)).toBeNull();
    expect(slashReply('deploy', cfg)).toBeNull();
  });
});
