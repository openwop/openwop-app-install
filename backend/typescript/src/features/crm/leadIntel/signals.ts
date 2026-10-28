/**
 * ADR 0954 D1 — the closed, code-owned lead signal catalog and its readers.
 *
 * A scoring model may name only these signals (an unknown one is a 422 at write
 * time). Each signal names the reader that produces its RAW count, so the score
 * stays reproducible from its inputs. v1 holds the signals that already have an
 * honest reader in this codebase; the ADR's list (form submits, email engagement,
 * bookings) is added one reader at a time, additively.
 *
 * ADR 0954 P4 — `qualifier.<criterionId>` names one of the SAME model's
 * qualification criteria. Its raw value is read from the accepted assessment the
 * grade is computed with (`grading.ts`), never from the visitor: an enum answer
 * counts 1 when it is one of the signal's `values`, a range answer counts its
 * value. The model validator requires the criterion to exist.
 */
import { sessionsForContact } from '../../analytics/identityLinkService.js';
import { eventsForVisitors } from '../../cdp/visitorEventIndex.js';
import { listOrders } from '../../commerce/commerceService.js';
import { contactPropensity } from '../propensityService.js';
import type { Contact } from '../contactsService.js';

export const SIGNAL_CATALOG = {
  'funnel.view': { label: 'Funnel step views' },
  'funnel.completion': { label: 'Funnel steps completed' },
  'commerce.paid-order': { label: 'Paid orders' },
  'crm.propensity': { label: 'Engagement propensity (0–10)' },
} as const;

export type CatalogSignalId = keyof typeof SIGNAL_CATALOG;
export type QualifierSignalId = `qualifier.${string}`;
export type SignalId = CatalogSignalId | QualifierSignalId;
export const SIGNAL_IDS = Object.keys(SIGNAL_CATALOG) as CatalogSignalId[];
/** Same shape as a criterion id (`model.ts` CRITERION_ID). */
const QUALIFIER_SIGNAL = /^qualifier\.[a-z0-9][a-z0-9_.-]{0,39}$/;
export const isQualifierSignal = (v: unknown): v is QualifierSignalId => typeof v === 'string' && QUALIFIER_SIGNAL.test(v);
export const isSignalId = (v: unknown): v is SignalId => typeof v === 'string' && (Object.hasOwn(SIGNAL_CATALOG, v) || QUALIFIER_SIGNAL.test(v));

const FUNNEL_TYPES = new Set(['funnel.step_viewed', 'funnel.step_completed']);

export interface SignalInputs {
  /** Raw count per requested signal. */
  raw: Partial<Record<SignalId, number>>;
  /** Sessions linked to the contact (for the explanation). */
  linkedSessions: number;
  /** True when a capped read means a count is a lower bound. */
  truncated: boolean;
}

/**
 * Read the raw inputs for `signals` for one contact. Funnel events come from the
 * per-visitor index (one bounded read per linked session, never a tenant scan);
 * paid orders need the client org (absent ⇒ 0, as before).
 */
export async function readSignals(
  tenantId: string,
  contact: Pick<Contact, 'contactId'> & Partial<Contact>,
  signals: ReadonlySet<SignalId>,
  orgId?: string,
): Promise<SignalInputs> {
  const raw: Partial<Record<SignalId, number>> = {};
  let truncated = false;
  let linkedSessions = 0;
  if (signals.has('funnel.view') || signals.has('funnel.completion')) {
    const sessions = await sessionsForContact(tenantId, contact.contactId);
    linkedSessions = new Set(sessions).size;
    const out = linkedSessions > 0 ? await eventsForVisitors(tenantId, sessions, FUNNEL_TYPES) : { events: [], truncated: false };
    truncated ||= out.truncated;
    raw['funnel.view'] = out.events.filter((e) => e.eventType === 'funnel.step_viewed').length;
    raw['funnel.completion'] = out.events.filter((e) => e.eventType === 'funnel.step_completed').length;
  }
  if (signals.has('commerce.paid-order')) {
    raw['commerce.paid-order'] = orgId
      ? (await listOrders(tenantId, orgId)).filter((o) => o.contactId === contact.contactId && o.status !== 'canceled' && o.status !== 'pending').length
      : 0;
  }
  if (signals.has('crm.propensity')) {
    raw['crm.propensity'] = contact.updatedAt && contact.stage ? contactPropensity(contact as Contact) : 0;
  }
  return { raw, linkedSessions, truncated };
}
