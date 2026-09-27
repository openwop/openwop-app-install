/**
 * WhatsApp enforcement-awareness health surface (ADR 0394 Phase 3).
 *
 * Meta does NOT pre-approve businesses — compliance is contractual with
 * POST-HOC enforcement via a graduated ladder: quality-rating drop →
 * messaging-limit tier throttle → warning → temporary block → PERMANENT
 * removal. The operator's defense is awareness, so this surface reads the
 * tenant's WhatsApp sender health from the BSP (Twilio Senders API) and
 * raises a host event when the rating degrades or the sender is blocked.
 *
 * Tolerant-by-design: BSP payload fields beyond the documented core are
 * passed through as `raw` summary fields, never invented — a provider shape
 * drift degrades to `quality: 'unknown'`, not a 500.
 */
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { brokeredFetch, type BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { getPairing } from '../connections/messagingOutbound.js';
import { getConnection } from '../connections/connectionsService.js';
import { getAttestation } from './compliance.js';
import { normalizeWaNumber } from './whatsappService.js';

const log = createLogger('features.whatsapp.health');

export type WaQuality = 'high' | 'medium' | 'low' | 'unknown';

export interface WaSenderHealth {
  senderNumber: string | null;
  /** BSP sender registration status (e.g. ONLINE / OFFLINE / PENDING), verbatim-lowercased. */
  status: string | null;
  quality: WaQuality;
  /** The messaging-limit tier when the BSP exposes one (e.g. 1k/10k/100k/unlimited). */
  messagingLimit: string | null;
}

export interface WaHealth {
  bound: boolean;
  attested: boolean;
  sender: WaSenderHealth | null;
  /** The enforcement ladder, stated so the operator panel can render it. */
  enforcementLadder: readonly string[];
  fetchedAt: string;
}

export const ENFORCEMENT_LADDER = [
  'quality rating drops (high → medium → low)',
  'messaging-limit tier throttled',
  'warning from Meta',
  'temporary block',
  'permanent removal from the WhatsApp Business Platform',
] as const;

function qualityOf(v: unknown): WaQuality {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'unknown';
}

/**
 * Read the bound sender's health from the Twilio WhatsApp Senders API
 * (`messaging.twilio.com/v2/Channels/Senders`, basic auth — same brokered
 * credential as sends). Returns nulls, never throws, when unbound or the BSP
 * read fails (the panel renders honesty, not a 500).
 */
export async function readWhatsAppHealth(deps: BrokeredEgressDeps, connectionId: string): Promise<WaHealth> {
  // Tenant ownership first (the pairing store is keyed by connectionId alone —
  // without this, another tenant's sender number/health would be readable).
  if (!(await getConnection(deps.tenantId, connectionId))) {
    return { bound: false, attested: (await getAttestation(deps.tenantId)) !== null, sender: null, enforcementLadder: ENFORCEMENT_LADDER, fetchedAt: new Date().toISOString() };
  }
  const [pairing, attestation] = await Promise.all([getPairing(connectionId), getAttestation(deps.tenantId)]);
  const senderNumber = pairing && pairing.provider === 'whatsapp-twilio' ? normalizeWaNumber(pairing.channelId) : null;
  const base: WaHealth = {
    bound: senderNumber !== null,
    attested: attestation !== null,
    sender: null,
    enforcementLadder: ENFORCEMENT_LADDER,
    fetchedAt: new Date().toISOString(),
  };
  if (!senderNumber) return base;

  const out = await brokeredFetch(deps, {
    provider: 'twilio',
    url: `https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50`,
    method: 'GET',
    authScheme: 'basic',
    extraHeaders: { accept: 'application/json' },
  });
  if (out.outcome !== 'sent' || out.res.status < 200 || out.res.status >= 300) {
    log.info('whatsapp_health_read_failed', { tenantId: deps.tenantId, outcome: out.outcome, status: out.outcome === 'sent' ? out.res.status : null });
    return { ...base, sender: { senderNumber, status: null, quality: 'unknown', messagingLimit: null } };
  }
  let json: { senders?: unknown[] };
  try {
    json = (await out.res.json()) as typeof json;
  } catch {
    return { ...base, sender: { senderNumber, status: null, quality: 'unknown', messagingLimit: null } };
  }
  const rows = Array.isArray(json.senders) ? (json.senders as Record<string, unknown>[]) : [];
  // GRADE-CODE 2026-07-17 — never fall back to an arbitrary first sender: an
  // unmatched number renders quality `unknown` honestly, not a neighbor's.
  const mine = rows.find((r) => typeof r.sender_id === 'string' && r.sender_id.includes(senderNumber));
  const props = (mine?.properties ?? {}) as Record<string, unknown>;
  const sender: WaSenderHealth = {
    senderNumber,
    status: typeof mine?.status === 'string' ? mine.status.toLowerCase() : null,
    quality: qualityOf(props.quality_rating ?? (mine as Record<string, unknown> | undefined)?.quality_rating),
    messagingLimit: typeof props.messaging_limit === 'string' ? props.messaging_limit : null,
  };

  // Enforcement-ladder awareness: a degraded rating or a non-online sender
  // raises an operator alert through the ADR 0208 host-event seam.
  if (sender.quality === 'low' || (sender.status !== null && sender.status !== 'online')) {
    log.warn('whatsapp_health_degraded', { tenantId: deps.tenantId, quality: sender.quality, status: sender.status });
    await emitHostEvent({
      type: 'openwop-app.whatsapp.health-degraded',
      tenantId: deps.tenantId,
      payload: { connectionId, quality: sender.quality, status: sender.status, messagingLimit: sender.messagingLimit },
    });
  }
  return { ...base, sender };
}
