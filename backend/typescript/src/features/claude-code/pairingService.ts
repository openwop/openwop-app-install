/**
 * ADR 0785 D3 — pairing a Claude Code companion to a user, by device code.
 *
 * The flow is RFC 8628 in form (not an OpenWOP wire claim):
 *   1. the companion calls `start` (unauthenticated) → a secret `deviceCode` it
 *      keeps, and a short `userCode` it shows the user;
 *   2. the user, signed in, opens the approval page, reads the ADR 0785 D2
 *      consent, and approves the `userCode`;
 *   3. the companion polls with its `deviceCode`; on the first poll after
 *      approval the host MINTS an ordinary ADR 0270 developer key and returns it
 *      exactly once.
 *
 * Invariants (each test-pinned in `test/claude-code-pairing.test.ts`):
 *   - The authority a device holds IS a developer key — no second token store.
 *     The device row records who/when/what-consent; revoking a device revokes
 *     its key, and the key's own verifier is what refuses the next request.
 *   - No token is ever at rest: the key is minted at poll time, AFTER a CAS
 *     `approved → consumed` claim, so two racing polls cannot both mint.
 *   - Only a hash of the device code is stored; the pairing row is looked up by
 *     that hash, so a stored row cannot be replayed into a poll.
 *   - Every state change is a compare-and-swap on the row read (a legal-
 *     transition check alone only rejects a write it SEES).
 */
import { randomBytes, randomInt } from 'node:crypto';
// ADR 0448 D3 — bearer-shaped secrets are minted and hashed by the ONE host helper.
import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { erasedSubjectIssued, registerSubjectErasedHandler, type ErasedSubject } from '../../host/delegatedSubject.js';
import { eraseTerminalRows } from './terminalStore.js';
import { OpenwopError } from '../../types.js';
// ADR 0785 D3 — composes the ADR 0270 key service rather than minting its own
// tokens; the same cross-feature edge `entities` takes (developer-keys is core
// substrate, always-on per ADR 0434).
import { issueApiKey, listApiKeys, revokeApiKey } from '../developer-keys/apiKeyService.js';
import {
  CONSENT_VERSION,
  DEVICE_KEY_NAME_PREFIX,
  DEVICE_KEY_SCOPES,
  DEVICE_KEY_TTL_MS,
  PAIRING_POLL_INTERVAL_S,
  PAIRING_TTL_MS,
  consentHash,
} from './constants.js';

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface PairingRecord {
  /** sha256(deviceCode) — the row key. The device code itself is never stored. */
  pairingId: string;
  userCode: string;
  label: string;
  platform: string;
  /** The address the companion started from — shown to the approver so a request
   *  they did not start is recognisable (RFC 8628 §5.4 remote-phishing context).
   *  The row ages out after a day (`kvAgeOut` below). */
  requestedFrom: string;
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
  /** Set on approve: the canonical subject who approved, in which tenant, against which consent. */
  approvedBy?: string;
  tenantId?: string;
  consentHash?: string;
  /** ADR 0785 P3 — the approver's personal workspace and canonical durable user
   *  id, captured WHERE a request exists, so an MCP tool (which has none) can reach
   *  the same personal board the `/kanban/boards/personal` route resolves. */
  personalTenant?: string;
  ownerUserId?: string;
  decidedAt?: string;
  /** Set on consume: the device the mint produced. */
  deviceId?: string;
}

export interface DeviceRecord {
  deviceId: string;
  tenantId: string;
  /** The canonical subject who paired it — the RFC 0122 runner subject later (ADR 0785 D3). */
  subject: string;
  keyId: string;
  label: string;
  platform: string;
  createdAt: string;
  consentVersion: string;
  consentHash: string;
  revokedAt?: string;
  /** ADR 0785 P3 — see PairingRecord. Absent on devices paired before P3 (re-pair). */
  personalTenant?: string;
  ownerUserId?: string;
  /** ADR 0785 D7 — the owner's SEPARATE, per-device opt-in to workflow tasks (the
   *  `claude-code.task` step). Absent = off, which is every device until its owner
   *  turns it on: pairing consents to a terminal, not to unattended work. */
  workflowTasks?: { enabledAt: string; enabledBy: string };
}

export interface DeviceView extends Omit<DeviceRecord, 'keyId'> {
  /** Derived from the developer key — the authority — never stored twice. */
  status: 'active' | 'revoked' | 'expired';
  expiresAt?: string;
  lastUsedAt?: string;
}

const pairings = new DurableCollection<PairingRecord>('claude-code:pairing', (p) => p.pairingId);
const userCodes = new DurableCollection<{ userCode: string; pairingId: string; expiresAt: string }>(
  'claude-code:pairing-usercode',
  (u) => u.userCode,
);
const devices = new DurableCollection<DeviceRecord>('claude-code:device', (d) => d.deviceId, undefined, (d) => d.tenantId);

// Pairing rows live ten minutes by contract; their durable residue is bounded
// here rather than accumulating forever. A day is ample for any audit of a
// failed pairing, and a consumed row's outcome lives on in the device row.
registerKvAgeOut({ id: 'claude-code:pairing', prefix: 'hostext:claude-code:pairing:', ttlDays: 1, timestampField: 'createdAt' });
// A user-code index row belongs to no tenant by construction (it exists before
// anyone has approved, and names only a pairing hash).
registerKvAgeOut({ id: 'claude-code:pairing-usercode', prefix: 'hostext:claude-code:pairing-usercode:', ttlDays: 1, timestampField: 'expiresAt', hostGlobal: true });

const LABEL_MAX = 80;
const PLATFORM_MAX = 40;
/** RFC 8628 §6.1 — no vowels (no accidental words), no 0/O/1/I ambiguity. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export const hashDeviceCode = (deviceCode: string): string => hashToken(deviceCode);

const isExpired = (iso: string, now = Date.now()): boolean => Date.parse(iso) <= now;

function mintUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalise what a human types: case, spaces, a missing dash. */
export function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function clean(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // Printable, single-line: this string is shown on the approval page and the device list.
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return s || fallback;
}

export async function startPairing(input: { label?: unknown; platform?: unknown; requesterIp?: string }): Promise<{
  deviceCode: string; userCode: string; expiresIn: number; interval: number;
}> {
  const now = Date.now();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  const { raw: deviceCode, hash: pairingId } = mintToken('owdc');
  // A user code must be unique among LIVE pairings; claim it insert-only. An
  // expired holder is reclaimable (CAS against the exact row read).
  let userCode = '';
  for (let attempt = 0; attempt < 8 && !userCode; attempt += 1) {
    const candidate = mintUserCode();
    const row = { userCode: candidate, pairingId, expiresAt };
    if (await userCodes.putIfAbsent(row)) { userCode = candidate; break; }
    const held = await userCodes.get(candidate);
    if (held && isExpired(held.expiresAt, now) && await userCodes.compareAndSwap(held, row)) userCode = candidate;
  }
  if (!userCode) throw new OpenwopError('internal_error', 'Could not allocate a pairing code; try again.', 503, {});
  await pairings.put({
    pairingId,
    userCode,
    label: clean(input.label, LABEL_MAX, 'Claude Code device'),
    platform: clean(input.platform, PLATFORM_MAX, 'unknown'),
    requestedFrom: clean(input.requesterIp, 64, 'unknown'),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { deviceCode, userCode, expiresIn: Math.floor(PAIRING_TTL_MS / 1000), interval: PAIRING_POLL_INTERVAL_S };
}

/** The live pairing a user code points at, or null (unknown, expired, or reassigned). */
async function livePairingByUserCode(rawUserCode: string): Promise<PairingRecord | null> {
  const idx = await userCodes.get(normalizeUserCode(rawUserCode));
  if (!idx) return null;
  const rec = await pairings.get(idx.pairingId);
  if (!rec || rec.userCode !== idx.userCode || isExpired(rec.expiresAt)) return null;
  return rec;
}

/** What the approval page shows. Only a PENDING pairing is approvable; anything else is 404. */
export async function getPendingPairing(userCode: string): Promise<Pick<PairingRecord, 'userCode' | 'label' | 'platform' | 'requestedFrom' | 'createdAt' | 'expiresAt'> | null> {
  const rec = await livePairingByUserCode(userCode);
  if (!rec || rec.status !== 'pending') return null;
  return {
    userCode: rec.userCode, label: rec.label, platform: rec.platform,
    requestedFrom: rec.requestedFrom ?? 'unknown', createdAt: rec.createdAt, expiresAt: rec.expiresAt,
  };
}

/** ADR 0270's per-tenant ceiling on active keys (`apiKeyService` MAX.perTenant). */
const ACTIVE_KEYS_PER_TENANT = 100;

const notFound = (): OpenwopError =>
  new OpenwopError('not_found', 'That pairing code is unknown or has expired.', 404, {});

export async function decidePairing(
  userCode: string,
  decision: { approve: true; subject: string; tenantId: string; consentHash: unknown; personalTenant?: string; ownerUserId?: string } | { approve: false; subject: string },
): Promise<void> {
  const rec = await livePairingByUserCode(userCode);
  if (!rec || rec.status !== 'pending') throw notFound();
  const decidedAt = new Date().toISOString();
  let next: PairingRecord;
  if (decision.approve) {
    // ADR 0785 D2 lever 2 — an approval binds to the consent text the user saw.
    // A stale page (older text) is refused, never silently upgraded.
    if (decision.consentHash !== consentHash()) {
      throw new OpenwopError('conflict', 'The consent text has changed. Reload the page and review it again.', 409, { reason: 'consent_outdated' });
    }
    // Refuse HERE, where a person can read the reason, rather than let the mint
    // fail at poll time after the pairing is already consumed (code review #4).
    const active = (await listApiKeys(decision.tenantId, { callerSubject: decision.subject, isAdmin: true })).filter((k) => !k.revokedAt);
    if (active.length >= ACTIVE_KEYS_PER_TENANT) {
      throw new OpenwopError('conflict', `This workspace already has ${ACTIVE_KEYS_PER_TENANT} active API keys. Revoke one, then approve again.`, 409, { reason: 'key_limit' });
    }
    next = {
      ...rec, status: 'approved', approvedBy: decision.subject, tenantId: decision.tenantId, consentHash: consentHash(), decidedAt,
      ...(decision.personalTenant ? { personalTenant: decision.personalTenant } : {}),
      ...(decision.ownerUserId ? { ownerUserId: decision.ownerUserId } : {}),
    };
  } else {
    next = { ...rec, status: 'denied', decidedAt };
  }
  if (!(await pairings.compareAndSwap(rec, next))) throw notFound(); // someone else decided first
}

/**
 * ADR 0833 D7 — a pairing approved but not yet collected mints its device key
 * at POLL time under `approvedBy`; a deleted account's pending approvals are
 * withdrawn (CAS approved → denied), as the CLI-login lane does.
 */
export async function withdrawPairingsApprovedBy(subject: ErasedSubject): Promise<number> {
  let n = 0;
  for (const rec of await pairings.list()) {
    if (rec.status !== 'approved' || !erasedSubjectIssued(subject, rec.approvedBy, rec.tenantId)) continue;
    if (await pairings.compareAndSwap(rec, { ...rec, status: 'denied' })) n += 1;
  }
  return n;
}
registerSubjectErasedHandler(async (subject) => { await withdrawPairingsApprovedBy(subject); });

export type PollResult =
  | { status: 'pending'; interval: number }
  | { status: 'denied' }
  | { status: 'failed'; message: string }
  | { status: 'approved'; token: string; deviceId: string; tenantId: string; expiresAt: string };

/** Poll with the device code. Returns the key EXACTLY ONCE; unknown/expired/already-consumed ⇒ null (404). */
export async function pollPairing(deviceCode: unknown): Promise<PollResult | null> {
  if (typeof deviceCode !== 'string' || !deviceCode.startsWith('owdc_')) return null;
  const rec = await pairings.get(hashDeviceCode(deviceCode));
  if (!rec || isExpired(rec.expiresAt)) return null;
  if (rec.status === 'pending') return { status: 'pending', interval: PAIRING_POLL_INTERVAL_S };
  if (rec.status === 'denied') return { status: 'denied' };
  if (rec.status !== 'approved' || !rec.approvedBy || !rec.tenantId || !rec.consentHash) return null;

  // Claim BEFORE minting: of two racing polls exactly one wins the swap, so at
  // most one key exists per pairing. A crash after the claim strands the pairing
  // (the user pairs again) — never a second live key.
  const deviceId = `ccd_${randomBytes(9).toString('base64url')}`;
  const claimed: PairingRecord = { ...rec, status: 'consumed', deviceId };
  if (!(await pairings.compareAndSwap(rec, claimed))) return null;

  const expiresAt = new Date(Date.now() + DEVICE_KEY_TTL_MS).toISOString();
  let issued: Awaited<ReturnType<typeof issueApiKey>>;
  try {
    issued = await issueApiKey({
      tenantId: rec.tenantId,
      name: `${DEVICE_KEY_NAME_PREFIX}${rec.label}`,
      createdBy: rec.approvedBy,
      scopes: [...DEVICE_KEY_SCOPES],
      expiresAt,
    });
  } catch (err) {
    // The pairing stays consumed (never a second mint), but the companion is
    // TOLD, rather than polling into an unexplained expiry (code review #4).
    return { status: 'failed', message: err instanceof Error ? err.message : 'The device key could not be issued.' };
  }
  const { token, key } = issued;
  await devices.put({
    deviceId,
    tenantId: rec.tenantId,
    subject: rec.approvedBy,
    keyId: key.keyId,
    label: rec.label,
    platform: rec.platform,
    createdAt: new Date().toISOString(),
    consentVersion: CONSENT_VERSION,
    consentHash: rec.consentHash,
    ...(rec.personalTenant ? { personalTenant: rec.personalTenant } : {}),
    ...(rec.ownerUserId ? { ownerUserId: rec.ownerUserId } : {}),
  });
  return { status: 'approved', token, deviceId, tenantId: rec.tenantId, expiresAt };
}

/** The live device a developer key belongs to (the device socket's identity), or null. */
export async function deviceForKey(keyId: string, tenantId: string): Promise<DeviceRecord | null> {
  const found = (await devices.listForTenantIndexed(tenantId)).find((d) => d.keyId === keyId && !d.revokedAt);
  return found ?? null;
}

/** Every device a subject paired in this tenant (raw rows; callers filter revoked). */
export async function listDeviceRecordsForSubject(tenantId: string, subject: string): Promise<DeviceRecord[]> {
  return (await devices.listForTenantIndexed(tenantId)).filter((d) => d.subject === subject);
}

/** Devices whose approver's CANONICAL user id is `ownerUserId` (a board owner's key). */
export async function listDeviceRecordsForOwnerUser(tenantId: string, ownerUserId: string): Promise<DeviceRecord[]> {
  return (await devices.listForTenantIndexed(tenantId)).filter((d) => d.ownerUserId === ownerUserId);
}

/** One of the caller's live devices, or null (not theirs / revoked / wrong tenant). */
export async function ownedDevice(tenantId: string, deviceId: string, subject: string): Promise<DeviceRecord | null> {
  const d = await devices.get(deviceId);
  return d && d.tenantId === tenantId && d.subject === subject && !d.revokedAt ? d : null;
}

/** The caller's own paired devices in this tenant, with status DERIVED from each device's key. */
export async function listDevices(tenantId: string, subject: string): Promise<DeviceView[]> {
  const mine = (await devices.listForTenantIndexed(tenantId)).filter((d) => d.subject === subject);
  if (mine.length === 0) return [];
  const keys = new Map((await listApiKeys(tenantId, { callerSubject: subject, isAdmin: false })).map((k) => [k.keyId, k]));
  const now = Date.now();
  return mine
    .map(({ keyId, ...d }): DeviceView => {
      const key = keys.get(keyId);
      const status: DeviceView['status'] = !key || key.revokedAt || d.revokedAt
        ? 'revoked'
        : key.expiresAt && isExpired(key.expiresAt, now) ? 'expired' : 'active';
      return {
        ...d,
        status,
        ...(key?.expiresAt ? { expiresAt: key.expiresAt } : {}),
        ...(key?.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Turn workflow tasks on or off for one of the caller's own live devices. Not theirs /
 *  revoked / wrong tenant ⇒ null (404). CAS, so a concurrent revoke is never undone. */
export async function setWorkflowTasks(tenantId: string, deviceId: string, subject: string, enabled: boolean): Promise<DeviceRecord | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rec = await ownedDevice(tenantId, deviceId, subject);
    if (!rec) return null;
    const { workflowTasks: _drop, ...rest } = rec;
    const next: DeviceRecord = enabled ? { ...rest, workflowTasks: { enabledAt: new Date().toISOString(), enabledBy: subject } } : rest;
    if (await devices.compareAndSwap(rec, next)) return next;
  }
  throw new OpenwopError('conflict', 'The device changed while it was being updated. Try again.', 409, {});
}

/** Revoke one of the caller's devices. Not theirs / not in this tenant ⇒ false (404, no existence leak). */
export async function revokeDevice(tenantId: string, deviceId: string, subject: string): Promise<boolean> {
  const rec = await devices.get(deviceId);
  if (!rec || rec.tenantId !== tenantId || rec.subject !== subject) return false;
  // The key is the authority: revoking it is what makes the device's next request fail.
  await revokeApiKey(tenantId, rec.keyId, { callerSubject: subject, isAdmin: false });
  if (!rec.revokedAt) await devices.compareAndSwap(rec, { ...rec, revokedAt: new Date().toISOString() });
  return true;
}

/**
 * ADR 0464 — DSAR eraser for this feature's rows. Device rows are the subject's
 * own pairing history; pairing rows carry `approvedBy`. The keys themselves are
 * revoked here too, so an erased subject's companion stops authenticating on its
 * next request rather than holding a live credential for a deleted person.
 */
export async function eraseClaudeCodeSubject(tenantId: string, forms: ReadonlySet<string>): Promise<{ devices: number; pairings: number; terminals: number }> {
  let deviceCount = 0;
  const erasedDevices = new Set<string>();
  for (const d of await devices.listForTenantIndexed(tenantId)) {
    if (!forms.has(d.subject)) continue;
    await revokeApiKey(tenantId, d.keyId, { callerSubject: d.subject, isAdmin: false }).catch(() => false);
    await devices.delete(d.deviceId);
    erasedDevices.add(d.deviceId);
    deviceCount += 1;
  }
  const terminals = await eraseTerminalRows(tenantId, forms, erasedDevices);
  const { eraseTaskRows } = await import('./tasks.js');
  await eraseTaskRows(tenantId, forms);
  let pairingCount = 0;
  for (const p of await pairings.list()) {
    if (p.tenantId === tenantId && p.approvedBy && forms.has(p.approvedBy)) {
      await pairings.delete(p.pairingId);
      await userCodes.delete(p.userCode).catch(() => false);
      pairingCount += 1;
    }
  }
  return { devices: deviceCount, pairings: pairingCount, terminals };
}

/** The registered DSAR eraser (named, per the seam's WF-CONS-2 rule). */
export async function eraseClaudeCodeSubjectKey(tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return;
  await eraseClaudeCodeSubject(tenantId, subjectKeyForms(subjectKey).forms);
}

