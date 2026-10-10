/**
 * ADR 0799 — sign the CLI in without copying a key (RFC 8628 in form).
 *
 *   CLI                      host                         person, signed in
 *   ───                      ────                         ─────────────────
 *   start ─────────────────▶ deviceCode + userCode
 *   shows userCode                                         types the userCode
 *                                                    ◀──── approve / deny
 *   poll(deviceCode) ──────▶ mints the key, ONCE ────────▶ (listed on the tab)
 *
 * The same shape as Claude Code device pairing (ADR 0785), for the same
 * reasons, and the same three properties:
 *
 *  - the key is minted at POLL, by a compare-and-swap that consumes the request,
 *    so the secret is never stored and can be collected exactly once;
 *  - the device code is the CLI's secret and is kept only as a hash;
 *  - the person TYPES the user code. No link carries it: a link that did would be
 *    a one-click lure (start a login, mail the victim the link).
 *
 * What it mints is an ordinary developer key with the CLI scopes and a short
 * life, owned by the person who approved, listed and revocable on the API keys
 * tab like any other.
 */
import { randomInt } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { OpenwopError } from '../../types.js';
import { SCOPES_SUPPORTED } from '../../host/protocolAuthorization.js';
import { getTenantKeyPolicy, issueApiKey, type ApiKeyPublic } from './apiKeyService.js';
import { keyMintPolicy } from './keyPolicy.js';
import { erasedSubjectIssued, registerSubjectErasedHandler, type ErasedSubject } from '../../host/delegatedSubject.js';

export const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;
export const CLI_LOGIN_POLL_INTERVAL_S = 3;
export const CLI_KEY_NAME_PREFIX = 'CLI: ';
/** What the CLI needs: every protocol scope, and the workspace pair the vendor floor asks of a key. */
export const CLI_LOGIN_SCOPES: readonly string[] = [...SCOPES_SUPPORTED, 'workspace:read', 'workspace:write'];
const DAY_MS = 86_400_000;

function cliKeyLifetimeDays(): number {
  const n = Number(process.env.OPENWOP_CLI_LOGIN_KEY_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

export interface CliLoginRecord {
  /** sha256 of the device code. */
  loginId: string;
  userCode: string;
  label: string;
  requestedFrom: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  createdAt: string;
  expiresAt: string;
  approvedBy?: string;
  tenantId?: string;
  decidedAt?: string;
  keyId?: string;
}

const logins = new DurableCollection<CliLoginRecord>('devkey:cli-login', (l) => l.loginId);
const userCodes = new DurableCollection<{ userCode: string; loginId: string; expiresAt: string }>('devkey:cli-login-usercode', (u) => u.userCode);

// NOT `hostGlobal`: an approved row carries the approver's tenant.
registerKvAgeOut({ id: 'devkey:cli-login', prefix: 'hostext:devkey:cli-login:', ttlDays: 1, timestampField: 'createdAt' });
registerKvAgeOut({ id: 'devkey:cli-login-usercode', prefix: 'hostext:devkey:cli-login-usercode:', ttlDays: 1, timestampField: 'expiresAt', hostGlobal: true });

// No vowels, no look-alikes: nothing a terminal font makes ambiguous, and no words.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const past = (iso: string, now = Date.now()): boolean => Date.parse(iso) <= now;

function mintUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function clean(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // Printable only: this text is shown to the person deciding.
  const s = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
  return s.length > 0 ? s : fallback;
}

export async function startCliLogin(input: { label?: unknown; requesterIp?: string }): Promise<{
  deviceCode: string; userCode: string; expiresIn: number; interval: number;
}> {
  const now = Date.now();
  const expiresAt = new Date(now + CLI_LOGIN_TTL_MS).toISOString();
  const { raw: deviceCode, hash: loginId } = mintToken('owcl');
  let userCode = '';
  for (let attempt = 0; attempt < 8 && !userCode; attempt += 1) {
    const candidate = mintUserCode();
    const row = { userCode: candidate, loginId, expiresAt };
    if (await userCodes.putIfAbsent(row)) { userCode = candidate; break; }
    const held = await userCodes.get(candidate);
    if (held && past(held.expiresAt, now) && await userCodes.compareAndSwap(held, row)) userCode = candidate;
  }
  if (!userCode) throw new OpenwopError('internal_error', 'Could not allocate a sign-in code; try again.', 503, {});
  await logins.put({
    loginId,
    userCode,
    label: clean(input.label, 60, 'this machine'),
    requestedFrom: clean(input.requesterIp, 64, 'unknown'),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { deviceCode, userCode, expiresIn: Math.floor(CLI_LOGIN_TTL_MS / 1000), interval: CLI_LOGIN_POLL_INTERVAL_S };
}

async function liveByUserCode(rawUserCode: string): Promise<CliLoginRecord | null> {
  const idx = await userCodes.get(normalizeUserCode(rawUserCode));
  if (!idx) return null;
  const rec = await logins.get(idx.loginId);
  if (!rec || rec.userCode !== idx.userCode || past(rec.expiresAt)) return null;
  return rec;
}

/** What the person is shown before deciding. Never the device code or the login id. */
export async function getPendingCliLogin(userCode: string): Promise<Pick<CliLoginRecord, 'userCode' | 'label' | 'requestedFrom' | 'createdAt' | 'expiresAt'> | null> {
  const rec = await liveByUserCode(userCode);
  if (!rec || rec.status !== 'pending') return null;
  return { userCode: rec.userCode, label: rec.label, requestedFrom: rec.requestedFrom, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
}

const unknownCode = (): OpenwopError => new OpenwopError('not_found', 'That sign-in code is unknown or has expired.', 404, {});

export async function decideCliLogin(
  userCode: string,
  decision: { approve: true; subject: string; tenantId: string } | { approve: false },
): Promise<void> {
  const rec = await liveByUserCode(userCode);
  if (!rec || rec.status !== 'pending') throw unknownCode();
  const decidedAt = new Date().toISOString();
  const next: CliLoginRecord = decision.approve
    ? { ...rec, status: 'approved', approvedBy: decision.subject, tenantId: decision.tenantId, decidedAt }
    : { ...rec, status: 'denied', decidedAt };
  if (!(await logins.compareAndSwap(rec, next))) throw unknownCode(); // someone else decided first
}

export type CliLoginPoll =
  | { status: 'pending'; interval: number }
  | { status: 'denied' }
  | { status: 'failed'; message: string }
  | { status: 'approved'; token: string; key: ApiKeyPublic };

/**
 * ADR 0833 D7 — an approved-but-uncollected sign-in mints its key at POLL time
 * under `approvedBy`, so a deleted account's pending approvals are withdrawn
 * (approved → denied, a CAS so a racing poll either collects first — and its
 * key is revoked by the key handler — or sees `denied`).
 */
export async function withdrawCliLoginsApprovedBy(subject: ErasedSubject): Promise<number> {
  let n = 0;
  for (const rec of await logins.list()) {
    if (rec.status !== 'approved' || !erasedSubjectIssued(subject, rec.approvedBy, rec.tenantId)) continue;
    if (await logins.compareAndSwap(rec, { ...rec, status: 'denied' })) n += 1;
  }
  return n;
}
registerSubjectErasedHandler(async (subject) => { await withdrawCliLoginsApprovedBy(subject); });

/** `null` ⇒ unknown, expired, or already collected: the route's 404. */
export async function pollCliLogin(deviceCode: unknown): Promise<CliLoginPoll | null> {
  if (typeof deviceCode !== 'string' || !deviceCode.startsWith('owcl_')) return null;
  const rec = await logins.get(hashToken(deviceCode));
  if (!rec || past(rec.expiresAt)) return null;
  if (rec.status === 'pending') return { status: 'pending', interval: CLI_LOGIN_POLL_INTERVAL_S };
  if (rec.status === 'denied') return { status: 'denied' };
  if (rec.status !== 'approved' || !rec.approvedBy || !rec.tenantId) return null;

  // Claim BEFORE minting: two polls racing must not both receive a key.
  const claimed: CliLoginRecord = { ...rec, status: 'consumed' };
  if (!(await logins.compareAndSwap(rec, claimed))) return null;

  try {
    const tenantPolicy = await getTenantKeyPolicy(rec.tenantId);
    if (tenantPolicy.disabled) return { status: 'failed', message: 'API keys are turned off for this workspace.' };
    const cap = keyMintPolicy(tenantPolicy.maxLifetimeDays).maxLifetimeDays;
    const days = Math.min(cliKeyLifetimeDays(), cap);
    const issued = await issueApiKey({
      tenantId: rec.tenantId,
      name: `${CLI_KEY_NAME_PREFIX}${rec.label}`,
      createdBy: rec.approvedBy,
      scopes: [...CLI_LOGIN_SCOPES],
      expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
    });
    await logins.put({ ...claimed, keyId: issued.key.keyId });
    return { status: 'approved', token: issued.token, key: issued.key };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : 'The key could not be issued.' };
  }
}
