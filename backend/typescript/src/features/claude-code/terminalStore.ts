/**
 * ADR 0785 P2 — durable state for terminal sessions and device presence.
 *
 * Bytes never touch these rows. A terminal session row records WHO opened a
 * terminal on WHICH device and whether it is still running; a presence row
 * records which instance currently holds a device's socket, so any instance can
 * route a control message to it and a stale holder can be told apart from a
 * live one.
 */
import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';

export type TerminalStatus = 'opening' | 'running' | 'exited';

export interface TerminalSessionRecord {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  /** The human who opened it — the only viewer allowed in v1 (ADR 0785 D4 item 4). */
  subject: string;
  status: TerminalStatus;
  createdAt: string;
  updatedAt: string;
  exitCode?: number | null;
  /** Shown as the tab title. Never the launch prompt (which may hold private text). */
  title: string;
}

export interface PresenceRecord {
  deviceId: string;
  tenantId: string;
  instanceId: string;
  connectedAt: string;
  lastSeenAt: string;
}

/** A device is online while its holder refreshed presence within this window. */
export const PRESENCE_STALE_MS = 90_000;

const sessions = new DurableCollection<TerminalSessionRecord>('claude-code:terminal', (s) => s.sessionId, undefined, (s) => s.tenantId);
const presence = new DurableCollection<PresenceRecord>('claude-code:presence', (p) => p.deviceId, undefined, (p) => p.tenantId);

export const newSessionId = (): string => `cct_${randomBytes(12).toString('base64url')}`;

export async function createTerminalSession(input: Omit<TerminalSessionRecord, 'sessionId' | 'createdAt' | 'updatedAt' | 'status'>): Promise<TerminalSessionRecord> {
  const now = new Date().toISOString();
  const rec: TerminalSessionRecord = { ...input, sessionId: newSessionId(), status: 'opening', createdAt: now, updatedAt: now };
  await sessions.put(rec);
  return rec;
}

export const getTerminalSession = (sessionId: string): Promise<TerminalSessionRecord | null> => sessions.get(sessionId);

/** CAS-guarded status move; returns false when the row changed underneath (or is gone). */
export async function setTerminalStatus(sessionId: string, status: TerminalStatus, exitCode?: number | null): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cur = await sessions.get(sessionId);
    if (!cur) return false;
    if (cur.status === 'exited') return false; // terminal is terminal
    const next: TerminalSessionRecord = { ...cur, status, updatedAt: new Date().toISOString(), ...(exitCode !== undefined ? { exitCode } : {}) };
    if (await sessions.compareAndSwap(cur, next)) return true;
  }
  return false;
}

export async function listTerminalSessions(tenantId: string, subject: string): Promise<TerminalSessionRecord[]> {
  return (await sessions.listForTenantIndexed(tenantId))
    .filter((s) => s.subject === subject)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function markPresent(deviceId: string, tenantId: string, instanceId: string, connectedAt?: string): Promise<void> {
  const now = new Date().toISOString();
  await presence.put({ deviceId, tenantId, instanceId, connectedAt: connectedAt ?? now, lastSeenAt: now });
}

/** Clear presence only if THIS instance still holds it (a reconnect elsewhere wins). */
export async function clearPresence(deviceId: string, instanceId: string): Promise<void> {
  const cur = await presence.get(deviceId);
  if (cur && cur.instanceId === instanceId) await presence.compareAndSwap(cur, { ...cur, lastSeenAt: new Date(0).toISOString() });
}

export async function isDeviceOnline(deviceId: string, now = Date.now()): Promise<boolean> {
  const p = await presence.get(deviceId);
  return Boolean(p && now - Date.parse(p.lastSeenAt) < PRESENCE_STALE_MS);
}

/** DSAR: the subject's terminal sessions in this tenant. Presence rows name a device, not a person, and are dropped with the device. */
export async function eraseTerminalRows(tenantId: string, forms: ReadonlySet<string>, deviceIds: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (const s of await sessions.listForTenantIndexed(tenantId)) {
    if (forms.has(s.subject)) { await sessions.delete(s.sessionId); n += 1; }
  }
  for (const id of deviceIds) await presence.delete(id);
  return n;
}
