/**
 * ADR 1136 P2a — which browser a person has attached, durably (P2 entry
 * criterion 1: a session step on one Cloud Run instance must find a browser
 * attached on another).
 *
 * One row per tenant and person. It names the paired device and the executor
 * the companion announced. It is written only by the device socket's
 * `browser-attach` handler, from the socket's VERIFIED identity (release-manager
 * condition 1); the frame body cannot name a device or a person. A newer
 * attach overwrites the row, so an older executor reads as replaced.
 *
 * Whether the device is online at all is the claude-code presence row
 * (`isDeviceOnline`), which the socket's heartbeat renews and which re-verifies
 * the key each beat. This row holds no liveness of its own.
 *
 * Erasure: the row names a person and holds no audit value, so it is deleted.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';

export interface BrowserPresence {
  tenantId: string;
  subject: string;
  deviceId: string;
  executorId: string;
  protocolVersion: number;
  attachedAt: string;
}

const keyOf = (tenantId: string, subject: string): string => `${tenantId}:${subject}`;

const presence = new DurableCollection<BrowserPresence>(
  'computer-use:browser-presence',
  (p) => keyOf(p.tenantId, p.subject),
  undefined,
  (p) => p.tenantId,
);

export async function recordBrowserAttach(row: BrowserPresence): Promise<void> {
  await presence.put(row);
}

/** Clear only if this executor is still the attached one. */
export async function recordBrowserDetach(tenantId: string, subject: string, deviceId: string, executorId: string): Promise<void> {
  const cur = await presence.get(keyOf(tenantId, subject));
  if (cur && cur.deviceId === deviceId && cur.executorId === executorId) await presence.delete(keyOf(tenantId, subject));
}

export async function browserPresenceFor(tenantId: string, subject: string): Promise<BrowserPresence | null> {
  return (await presence.get(keyOf(tenantId, subject))) ?? null;
}

/** DSAR: delete the rows whose person is one of `forms`. */
export async function eraseBrowserPresence(tenantId: string, forms: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (const p of await presence.listForTenantIndexed(tenantId)) {
    if (!forms.has(p.subject)) continue;
    await presence.delete(keyOf(p.tenantId, p.subject));
    n += 1;
  }
  return n;
}
