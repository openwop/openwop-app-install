/**
 * ADR 0955 D3 — which client a Twilio SMS number sends for. `{tenant, number} → {orgId?,
 * connectionId}`, admin-set, never read from a request.
 *
 * Two readers: the inbound `twilio-sms` observer (a STOP to client A's number is scoped to
 * client A's sender) and the SMS exit guard (`host/smsAdapter.ts`: a send from client A's
 * number is checked against client A's rows). It is NOT the ADR 0175 connection pairing,
 * which is one reply channel per connection; a Twilio account carries many numbers, one
 * per client. It is tied to the connection so it cannot drift from it: the connection must
 * be this tenant's, an org-scoped connection fixes the client, and a revoked connection
 * drops its numbers (`dropSmsSendersForConnection`).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { getConnection } from '../connections/connectionsService.js';
import { getOrg } from '../../host/accessControlService.js';
import { normalizeChannelAddress } from './suppressionService.js';

export interface SmsSenderBinding {
  /** `${tenantId}::${number}` */
  key: string;
  tenantId: string;
  /** E.164. */
  number: string;
  /** The client this number sends for. Absent ⇒ the workspace's own sender. */
  orgId?: string;
  connectionId: string;
  boundBy: string;
  boundAt: string;
}

const bindings = new DurableCollection<SmsSenderBinding>('crm:sms-sender', (b) => b.key, undefined, (b) => b.tenantId);
const keyOf = (tenantId: string, number: string): string => `${tenantId}::${number}`;

/** The binding for a number in this tenant, or null (also for a number that is not E.164). */
export async function getSmsSender(tenantId: string, rawNumber: string): Promise<SmsSenderBinding | null> {
  const number = normalizeChannelAddress('sms', rawNumber);
  if (!number) return null;
  const row = await bindings.get(keyOf(tenantId, number));
  return row && row.tenantId === tenantId ? row : null;
}

export async function listSmsSenders(tenantId: string): Promise<SmsSenderBinding[]> {
  return (await bindings.listForTenantIndexed(tenantId)).filter((b) => b.tenantId === tenantId).sort((a, b) => a.number.localeCompare(b.number));
}

export async function setSmsSender(input: { tenantId: string; number: string; orgId?: string; connectionId: string; boundBy: string }): Promise<SmsSenderBinding> {
  const number = normalizeChannelAddress('sms', input.number);
  if (!number) throw new OpenwopError('validation_error', 'The sender number must be E.164 (+ and country code).', 400, { field: 'number' });
  const connectionId = cleanString(input.connectionId, 160);
  const connection = connectionId ? await getConnection(input.tenantId, connectionId) : null;
  if (!connection) throw new OpenwopError('not_found', 'Connection not found.', 404, { field: 'connectionId' });
  if (connection.provider !== 'twilio') throw new OpenwopError('validation_error', 'SMS numbers bind to a Twilio connection.', 400, { field: 'connectionId', reason: 'not_twilio' });
  const orgId = cleanString(input.orgId, 160) || undefined;
  if (orgId) {
    const org = await getOrg(orgId);
    if (!org || org.tenantId !== input.tenantId) throw new OpenwopError('not_found', 'Organization not found.', 404, { field: 'orgId' });
  }
  if (connection.orgId && connection.orgId !== orgId) {
    throw new OpenwopError('validation_error', 'This connection belongs to one client; bind its numbers to that client.', 400, { field: 'orgId', reason: 'connection_org_mismatch' });
  }
  const row: SmsSenderBinding = { key: keyOf(input.tenantId, number), tenantId: input.tenantId, number, ...(orgId ? { orgId } : {}), connectionId, boundBy: input.boundBy, boundAt: new Date().toISOString() };
  await bindings.put(row);
  return row;
}

export async function removeSmsSender(tenantId: string, rawNumber: string): Promise<boolean> {
  const row = await getSmsSender(tenantId, rawNumber);
  return row ? bindings.delete(row.key) : false;
}

/** A revoked connection drops every number bound through it. */
export async function dropSmsSendersForConnection(tenantId: string, connectionId: string): Promise<number> {
  let n = 0;
  for (const b of await listSmsSenders(tenantId)) {
    if (b.connectionId === connectionId && (await bindings.delete(b.key))) n += 1;
  }
  return n;
}
