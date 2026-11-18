/**
 * ADR 1141 (#6034) — the one-time codes and verified sessions of a recipient-bound
 * share link. Storage and crypto only: it imports nothing from the sharing service,
 * which imports it for the gate (`isVerified`) and the revoke cascade.
 *
 * A code is never stored. The row holds an HMAC-SHA256 over `tokenHash ‖ code`
 * under a key DERIVED with HKDF from the session secret and the label
 * `share-link-otp-v1`, so this key and the session-signing key never cross.
 * Rotating the session secret voids codes in flight (10 minutes), which is fine.
 */
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { readSessionSecret } from '../../middleware/cookieSession.js';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const SESSION_HOURS_DEFAULT = 24;
export const SESSION_HOURS_MAX = 720;

interface CodeRow {
  tokenHash: string;
  tenantId: string;
  codeMac: string;
  expiresAt: string;
  attempts: number;
  /** The age-out lane's one timestamp (`registerKvAgeOut`). */
  deadAt: string;
}

interface VerifiedRow {
  key: string;
  tokenHash: string;
  tenantId: string;
  sid: string;
  expiresAt: string;
  deadAt: string;
}

const codes = new DurableCollection<CodeRow>(
  'sharing:verify-code',
  (r) => r.tokenHash,
  (parsed) => {
    const r = parsed as CodeRow | null;
    return r && typeof r.tokenHash === 'string' && typeof r.tenantId === 'string' && typeof r.codeMac === 'string'
      && typeof r.expiresAt === 'string' && Number.isInteger(r.attempts) ? r : null;
  },
  (r) => r.tenantId,
);

const verified = new DurableCollection<VerifiedRow>(
  'sharing:verified',
  (r) => r.key,
  (parsed) => {
    const r = parsed as VerifiedRow | null;
    return r && typeof r.key === 'string' && typeof r.tokenHash === 'string' && typeof r.sid === 'string'
      && typeof r.expiresAt === 'string' ? r : null;
  },
  (r) => r.tenantId,
);

// A dead row (expired code, expired session) is reclaimed a day after it died.
registerKvAgeOut({ id: 'sharing:verify-code', prefix: 'hostext:sharing:verify-code:', ttlDays: 1, timestampField: 'deadAt' });
registerKvAgeOut({ id: 'sharing:verified', prefix: 'hostext:sharing:verified:', ttlDays: 1, timestampField: 'deadAt' });

let derived: { secret: string; key: Buffer } | undefined;
function macKey(): Buffer {
  const secret = readSessionSecret();
  if (derived?.secret !== secret) {
    derived = { secret, key: Buffer.from(hkdfSync('sha256', secret, '', 'share-link-otp-v1', 32)) };
  }
  return derived.key;
}

function macOf(tokenHash: string, code: string): string {
  return createHmac('sha256', macKey()).update(`${tokenHash}\u0000${code}`).digest('hex');
}

const verifiedKey = (tokenHash: string, sid: string): string => `${tokenHash}:${sid}`;

/** a•••@example.com — the first character of the local part, never more. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••@${email.slice(at + 1)}`;
}

/** Mint a fresh code for the link, REPLACING any pending one (it stops working at once). */
export async function issueCode(tokenHash: string, tenantId: string, now = Date.now()): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  await codes.put({ tokenHash, tenantId, codeMac: macOf(tokenHash, code), expiresAt, attempts: 0, deadAt: expiresAt });
  return code;
}

export type CodeCheck = 'ok' | 'miss' | 'locked' | 'none';

/**
 * Check a code. `ok` consumes it (compare-and-swap delete, so a code is single-use
 * even under two concurrent verifies); a miss counts one attempt under CAS; the
 * MAX_ATTEMPTS-th miss deletes the code and answers `locked`. An expired or absent
 * code is `none`. The comparison is constant-time.
 */
export async function checkCode(tokenHash: string, code: string, now = Date.now()): Promise<CodeCheck> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await codes.get(tokenHash);
    if (!row || Date.parse(row.expiresAt) <= now) return 'none';
    const want = Buffer.from(row.codeMac, 'hex');
    const got = Buffer.from(macOf(tokenHash, /^\d{6}$/.test(code) ? code : ''), 'hex');
    if (want.length === got.length && timingSafeEqual(want, got)) {
      // Single use: only the reader that still sees this exact row may consume it.
      const consumed: CodeRow = { ...row, codeMac: '', expiresAt: new Date(0).toISOString(), deadAt: new Date(now).toISOString() };
      if (await codes.compareAndSwap(row, consumed)) return 'ok';
      continue;
    }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const spent: CodeRow = { ...row, attempts, codeMac: '', expiresAt: new Date(0).toISOString(), deadAt: new Date(now).toISOString() };
      if (await codes.compareAndSwap(row, spent)) return 'locked';
      continue;
    }
    if (await codes.compareAndSwap(row, { ...row, attempts })) return 'miss';
  }
  return 'miss'; // persistent contention: count it as a miss, never as a pass
}

export async function markVerified(tokenHash: string, tenantId: string, sid: string, sessionHours: number, now = Date.now()): Promise<void> {
  const expiresAt = new Date(now + sessionHours * 3_600_000).toISOString();
  await verified.put({ key: verifiedKey(tokenHash, sid), tokenHash, tenantId, sid, expiresAt, deadAt: expiresAt });
}

/** The gate's read: has this browser session verified this link, and is it still in its window? */
export async function isVerified(tokenHash: string, sid: string | undefined, now = Date.now()): Promise<boolean> {
  if (!sid) return false;
  const row = await verified.get(verifiedKey(tokenHash, sid));
  return Boolean(row && Date.parse(row.expiresAt) > now);
}

/** Revocation, deletion and erasure: drop the pending code and every verified session. */
export async function clearVerification(tokenHash: string): Promise<void> {
  await codes.delete(tokenHash);
  for (const row of await verified.listByPrefix(`${tokenHash}:`)) await verified.delete(row.key);
}

export async function __resetVerificationStoreForTest(): Promise<void> {
  for (const r of await codes.list()) await codes.delete(r.tokenHash);
  for (const r of await verified.list()) await verified.delete(r.key);
}
