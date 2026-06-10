/**
 * TOTP multi-factor auth — RFC 6238 (ADR 0002, Phase 5).
 *
 * Ports MyndHyve's break-glass MFA (TOTP, RFC 6238) as a second factor on a
 * durable User. `node:crypto` only (HMAC-SHA1 HOTP + base32) — zero new deps.
 *
 * Enrollment is two-step: `beginEnrollment` mints a secret + recovery codes
 * (status `pending`), and `activate` flips it to `active` ONLY after the user
 * proves possession with a live code — so a half-finished enrollment never
 * locks anyone out. `verify` accepts a TOTP (±1 step clock-skew window,
 * constant-time compare) or a single-use recovery code.
 *
 * SECRET HANDLING (finding C3): the TOTP shared secret + recovery codes are the
 * sensitive material. They are returned to the caller EXACTLY ONCE at
 * enrollment (the secret to seed an authenticator, the recovery codes to store)
 * and never again; recovery codes are kept only as sha256 hashes. This store is
 * sample-grade at-rest — a production host keeps the TOTP secret in the host
 * secret vault, not the entity store (noted, not done here).
 *
 * FAIL-CLOSED (finding H5): an unknown / non-active enrollment verifies to
 * false; there is no bypass.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

const STEP_SECONDS = 30;
const DIGITS = 6;
const SKEW_STEPS = 1; // ±1 step (±30s) tolerance
const RECOVERY_CODE_COUNT = 8;
/** Bounded retries so a benign concurrent write (lost CAS) doesn't surface as a
 *  spurious "invalid code" (review finding #9). */
const CAS_RETRIES = 3;

export type MfaStatus = 'pending' | 'active';

export interface MfaEnrollment {
  userId: string;
  tenantId: string;
  /** TOTP shared secret (base32). Sample-grade at-rest; prod -> secret vault. */
  secretBase32: string;
  status: MfaStatus;
  /** sha256 of each unused single-use recovery code. */
  recoveryCodeHashes: string[];
  /** The TOTP step counter most recently accepted — a code at or before this
   *  step is rejected as a replay (review finding #6, RFC 6238 §5.2). */
  lastUsedStep?: number;
  createdAt: string;
  activatedAt?: string;
}

const store = new DurableCollection<MfaEnrollment>('users:mfa', (m) => m.userId);

// --- base32 (RFC 4648, no padding) ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// --- HOTP / TOTP (RFC 4226 / 6238) ---
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** The current TOTP for a base32 secret. Exported for callers that display or
 *  test codes; verification uses `verifyTotp` (windowed, constant-time). */
export function totp(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / STEP_SECONDS));
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The TOTP step counter a token matches within the skew window, or null. The
 *  matched step is the replay-protection key (review finding #6). */
function matchTotpStep(secretBase32: string, token: string, atMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let i = -SKEW_STEPS; i <= SKEW_STEPS; i++) {
    if (constantTimeEqual(hotp(secret, counter + i), token)) return counter + i;
  }
  return null;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function otpauthUri(secretBase32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export interface MfaEnrollmentResult {
  /** otpauth:// URI to seed an authenticator app (and the raw secret). */
  otpauthUri: string;
  secretBase32: string;
  /** One-time recovery codes — shown ONCE; store them now. */
  recoveryCodes: string[];
}

/** Begin (or restart) TOTP enrollment. Returns the secret + recovery codes ONCE;
 *  status is `pending` until `activate` confirms a live code. */
export async function beginEnrollment(input: { tenantId: string; userId: string; accountLabel: string; issuer?: string }): Promise<MfaEnrollmentResult> {
  const secretBase32 = base32Encode(randomBytes(20));
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(5).toString('hex'));
  const enrollment: MfaEnrollment = {
    userId: input.userId,
    tenantId: input.tenantId,
    secretBase32,
    status: 'pending',
    recoveryCodeHashes: recoveryCodes.map(hashCode),
    createdAt: new Date().toISOString(),
  };
  // CAS the write so a concurrent enroll can't tear (returned secret != stored
  // secret) — review finding #7. Refuse to overwrite an ACTIVE factor with a
  // 409 (OpenwopError, not a bare Error -> no spurious 500, review finding #6).
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const existing = await store.get(input.userId);
    if (existing?.status === 'active') {
      throw new OpenwopError('conflict', 'MFA is already active for this user; disable it before re-enrolling.', 409, { userId: input.userId });
    }
    if (await store.compareAndSwap(existing, enrollment)) {
      return { otpauthUri: otpauthUri(secretBase32, input.accountLabel, input.issuer ?? 'OpenWOP'), secretBase32, recoveryCodes };
    }
  }
  throw new OpenwopError('conflict', 'MFA enrollment is being modified concurrently; retry.', 409, { userId: input.userId });
}

/** Activate a pending enrollment by proving possession of a live TOTP. Records
 *  the activating step as used so it cannot be immediately replayed. */
export async function activate(input: { userId: string; token: string; atMs?: number }): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const enrollment = await store.get(input.userId);
    if (!enrollment || enrollment.status === 'active') return false;
    const step = matchTotpStep(enrollment.secretBase32, input.token, input.atMs);
    if (step === null) return false;
    const next: MfaEnrollment = { ...enrollment, status: 'active', activatedAt: new Date().toISOString(), lastUsedStep: step };
    if (await store.compareAndSwap(enrollment, next)) return true;
    // lost CAS -> a concurrent write landed; re-read and retry (finding #9)
  }
  return false;
}

/** Verify a second factor for an ACTIVE enrollment — a TOTP, or a single-use
 *  recovery code (consumed on use). Fail-closed for unknown/pending users.
 *  Both branches commit via compare-and-swap so a concurrent second request
 *  cannot replay a TOTP step or double-spend a recovery code (findings #6/#7). */
export async function verify(input: { userId: string; token: string; atMs?: number }): Promise<boolean> {
  // Retry on a lost CAS so benign concurrency doesn't reject a valid code
  // (finding #9). A genuine replay / already-consumed code still fails on the
  // re-read (its step is now <= lastUsedStep, or its hash is gone).
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const enrollment = await store.get(input.userId);
    if (!enrollment || enrollment.status !== 'active') return false;

    const step = matchTotpStep(enrollment.secretBase32, input.token, input.atMs);
    if (step !== null) {
      // Replay protection: a step at or before the last accepted one is rejected.
      if (enrollment.lastUsedStep !== undefined && step <= enrollment.lastUsedStep) return false;
      const next: MfaEnrollment = { ...enrollment, lastUsedStep: step };
      if (await store.compareAndSwap(enrollment, next)) return true;
      continue; // concurrent write -> re-read and re-check
    }

    // Recovery-code path: normalize (codes are lowercase hex), match a stored
    // hash, then consume it atomically.
    const normalized = input.token.trim().toLowerCase();
    const idx = enrollment.recoveryCodeHashes.indexOf(hashCode(normalized));
    if (idx === -1) return false;
    const next: MfaEnrollment = {
      ...enrollment,
      recoveryCodeHashes: enrollment.recoveryCodeHashes.filter((_, i) => i !== idx),
    };
    if (await store.compareAndSwap(enrollment, next)) return true;
    // lost CAS -> re-read; if another request consumed this code, idx will be -1.
  }
  return false;
}

export async function isMfaActive(userId: string): Promise<boolean> {
  return (await store.get(userId))?.status === 'active';
}

export async function disableMfa(userId: string): Promise<boolean> {
  return store.delete(userId);
}

/** Test-only: clear all enrollments. */
export async function __resetMfaStore(): Promise<void> {
  await store.__clear();
}
