/**
 * WhatsApp settings client (ADR 1053 D10). The tenant-admin reads and writes
 * under /host/openwop-app/whatsapp/orgs/:orgId: the no-training attestation
 * (ADR 0394 P2), the WhatsApp-bound connections, sender health (P3) and recent
 * provider-reported delivery failures. Self-contained per ADR 0001.
 */
import { authedHeaders, config, fetchOpts } from '../../../client/config.js';

export interface Org { orgId: string; name: string }

export interface Attestation {
  attested: boolean;
  /** Whether the caller may record or revoke it (the server's own predicate). */
  canManage?: boolean;
  attestedBy?: string;
  attestedByName?: string;
  attestedAt?: string;
}

export type WaTransport = 'whatsapp-twilio' | 'whatsapp-cloud';
export type WaAxis = 'user' | 'org' | 'workspace';
export interface WaConnection {
  connectionId: string;
  displayName: string;
  transport: WaTransport;
  /** The business sender: an E.164 number (Twilio) or a Meta phone-number id (Cloud). */
  sender: string;
  axis: WaAxis;
  status: string;
  inbound: 'enabled' | 'disabled' | 'none';
}

export type WaQuality = 'high' | 'medium' | 'low' | 'unknown';
export interface WaHealth {
  bound: boolean;
  attested: boolean;
  sender: { senderNumber: string | null; status: string | null; quality: WaQuality; messagingLimit: string | null } | null;
  enforcementLadder: readonly string[];
  fetchedAt: string;
}

export interface WaDeliveryFailure {
  connectionId: string;
  providerSid: string;
  status: 'failed' | 'undelivered';
  errorCode: string | null;
  kind: 'session' | 'template';
  /** The last four digits only — the server never sends the number. */
  recipientLast4: string;
  at: string;
}

/** A refusal the UI can branch on by `status`/`code`, never by English text. */
export class WhatsAppApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let env: { error?: string; message?: string } = {};
    try { env = (await res.json()) as typeof env; } catch { /* non-JSON (a proxy page) */ }
    throw new WhatsAppApiError(env.message || `${ctx} returned ${res.status}`, env.error ?? 'unknown', res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/whatsapp/orgs/${encodeURIComponent(orgId)}`;
const get = async <T>(url: string, ctx: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ headers: authedHeaders() })), ctx);

export const listOrgs = async (): Promise<Org[]> => (await get<{ orgs: Org[] }>(`${root}/orgs`, 'listOrgs')).orgs;
export const getAttestation = (orgId: string): Promise<Attestation> => get<Attestation>(`${base(orgId)}/attestation`, 'getAttestation');
export const listWhatsAppConnections = async (orgId: string): Promise<WaConnection[]> =>
  (await get<{ connections: WaConnection[] }>(`${base(orgId)}/connections`, 'listWhatsAppConnections')).connections;
export const getHealth = (orgId: string, connectionId: string): Promise<WaHealth> =>
  get<WaHealth>(`${base(orgId)}/health?connectionId=${encodeURIComponent(connectionId)}`, 'getHealth');
export const listDeliveryFailures = async (orgId: string): Promise<WaDeliveryFailure[]> =>
  (await get<{ failures: WaDeliveryFailure[] }>(`${base(orgId)}/delivery-failures`, 'listDeliveryFailures')).failures;

export async function recordAttestation(orgId: string): Promise<Attestation> {
  const res = await fetch(`${base(orgId)}/attestation`, fetchOpts({
    method: 'PUT',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ confirmNoTraining: true }),
  }));
  return asJson<Attestation>(res, 'recordAttestation');
}

export async function revokeAttestation(orgId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/attestation`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson<void>(res, 'revokeAttestation');
}
