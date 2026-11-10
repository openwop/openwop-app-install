/**
 * ADR 1043 (CHAN-P1) — the device relay's lifecycle state beside `relay_devices`.
 *
 * Four small host-ext durable collections, each keyed by one device and carrying
 * its tenant (so tenant teardown purges them):
 *
 *  - `messaging:relay-activation` — who registered the device, the account id
 *    they gave, and how many wrong activation codes it has seen (D3 lockout).
 *    Deleted at activation, at lockout's re-register and at revoke.
 *  - `messaging:relay-token-grace` — the previous token's hash for 10 minutes
 *    after a rotation (D1), and a revoked token's hash until it would have
 *    expired (so the relay hears `device_revoked`), keyed by that hash.
 *  - `messaging:relay-presence` — the last heartbeat and whether the sweep has
 *    marked the device offline (D3 offline marking).
 *  - `messaging:relay-egress-attempts` — how many times the device reported a
 *    transient failure for one egress (D1 ack semantics, dead-letter at 5).
 *
 * None of these needs a schema migration (ADR 1043 Alternatives).
 */
import { DurableCollection } from '../host/hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { subjectKeyForms } from '../host/subjectErasureRedaction.js';
import type { RelayChannel } from './types.js';

const log = createLogger('messaging.relayLifecycle');

export const ACTIVATION_MAX_FAILURES = 5;
export const TOKEN_GRACE_MS = 10 * 60 * 1000;
export const EGRESS_MAX_ATTEMPTS = 5;
/** Three missed 30 s heartbeats. */
export const OFFLINE_AFTER_MS = 90 * 1000;
const SWEEP_CAP = 500;
const STALE_REGISTRATION_MS = 24 * 60 * 60 * 1000;

// ── activation (D3) ─────────────────────────────────────────────────────────

export interface RelayActivationRow {
  relayId: string;
  tenantId: string;
  registeredBy?: string;
  accountId?: string;
  /** Wrong codes per CALLER (ADR 1043 M2): one caller can never lock out another. */
  failuresBy?: Record<string, number>;
  /** @deprecated pre-M2 rows: a device-wide count. Read as the legacy caller's. */
  failures?: number;
  locked?: boolean;
  createdAt: string;
}

const activations = new DurableCollection<RelayActivationRow>('messaging:relay-activation', (r) => r.relayId, undefined, (r) => r.tenantId);

export async function recordRegistration(input: { relayId: string; tenantId: string; registeredBy?: string; accountId?: string }): Promise<void> {
  await activations.put({
    relayId: input.relayId, tenantId: input.tenantId,
    ...(input.registeredBy ? { registeredBy: input.registeredBy } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    failuresBy: {}, createdAt: new Date().toISOString(),
  });
}

export const getRegistration = (relayId: string): Promise<RelayActivationRow | null> => activations.get(relayId);

/** How many wrong codes this caller has sent for this device. */
export function activationFailuresOf(row: RelayActivationRow | null, callerKey: string): number {
  return row?.failuresBy?.[callerKey] ?? 0;
}

/**
 * Count one wrong code for (device, caller) with a CAS, so two concurrent guesses
 * both count. Returns that caller's count; the caller is locked at the maximum.
 */
export async function recordActivationFailure(relayId: string, tenantId: string, callerKey: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const cur = await activations.get(relayId);
    const base: RelayActivationRow = cur ?? { relayId, tenantId, failuresBy: {}, createdAt: new Date().toISOString() };
    const count = (base.failuresBy?.[callerKey] ?? 0) + 1;
    const next: RelayActivationRow = { ...base, failuresBy: { ...(base.failuresBy ?? {}), [callerKey]: count } };
    if (await activations.compareAndSwap(cur, next)) return count;
  }
  return ACTIVATION_MAX_FAILURES; // contention this high is itself a guessing attack
}

export const clearRegistration = (relayId: string): Promise<boolean> => activations.delete(relayId);

// ── token grace (D1) ────────────────────────────────────────────────────────

interface TokenGraceRow { tokenHash: string; relayId: string; tenantId: string; validUntil: string }

const grace = new DurableCollection<TokenGraceRow>('messaging:relay-token-grace', (g) => g.tokenHash, undefined, (g) => g.tenantId);

export async function recordTokenGrace(tokenHash: string, relayId: string, tenantId: string, validUntil: string): Promise<void> {
  await grace.put({ tokenHash, relayId, tenantId, validUntil });
}

/** The relay a previous token still names, while its grace lasts. */
export async function relayForGraceToken(tokenHash: string, now: number = Date.now()): Promise<string | null> {
  const row = await grace.get(tokenHash);
  if (!row) return null;
  if (Date.parse(row.validUntil) < now) {
    await grace.delete(tokenHash).catch(() => undefined);
    return null;
  }
  return row.relayId;
}

// ── presence (D3) ───────────────────────────────────────────────────────────

export interface RelayPresenceRow { relayId: string; tenantId: string; channel: RelayChannel; lastHeartbeatAt: string; offlineSince?: string }

const presence = new DurableCollection<RelayPresenceRow>('messaging:relay-presence', (p) => p.relayId, undefined, (p) => p.tenantId);

/** Record a heartbeat. Returns true when the device was marked offline before (it is back). */
export async function recordHeartbeat(relayId: string, tenantId: string, channel: RelayChannel, at: string): Promise<boolean> {
  const cur = await presence.get(relayId);
  await presence.put({ relayId, tenantId, channel, lastHeartbeatAt: at });
  return !!cur?.offlineSince;
}

export const getPresence = (relayId: string): Promise<RelayPresenceRow | null> => presence.get(relayId);

export type Presence = 'online' | 'offline' | 'never';

/**
 * The ONE presence answer for a device (ADR 1043 D3): a revoked or not-yet-active
 * device is offline; else the presence row, falling back to the device row's own
 * heartbeat for a device that last heartbeated before presence rows existed.
 */
export function relayPresenceOf(
  device: { status: string; lastHeartbeatAt?: string },
  row: RelayPresenceRow | null,
  now: number = Date.now(),
): Presence {
  if (device.status !== 'active') return device.lastHeartbeatAt || row ? 'offline' : 'never';
  if (row) return presenceOf(row, now);
  if (!device.lastHeartbeatAt) return 'never';
  return now - Date.parse(device.lastHeartbeatAt) > OFFLINE_AFTER_MS ? 'offline' : 'online';
}

export function presenceOf(row: RelayPresenceRow | null, now: number = Date.now()): Presence {
  if (!row) return 'never';
  if (row.offlineSince) return 'offline';
  return now - Date.parse(row.lastHeartbeatAt) > OFFLINE_AFTER_MS ? 'offline' : 'online';
}

/**
 * Mark silent devices offline, once each (bounded, fail-contained). `onOffline`
 * writes the delivery-log row. Also drops registration rows nobody activated
 * within a day.
 */
export async function sweepRelayPresence(
  onOffline: (row: RelayPresenceRow) => Promise<void>,
  now: number = Date.now(),
): Promise<number> {
  let marked = 0;
  let rows: RelayPresenceRow[];
  try { rows = await presence.list(); } catch { return 0; }
  for (const row of rows) {
    if (marked >= SWEEP_CAP) break;
    if (row.offlineSince) continue;
    const last = Date.parse(row.lastHeartbeatAt);
    if (!Number.isFinite(last) || now - last <= OFFLINE_AFTER_MS) continue;
    const next: RelayPresenceRow = { ...row, offlineSince: new Date(now).toISOString() };
    try {
      if (!(await presence.compareAndSwap(row, next))) continue; // a heartbeat landed, or another instance marked it
      marked += 1;
      await onOffline(next).catch(() => undefined);
    } catch { /* next tick */ }
  }
  try {
    let dropped = 0;
    for (const g of await grace.list()) {
      if (dropped >= SWEEP_CAP) break;
      if (Date.parse(g.validUntil) < now && (await grace.delete(g.tokenHash))) dropped += 1;
    }
  } catch { /* next tick */ }
  try {
    let dropped = 0;
    for (const r of await activations.list()) {
      if (dropped >= SWEEP_CAP) break;
      const at = Date.parse(r.createdAt);
      if (Number.isFinite(at) && now - at > STALE_REGISTRATION_MS && (await activations.delete(r.relayId))) dropped += 1;
    }
  } catch { /* next tick */ }
  if (marked > 0) log.info('relay presence sweep', { marked });
  return marked;
}

// ── egress attempts (D1) ────────────────────────────────────────────────────

interface EgressAttemptRow { egressId: string; relayId: string; tenantId: string; attempts: number; lastError?: string }

const attempts = new DurableCollection<EgressAttemptRow>('messaging:relay-egress-attempts', (a) => a.egressId, undefined, (a) => a.tenantId);

/** Count one transient failure; returns the new count. */
export async function recordEgressAttempt(egressId: string, relayId: string, tenantId: string, error: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const cur = await attempts.get(egressId);
    const next: EgressAttemptRow = { egressId, relayId, tenantId, attempts: (cur?.attempts ?? 0) + 1, lastError: error };
    if (await attempts.compareAndSwap(cur, next)) return next.attempts;
  }
  return EGRESS_MAX_ATTEMPTS;
}

export async function egressAttempts(egressId: string): Promise<number> {
  return (await attempts.get(egressId))?.attempts ?? 0;
}

export const clearEgressAttempts = (egressId: string): Promise<boolean> => attempts.delete(egressId);

// ── revoke (D3) ─────────────────────────────────────────────────────────────

/** Remove every lifecycle row for a revoked device. */
export async function purgeRelayLifecycle(relayId: string, tenantId: string): Promise<void> {
  await activations.delete(relayId).catch(() => undefined);
  await presence.delete(relayId).catch(() => undefined);
  for (const g of await grace.listForTenantIndexed(tenantId).catch(() => [] as TokenGraceRow[])) {
    if (g.relayId === relayId) await grace.delete(g.tokenHash).catch(() => undefined);
  }
  for (const a of await attempts.listForTenantIndexed(tenantId).catch(() => [] as EgressAttemptRow[])) {
    if (a.relayId === relayId) await attempts.delete(a.egressId).catch(() => undefined);
  }
}

/**
 * Subject erasure (ADR 0464): a registration names the person who registered
 * the device and the account id they gave. Called from `eraseRelayOwnerSubject`.
 */
export async function eraseRelayRegistrationSubject(tenantId: string, subjectKey: string): Promise<number> {
  const forms = subjectKeyForms(subjectKey).forms;
  let n = 0;
  for (const r of await activations.listForTenantIndexed(tenantId)) {
    if ((r.registeredBy && forms.has(r.registeredBy)) || (r.accountId && r.accountId === subjectKey)) {
      await activations.delete(r.relayId);
      n += 1;
    }
  }
  return n;
}
