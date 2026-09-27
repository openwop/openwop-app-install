/**
 * ADR 0546 D2/D3/D5 — everything the agent writes to a HUMAN is a draft.
 *
 * Interview replies (D2), prep sheets (D3) and warm intros (D5) are three
 * features with one rule between them, so they share a module and a store: the
 * agent produces text, a person decides whether it is ever sent.
 *
 * ## There is no send path, and that is a structural claim
 *
 * D2 is emphatic: an interview reply is "never sent. Not under a grant, not on
 * Tier A, not ever." This module therefore has no transport import, no webhook,
 * no mail client — you cannot send from here because there is nothing here that
 * sends. The test asserts it over the module's own source with comments
 * stripped, so the guarantee cannot be satisfied by prose alone.
 *
 * That is not inconsistent with auto-apply. Applying is a bounded, reversible,
 * low-variance act against a form; replying to a person who is deciding whether
 * to hire you is none of those. ADR 0541's tiering was always about who owns the
 * surface, and here the surface is a human being.
 *
 * ## Untrusted content informs, never instructs
 *
 * An interview invite arrives from outside. Its body is EVIDENCE the draft may
 * quote and reason about; it is never an instruction. `fenceUntrusted` wraps it
 * the way ADR 0542 D3 requires, and the fencing is applied here — at the point
 * the text enters the system — rather than left to each prompt to remember.
 *
 * ## Generated once
 *
 * A prep sheet is keyed by `(tenant, deal, kind)` with no timestamp, so a re-run
 * collides with the existing row instead of attaching a second sheet. The marker
 * lives on the KEY, not in a prose prefix a model could vary.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

/** What a draft is for. Closed: a new kind is a decision, not a string. */
export type DraftKind = 'interview-reply' | 'prep-sheet' | 'warm-intro';

export interface Draft {
  tenantId: string;
  dealId: string;
  kind: DraftKind;
  subjectId: string;
  /** The proposed text. NEVER sent by anything in this module. */
  body: string;
  /** Quoted source material, already fenced. Present for interview replies. */
  groundedIn?: string;
  createdAt: string;
  /** Set when a human approved it. Approval is a record, NOT a send. */
  approvedAt?: string;
  approvedBy?: string;
}

/** Subject-keyed for the same reason as `followUps` — see `JS-LIFE-1`. */
const key = (tenantId: string, subjectId: string, dealId: string, kind: DraftKind): string =>
  `${tenantId}:${subjectId}:${dealId}:${kind}`;

export const drafts = new DurableCollection<Draft>(
  'job-search:draft',
  (d) => key(d.tenantId, d.subjectId, d.dealId, d.kind),
  undefined,
  (d) => d.tenantId,
);

declarePiiFields('job-search.draft', ['body', 'groundedIn']);

export async function eraseSubjectDrafts(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await drafts.listByPrefix(`${tenantId}:`)) {
    if (!forms.has(row.subjectId)) continue;
    await drafts.delete(key(row.tenantId, row.subjectId, row.dealId, row.kind));
  }
}
registerSubjectEraser(eraseSubjectDrafts);

/**
 * Fence third-party text.
 *
 * The invite body is evidence, not instruction. Fencing it at the point of entry
 * — rather than in each prompt that happens to use it — means a future caller
 * cannot forget, and the fence markers are stripped from the input first so a
 * hostile body cannot close the fence and write outside it.
 */
export function fenceUntrusted(text: string): string {
  const cleaned = text.replace(/<\/?UNTRUSTED>/gi, '');
  return `<UNTRUSTED>\n${cleaned}\n</UNTRUSTED>`;
}

export type DraftRefusal =
  /** A draft of this kind already exists for this deal. */
  | 'already-exists'
  /** Nothing to draft from. */
  | 'incomplete';

/**
 * Record a draft. Insert-if-absent: one per (deal, kind), ever.
 *
 * Returns the EXISTING draft rather than an error when one is already there —
 * for a prep sheet the caller's intent ("this deal should have a sheet") is
 * already satisfied, and making that an error would push every caller to write
 * the same try/catch.
 */
export async function putDraft(input: {
  tenantId: string;
  dealId: string;
  kind: DraftKind;
  subjectId: string;
  body: string;
  /** Raw third-party text; fenced here, never stored bare. */
  untrustedSource?: string;
  now: number;
}): Promise<{ draft: Draft; created: boolean } | { refused: DraftRefusal }> {
  if (!input.tenantId || !input.dealId || !input.body.trim()) return { refused: 'incomplete' };

  const row: Draft = {
    tenantId: input.tenantId,
    dealId: input.dealId,
    kind: input.kind,
    subjectId: input.subjectId,
    body: input.body,
    ...(input.untrustedSource ? { groundedIn: fenceUntrusted(input.untrustedSource) } : {}),
    createdAt: new Date(input.now).toISOString(),
  };

  const won = await drafts.compareAndSwap(null, row);
  if (won) return { draft: row, created: true };
  const existing = await drafts.get(key(input.tenantId, input.subjectId, input.dealId, input.kind));
  return existing ? { draft: existing, created: false } : { refused: 'incomplete' };
}

export async function getDraft(tenantId: string, subjectId: string, dealId: string, kind: DraftKind): Promise<Draft | null> {
  return (await drafts.get(key(tenantId, subjectId, dealId, kind))) ?? null;
}

export async function listDrafts(tenantId: string, subjectId: string): Promise<Draft[]> {
  return drafts.listByPrefix(`${tenantId}:${subjectId}:`);
}

/**
 * Record that a human approved a draft.
 *
 * Approval is a RECORD, not a send. Nothing in this module transmits anything,
 * and this function deliberately returns the draft rather than a delivery
 * result — there is no delivery to report. What the user does with the approved
 * text is theirs.
 */
export async function approveDraft(
  tenantId: string,
  subjectId: string,
  dealId: string,
  kind: DraftKind,
  approvedBy: string,
  now: number,
): Promise<Draft | null> {
  const row = await drafts.get(key(tenantId, subjectId, dealId, kind));
  if (!row) return null;
  const next: Draft = { ...row, approvedAt: new Date(now).toISOString(), approvedBy };
  await drafts.put(next);
  return next;
}

// Retention. A follow-up completed two years ago and a draft for a job long
// since filled are both personal data kept for no reason (JS-DATA-2). Ages out
// by `createdAt` — the answer bank already had this and these did not.
registerRetentionPurger({
  feature: 'job-search:draft',
  // The seam calls purge(tenantId, CLASSIFICATION, cutoffIso). The previous
  // binding named the second slot `cutoffIso`, so every sweep compared
  // timestamps against the classification STRING — and every ISO date sorts
  // before 'confidential-pii'/'internal'/'public', so ONE sweep of ANY
  // classification would have deleted this store's every row for the tenant.
  // Gate on the store's own classification (declared PII) + the true cutoff.
  purge: async (tenantId, classification, cutoffIso) =>
    classification !== 'confidential-pii' ? 0 : purgeRowsByAge(
      'job-search:draft',
      await drafts.listForTenantIndexed(tenantId),
      tenantId,
      cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.createdAt, id: key(r.tenantId, r.subjectId, r.dealId, r.kind) }),
      (id) => drafts.delete(id),
    ),
});
