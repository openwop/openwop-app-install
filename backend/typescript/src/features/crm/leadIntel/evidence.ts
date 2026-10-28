/**
 * ADR 0954 D4 (P4) — the evidence a lead assessment may cite.
 *
 * One reader, used twice: by the `lead-evidence` node (what the assessor reads)
 * and by `recordAssessment` (a cited ref must STILL resolve). Every item carries
 * a stable ref the assessment cites:
 *  - `contact-field` — `contact:<field>` for the qualification-relevant fields
 *    (stage, company, title, lead source). No email, phone or address: they
 *    qualify nothing and would put contact PII in front of a model for no reason;
 *  - `activity` — `activity:<activityId>`, the client's timeline for the lead,
 *    newest first, at most MAX_ACTIVITIES, bodies cut to MAX_TEXT;
 *  - `form-field` — `stated:<criterionId>`, what the visitor told the chat widget
 *    (`statedAnswers.ts`).
 * Transcript turns are not offered: no conversation is linked to a contact today.
 */
import { createHash } from 'node:crypto';
import { getContact } from '../contactsService.js';
import { listActivities } from '../crmEntitiesService.js';
import { getLeadProfile } from './leadStore.js';
import { getStatedAnswers } from './statedAnswers.js';

export type EvidenceKind = 'transcript-turn' | 'form-field' | 'contact-field' | 'activity';
export interface EvidenceItem { kind: EvidenceKind; ref: string; label: string; text: string; at?: string; fingerprint: string }

export const MAX_ACTIVITIES = 50;
const MAX_TEXT = 500;
const cut = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** The lead's evidence, or null when the contact is not this client's lead. */
export async function readLeadEvidence(tenantId: string, orgId: string, contactId: string): Promise<EvidenceItem[] | null> {
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  const contact = await getContact(contactId);
  if (!profile || !contact || contact.tenantId !== tenantId || contact.mergedInto) return null;
  const items: Array<Omit<EvidenceItem, 'fingerprint'>> = [];
  const field = (name: string, label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) items.push({ kind: 'contact-field', ref: `contact:${name}`, label, text: cut(value.trim()) });
  };
  field('stage', 'Stage', contact.stage);
  field('company', 'Company', contact.company);
  field('title', 'Job title', contact.title);
  field('source', 'Lead source', profile.source);
  for (const a of await getStatedAnswers(tenantId, contactId)) {
    // Unverified: anyone who typed this contact's email into the website chat.
    items.push({ kind: 'form-field', ref: `stated:${a.submissionId}:${a.criterionId}`, label: `Unverified visitor submission ${a.submissionId.slice(0, 12)} (${a.criterionId})`, text: cut(a.value), at: a.at });
  }
  const acts = (await listActivities(tenantId, orgId, { contactId }))
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0))
    .slice(0, MAX_ACTIVITIES);
  for (const a of acts) items.push({ kind: 'activity', ref: `activity:${a.activityId}`, label: a.kind, text: cut(a.body ?? ''), at: a.createdAt });
  return items.map((item) => ({ ...item, fingerprint: createHash('sha256').update(JSON.stringify(item)).digest('hex') }));
}
