/**
 * CRM feature client (host-extension, non-normative). Wraps
 * /host/openwop-app/crm/*. The surface 404s when the CRM toggle is off — the
 * page gates on useFeatureAccess('crm') so it never calls a disabled surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { CrmRequestError } from './crmRequestError.js';

export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

export interface Contact {
  contactId: string;
  tenantId: string;
  name: string;
  email?: string;
  company?: string;
  stage: ContactStage;
  /** Opaque owning-subject id (ADR 0008 amendment). */
  owner?: string;
  /** CRM-2 (ADR 0383) — first-class attributes. `phone` is READ-ONLY (derived from the phone
   *  identifier); write it via the `phone` input on create/update, which upserts the identifier. */
  title?: string;
  address?: string;
  leadSource?: string;
  phone?: string;
  /** Denormalized last-triage stamp (B3a) — the run is the provenance SSoT. */
  lastTriage?: { variant: string | null; runId: string; at: string };
  /** Tenant-scoped custom fields (ADR 0213 §2). Defined on `/crm/fields`
   *  (`ContactFieldsPage`) and set from the contact form + the per-contact
   *  "Edit fields" modal; segments can filter on `customFields.<key>`.
   *  (CRM-UX-7: for a long time this comment said "not yet editable from this
   *  page's contact form" — so an AI agent could write a field a human could
   *  neither define nor edit, and the CDP console rendered values read-only.) */
  customFields?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface TriageResult {
  runId: string;
  variant: string | null;
  bindings: unknown;
  workflowId: string;
}

/** Saved segments (ADR 0211 §2, contacts-only v1) — evaluated at read, never
 *  materialized. v1 UI only ever authors a single `stage eq <value>` filter
 *  (see `CrmPage.tsx`'s "Save as segment" mini-form) but a segment created
 *  elsewhere (API/agent) may carry a richer filter set. */
export type SegmentOp = 'eq' | 'contains' | 'exists';
export interface SegmentFilter {
  field: string;
  op: SegmentOp;
  value?: string;
}
export interface Segment {
  segmentId: string;
  name: string;
  filters: SegmentFilter[];
  createdAt: string;
  updatedAt: string;
}

const base = `${config.baseUrl}/host/openwop-app/crm`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body?.message ?? '';
    } catch {
      /* non-JSON */
    }
    // CRM-UX-14 — carry the status so the UI can say WHAT KIND of failure in
    // the user's language instead of handing over the wire string.
    throw new CrmRequestError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function listContacts(): Promise<Contact[]> {
  const res = await fetch(`${base}/contacts`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ contacts: Contact[] }>(res, 'listContacts')).contacts;
}

export async function createContact(input: { name: string; email?: string; company?: string; stage?: ContactStage; title?: string; address?: string; leadSource?: string; phone?: string; customFields?: CustomFieldValues }): Promise<Contact> {
  const res = await fetch(`${base}/contacts`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Contact>(res, 'createContact');
}

/** PATCH one contact. The backend has accepted this all along (routes.ts
 *  `PATCH /crm/contacts/:id` — CC-SP-1: the console just never called it);
 *  `email: null` clears. `customFields` REPLACES the whole map (the server
 *  re-validates every value against the tenant's defs), so always send the
 *  complete set, never a partial patch of it. */
export async function updateContactFields(contactId: string, patch: { email?: string | null; customFields?: CustomFieldValues }): Promise<Contact> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Contact>(res, 'updateContactFields');
}

// ── Contact custom-field DEFINITIONS (ADR 0213 §2) — CRM-UX-7 ───────────────
// `GET/POST /crm/fields` + `DELETE /crm/fields/:defId` shipped with ZERO
// frontend consumers. `ContactFieldsPage.tsx` is the missing one. These defs are
// TENANT-scoped (no orgId) — deliberately, so a contact field can never be
// mistaken for an org's field list.

export type ContactFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference';
/** Mirrors the server's `FIELD_TYPES` (`entities/fieldDefs.ts`). The seam has
 *  grown a `media` kind for the entities engine; CRM's vocabulary deliberately
 *  stays these six and the server rejects the rest. */
export const CONTACT_FIELD_TYPES: readonly ContactFieldType[] = ['string', 'number', 'boolean', 'date', 'enum', 'reference'];
export type RefEntityType = 'company' | 'deal' | 'contact';
export const REF_ENTITY_TYPES: readonly RefEntityType[] = ['company', 'deal', 'contact'];
/** Server caps (`entities/shared.ts` MAX + `buildFieldSpec`). */
export const CONTACT_FIELD_MAX = { keys: 50, label: 120, options: 24 } as const;

export type CustomFieldValues = Record<string, string | number | boolean>;

export interface ContactFieldDef {
  defId: string;
  key: string;
  label: string;
  type: ContactFieldType;
  required: boolean;
  /** `enum` only — the value MUST be one of these. */
  options?: string[];
  /** `reference` only — the id must exist as this entity type in the tenant. */
  refEntityType?: RefEntityType;
  createdAt: string;
}

export async function listContactFields(): Promise<ContactFieldDef[]> {
  const res = await fetch(`${base}/fields`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ fields: ContactFieldDef[] }>(res, 'listContactFields')).fields;
}

export async function createContactField(input: {
  key: string;
  label: string;
  type: ContactFieldType;
  required?: boolean;
  options?: string[];
  refEntityType?: RefEntityType;
}): Promise<ContactFieldDef> {
  const res = await fetch(`${base}/fields`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<ContactFieldDef>(res, 'createContactField');
}

export async function deleteContactField(defId: string): Promise<void> {
  const res = await fetch(`${base}/fields/${encodeURIComponent(defId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new CrmRequestError(`deleteContactField returned ${res.status}`, res.status);
}

export async function deleteContact(contactId: string): Promise<void> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new CrmRequestError(`deleteContact returned ${res.status}`, res.status);
}

export async function triageContact(contactId: string): Promise<TriageResult> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}/triage`, fetchOpts({
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  }));
  return asJson<TriageResult>(res, 'triageContact');
}

/** Explainable lead score (ADR 0297 D3) — computed on read; every part returned
 *  so the number carries its own derivation. Fetched ON DEMAND per contact (the
 *  compute walks the funnel-event stream), never fanned out across the list. */
export interface LeadScore {
  contactId: string;
  score: number;
  parts: { linkedSessions: number; funnelViews: number; funnelCompletions: number; paidOrders: number };
  weights: { view: number; completion: number; paidOrder: number };
}

export async function getContactLeadScore(contactId: string): Promise<LeadScore> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}/score`, fetchOpts({ headers: authedHeaders() }));
  return asJson<LeadScore>(res, 'getContactLeadScore');
}

export async function listSegments(): Promise<Segment[]> {
  const res = await fetch(`${base}/segments`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ segments: Segment[] }>(res, 'listSegments')).segments;
}

export async function createSegment(input: { name: string; filters: SegmentFilter[] }): Promise<Segment> {
  const res = await fetch(`${base}/segments`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Segment>(res, 'createSegment');
}

export async function deleteSegment(segmentId: string): Promise<void> {
  const res = await fetch(`${base}/segments/${encodeURIComponent(segmentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new CrmRequestError(`deleteSegment returned ${res.status}`, res.status);
}

export async function listSegmentMembers(segmentId: string): Promise<Contact[]> {
  const res = await fetch(`${base}/segments/${encodeURIComponent(segmentId)}/members`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ members: Contact[] }>(res, 'listSegmentMembers')).members;
}
