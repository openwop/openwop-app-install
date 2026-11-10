/**
 * ADR 1042 D7 — the person a relay device belongs to.
 *
 * A device's messages land in its owner's main-chat conversations, and its
 * turns run as that owner. `relay_devices` has no owner column, so the owner is
 * recorded beside it at ACTIVATION (ADR 1043 D3), from the AUTHENTICATED caller
 * (never the request body), who must be the person who registered it. A device
 * activated with no signed-in user (an operator key) has no owner, and its
 * conversation-mode messages are dropped (fail empty).
 */
import { DurableCollection, hostExtStorage } from '../host/hostExtPersistence.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../host/subjectErasure.js';
import { subjectKeyForms } from '../host/subjectErasureRedaction.js';
import { eraseRelayRegistrationSubject } from './relayLifecycle.js';
import { deleteRelayInboundClaims } from './inboundClaims.js';

interface RelayOwner { relayId: string; tenantId: string; ownerUserId: string; ownerPersonalTenant?: string; ownerAccountId?: string; recordedAt: string }

const owners = new DurableCollection<RelayOwner>('messaging:relay-owner', (o) => o.relayId, undefined, (o) => o.tenantId);

export async function recordRelayOwner(relayId: string, tenantId: string, ownerUserId: string, ownerPersonalTenant?: string, ownerAccountId?: string): Promise<void> {
  await owners.put({
    relayId, tenantId, ownerUserId,
    ...(ownerPersonalTenant ? { ownerPersonalTenant } : {}),
    ...(ownerAccountId ? { ownerAccountId } : {}),
    recordedAt: new Date().toISOString(),
  });
}

/** The device's owner, only when the row is for the same tenant as the device. */
export async function getRelayOwner(relayId: string, tenantId: string): Promise<string | null> {
  return (await getRelayOwnerRecord(relayId, tenantId))?.ownerUserId ?? null;
}

/** The owner plus their own personal workspace (the presence check needs both, M4). */
export async function getRelayOwnerRecord(relayId: string, tenantId: string): Promise<{ ownerUserId: string; ownerPersonalTenant?: string; ownerAccountId?: string } | null> {
  const o = await owners.get(relayId);
  if (!o || o.tenantId !== tenantId) return null;
  return {
    ownerUserId: o.ownerUserId,
    ...(o.ownerPersonalTenant ? { ownerPersonalTenant: o.ownerPersonalTenant } : {}),
    ...(o.ownerAccountId ? { ownerAccountId: o.ownerAccountId } : {}),
  };
}

/** ADR 1043 D3 — the owner changes the self lane's account id. False when there is no owner row. */
export async function setRelayOwnerAccountId(relayId: string, tenantId: string, accountId: string | undefined): Promise<boolean> {
  const o = await owners.get(relayId);
  if (!o || o.tenantId !== tenantId) return false;
  const next: RelayOwner = { ...o };
  if (accountId) next.ownerAccountId = accountId; else delete next.ownerAccountId;
  await owners.put(next);
  return true;
}

export async function deleteRelayOwner(relayId: string): Promise<void> {
  await owners.delete(relayId);
}

/**
 * ADR 1042 D8 — subject erasure (ADR 0464): an erased owner's device rows are
 * DELETED. The device then has no owner, so its conversation-mode messages are
 * dropped (fail empty) instead of running as a person who asked to be forgotten.
 * ADR 1043 RELAY-LOG-RETENTION-1: the device's `messaging_delivery_log` rows too,
 * and the inbound dedup claims of the owner's devices or of the key as a contact.
 */
export async function eraseRelayOwnerSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const forms = subjectKeyForms(subjectKey).forms;
  let rowsTouched = 0;
  const owned: string[] = [];
  for (const o of await owners.listForTenantIndexed(tenantId)) {
    if (!forms.has(o.ownerUserId)) continue;
    owned.push(o.relayId);
    // ADR 1043 RELAY-LOG-RETENTION-1 — the device's delivery log goes with its owner,
    // and BEFORE the owner row: that row is the only record of whose device it was,
    // so this is the one place the owner leg can live without depending on eraser
    // order. (`eraseRelayDeliveryLogSubject` owns the other leg: the contact id.)
    rowsTouched += await hostExtStorage().deleteDeliveryLogForRelay(tenantId, o.relayId);
    await owners.delete(o.relayId);
    rowsTouched += 1;
  }
  // ADR 1043 RELAY-LOG-RETENTION-1 — the inbound dedup claims (`messaging:inbound-claim`,
  // each keyed by a conversation id). This eraser is the ONE eraser for that store:
  // the owner's devices' claims, and the claims whose conversation id EQUALS the key.
  rowsTouched += await deleteRelayInboundClaims(tenantId, { relayIds: owned, conversationId: subjectKey });
  // ADR 1043 — a registration not yet activated names who registered it.
  rowsTouched += await eraseRelayRegistrationSubject(tenantId, subjectKey);
  return { rowsTouched };
}

/** Called from `host/hostSubjectErasers.ts` (rows are written with the feature off too). */
export function registerRelayOwnerErasure(): void {
  registerSubjectEraser(eraseRelayOwnerSubject);
}
