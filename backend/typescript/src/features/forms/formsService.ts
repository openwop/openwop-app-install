/**
 * Forms feature service (host-extension, ADR 0017 + ADR 0330) — the app's
 * standalone capture primitive. Org-scoped form definitions + an append-only
 * submission log — append-only on the CAPTURE path (nothing a submit does ever
 * removes an earlier row); an authenticated operator may delete one row
 * (`deleteSubmission`) and retention may purge by age. Destination effects (e.g. CRM contact creation) are NOT
 * this module's concern: after a submission persists, registered submission
 * sinks (ADR 0330 §D1, `submissionSinks.ts`) run fail-soft — the integrator
 * feature registers its sink at boot, so forms imports no destination
 * feature. Backed by the durable host_ext_kv.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { fireFormDeleted } from '../../host/formLifecycle.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { runSubmissionSinks } from './submissionSinks.js';
import { formSubmissionCreated } from './emit.js';

const log = createLogger('forms.capture');

export type FieldType = 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox';
/** `number` was added when ADR 0516 adopted the wire's portable field kinds
 *  (`chat-card-packs.md:81`, RFC 0071 Phase 2). It was a REAL gap, not a
 *  completeness exercise: the shipped RSVP starter declared `type:"number"`,
 *  which did not exist, and the loader silently coerced it to `text` — the
 *  workaround was to force a guest COUNT into a bounded select. */
export const FIELD_TYPES: readonly FieldType[] = ['text', 'email', 'number', 'textarea', 'select', 'checkbox'];

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[]; // `select` only
  /** UX_UPGRADE-forms F-G1 — optional help text shown under the control on the
   *  public fill surface (wired through `ui/Field`'s `help` → `aria-describedby`).
   *  "Microcopy where users hesitate" is 2026 form practice and every comparable
   *  builder authors it per field. Bounded like any other authored string. */
  description?: string;
  /** F9 (round 3) — `number`-only authored constraints, the `options`-is-select-
   *  only precedent. Enforced at submit (server) AND mirrored client-side so a
   *  visitor is never told to retry something the server will always reject.
   *  `step` counts from `min` when authored, else from 0. */
  min?: number;
  max?: number;
  step?: number;
}

export type FormStatus = 'draft' | 'published';

/**
 * ADR 0246 (STRAT-PORTAL) — routes this form's submissions to a priority-matrix
 * intake list. This is the STRUCTURAL agent-write safety boundary: an anonymous
 * public submitter never picks the target list; an authenticated form owner
 * pre-authorizes exactly one list here (via `updateForm`). The bridge chain
 * reads `listId` from THIS binding, never from submission values. `listId` is
 * stored opaquely (forms stays priority-matrix-import-free); its org-ownership
 * is enforced at the write boundary by `submit-idea` (`expectedOrgId`). The
 * `*Field` keys map submission values onto the idea and MUST name real fields.
 */
export interface IntakeBinding {
  listId: string;
  titleField: string;
  requesterField?: string;
  notesField?: string;
}

export interface FormDef {
  formId: string;
  tenantId: string;
  orgId: string;
  title: string;
  status: FormStatus;
  fields: FormField[];
  createToContact: boolean;
  /** ADR 0338 §D1 — the key of a `checkbox` field that is an EXPLICIT email
   *  marketing opt-in; the email feature's consent sink acts only on `true`. */
  emailOptInField?: string;
  submitMessage?: string;
  intakeBinding?: IntakeBinding;
  /** ADR 0516 §Provenance — set ONLY when the form was instantiated from a
   *  `form-content` pack template. Absent means hand-authored: the two are
   *  otherwise indistinguishable, since instantiation COPIES the fields.
   *
   *  Stamped server-side from the pack registry, never from the request body —
   *  no route reads it off the wire, so a caller cannot claim an origin it does
   *  not have. Records the origin at the moment of creation; it is NOT a live
   *  link, and the user is free to edit the form away from the template
   *  afterwards.
   *
   *  `templateVersion` is OPTIONAL because it was added after the stamp itself
   *  (#2941 vs #2924). This is a JSON blob store with no migration, so rows
   *  written in between keep their three-key shape FOREVER — a required field
   *  here would be the type lying about data that already exists. Its absence
   *  is real information: "stamped before we recorded the template revision". */
  originTemplate?: { templateId: string; packName: string; packVersion: string; templateVersion?: string };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  submissionId: string;
  tenantId: string;
  orgId: string;
  formId: string;
  values: Record<string, string | number | boolean>;
  contactId?: string;
  error?: string;
  /** `sessionKey` (ADR 0226, additive): the visitor's analytics session key,
   *  when the submitting page supplied one — the form-submit identity-link input.
   *  `context` (ADR 0332, additive): OPAQUE embed-surface provenance (e.g. a
   *  funnel page passes funnelId/stepId/visitor) — bounded, string-only, and
   *  assigned no meaning by forms itself (the meta.utm posture). */
  meta: { referrer?: string; utm?: Record<string, string>; sessionKey?: string; context?: Record<string, string> };
  /** ADR 0584 (FORM-UX-1) — this submission tripped an abuse control and is
   *  QUARANTINED, not lost: it is stored, excluded from the sinks and the host
   *  event, and shown to the operator behind a "flagged" chip so a
   *  false-positive lead can be recovered by a human. Absent on a clean row.
   *
   *  The old posture answered `200 {ok:true}` and persisted NOTHING, so a real
   *  person whose browser extension filled the decoy was told "Thanks — your
   *  submission was received" over a lead that existed nowhere. The only trace
   *  was a WARN line no operator surface reads. */
  flagged?: 'honeypot' | 'guard';
  createdAt: string;
}

/** A fixed decoy field the public render asks the client to include (hidden). A
 *  non-empty value on submit ⇒ a bot ⇒ the submission is silently dropped. */
export const HONEYPOT_FIELD = '_hp_ref';
const MAX_FIELDS = 50;
/** Per-field help text (F-G1) — a sentence of guidance, not a paragraph. */
const MAX_DESCRIPTION = 300;
const MAX_FIELD_LEN = 5_000;
/** ADR 0516 Phase 2a — bounds on AUTHORED strings and option lists.
 *
 *  These sit here, on the shared create path, rather than in the form-content
 *  pack loader: the loader can only bound what a PACK ships, and a hand-typed
 *  10MB label is the same denial-of-service on the same public page. Bounding at
 *  the single choke point means pack input and typed input get identical
 *  treatment — which is the property that makes "instantiate through createForm"
 *  worth anything.
 *
 *  TRUNCATE, never throw — the `MAX_DESCRIPTION` precedent below. An existing
 *  form with an over-long label must keep saving; a hostile one must stop being
 *  unbounded. Throwing here would turn a cap into a migration. */
const MAX_LABEL = 1_000;
const MAX_TITLE = 200;
/** A country picker has ~195 entries and a currency picker ~180 — both ordinary
 *  form fields. The first draft of this cap was 100, which would have SILENTLY
 *  truncated a country select: a product regression wearing hardening's clothes.
 *  250 clears the real lists and still refuses the 100k-entry render bomb. */
const MAX_OPTIONS = 250;
const MAX_OPTION_LEN = 200;
/** The post-submit confirmation, rendered on the public page. Bounded like every
 *  other authored string — it was missed in the first pass. */
const MAX_SUBMIT_MESSAGE = 2_000;
const MAX_VALUES_CHARS = 20_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const forms = new DurableCollection<FormDef>('forms:def', (f) => f.formId, undefined, (f) => f.tenantId);
const submissions = new DurableCollection<Submission>('forms:submission', (s) => s.submissionId, undefined, (s) => s.tenantId);

// Grade-data FRMD-1 — submissions are captured third-party PII (a visitor's
// values carry name/email). Log-mask the value bag + retention-purge by age,
// the cdp/crm pattern. Purge ages on `createdAt`.
//
// CORRECTION (ADR 0584 / FORM-1). This block used to end: "DELIBERATELY NOT a
// `registerSubjectEraser` consumer — the crm precedent (contactsService.ts): a
// submission is a business record the tenant holds ABOUT someone else;
// retention (+ the CRM erasure path via the contact) is the honest lifecycle."
// Every leg of that sentence was false by the time it was read back:
//   (a) The CRM precedent it named was OVERTURNED as the CRM-2 defect —
//       `crm/erasure.ts` now registers an eraser AND a `SubjectKeyResolver`, so
//       the ADR 0381 seam delivers a resolved `contactId` to every registrant.
//   (b) The "CRM erasure path via the contact" never reached forms: erasing the
//       contact left the respondent's own name and email sitting in
//       `submission.values`, and `onCrmRecordDeleted` below strips only the
//       contactId POINTER — which makes the residual PII HARDER to find.
//   (c) The retention fallback is off on two independent default switches (the
//       sweep daemon needs `OPENWOP_RETENTION_SWEEP_ENABLED`, and the
//       `confidential-pii` window defaults to `null` = never purge).
// `features/forms/erasure.ts` now registers the eraser; the anonymize-don't-
// delete decision and the stores it deliberately does NOT touch are argued
// there, beside the registration, rather than asserted here.
declarePiiFields('forms.submission', ['values', 'meta']);
registerRetentionPurger({
  feature: 'forms',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const rows = await submissions.listForTenantIndexed(tenantId);
    // ADR 0584 §Correction — the counters are OCCUPANCY, so a purge must give
    // the budget back. Held by id because `purgeRowsByAge` hands the delete
    // callback an id, not the row, and the row is what says which bucket to
    // credit (`flaggedCount` vs `count`).
    const byId = new Map(rows.map((s) => [s.submissionId, s]));
    return purgeRowsByAge('forms:submission', rows, tenantId, cutoffIso,
      (s) => ({ tenantId: s.tenantId, updatedAt: s.createdAt, id: s.submissionId }),
      async (id) => {
        await submissions.delete(id);
        const row = byId.get(id);
        if (row) await adjustCount(row.formId, row.tenantId, row.flagged ? 'flaggedCount' : 'count', -1);
      });
  },
});

// FRMD-4 — a deleted CRM contact must not leave `submission.contactId`
// dangling: strip the pointer (the submission itself is forms-owned history
// and stays). Best-effort by seam contract.
onCrmRecordDeleted('forms-submission-contact-unlink', async ({ tenantId, entity, recordId }) => {
  if (entity !== 'contact') return;
  const rows = await submissions.listForTenantIndexed(tenantId);
  for (const s of rows) {
    if (s.contactId === recordId) {
      const next = { ...s };
      delete next.contactId;
      await submissions.put(next);
    }
  }
});

/** GC-FRM-7/FORMS-1 (grade pass 2026-07-10, architect-adjudicated) — the
 *  per-form submission counter: a POINT-LOOKUP abuse ceiling for the public
 *  anonymous write path (counting rows per submit would be the O(rows) scan
 *  class FORMS-2 killed).
 *
 *  ADR 0584 (FORM-4 half): the word "CAS" used to sit here over a plain
 *  read-modify-write. It is a real `compareAndSwap` with a bounded retry now,
 *  so the ceiling this counter defends cannot be walked past by concurrency.
 *
 *  `flaggedCount` / `droppedCount` are the FORM-UX-1 operator signal: how many
 *  submissions were quarantined by an abuse control, and how many were refused
 *  outright once the quarantine budget was full. A form silently losing every
 *  lead to a false-positive honeypot used to look identical to a form nobody
 *  submits; these two numbers are the difference.
 *
 *  ADR 0584 §Correction (FORM-BUDGET-1) — `count` and `flaggedCount` are
 *  OCCUPANCY counts: how many rows this form currently holds in each bucket.
 *  They shipped as LIFETIME tallies that only ever incremented, and nothing in
 *  `src/` decremented them — so the quarantine budget below expired
 *  PERMANENTLY once a form had ever accrued 1 000 trips (routine over months on
 *  a public page, and forceable in ~17 minutes from one IP at the default
 *  read budget). Every later trip took the drop path, which means the recovery
 *  promise the `Submission.flagged` docblock makes ("a false-positive lead can
 *  be recovered by a human") was true only for the first 1 000 trips in a
 *  form's life, and no surface said so. Occupancy makes the promise durable:
 *  the budget is what is HELD RIGHT NOW, and every path that removes a row —
 *  the retention purger above, `deleteSubmission` below — gives it back.
 *
 *  `droppedCount` stays a lifetime tally ON PURPOSE: it counts submissions
 *  that have no row at all, so there is nothing whose removal could credit it.
 *  It is a history of refusals, not an occupancy. */
interface SubmissionCount { formId: string; tenantId: string; count: number; flaggedCount?: number; droppedCount?: number }
const submissionCounts = new DurableCollection<SubmissionCount>('forms:subcount', (c) => c.formId, undefined, (c) => c.tenantId);
/** Hard cap per form — an abuse ceiling, refused honestly (429), recorded in
 *  the ADR 0330 addendum. Legit volume near this scale needs export/retention
 *  tooling, not silent growth. */
export const MAX_SUBMISSIONS_PER_FORM = 50_000;
/** ADR 0584 — the QUARANTINE budget, deliberately separate from the 50k lead
 *  ceiling above. Flagged rows are stored so a false positive is recoverable,
 *  but they must never be able to consume the budget real leads need: a bot
 *  flood fills this 1 000 and stops, while genuine capture keeps its full
 *  50 000. Past the budget a submit is refused HONESTLY (429) rather than
 *  answered with a thank-you — the whole point of this change.
 *
 *  §Correction (FORM-BUDGET-1): this is an OCCUPANCY budget — see
 *  `SubmissionCount`. As a lifetime tally it made the recovery promise expire
 *  permanently, which is the opposite of what a quarantine is for. */
export const MAX_FLAGGED_PER_FORM = 1_000;

export interface SubmissionStats { count: number; flaggedCount: number; droppedCount: number }


/** The operator-visible abuse numbers for one form (FORM-UX-1). */
export async function submissionStatsOf(formId: string): Promise<SubmissionStats> {
  const row = await submissionCounts.get(formId);
  return { count: row?.count ?? 0, flaggedCount: row?.flaggedCount ?? 0, droppedCount: row?.droppedCount ?? 0 };
}

/**
 * ADR 0584 (FORM-4) — move one counter field ATOMICALLY. A blind
 * `put({count: current + 1})` loses every concurrent increment but one, and
 * the drift grows with contention — precisely the load the ceiling exists to
 * stop. `compareAndSwap` against the row we read; on a lost race re-read and
 * retry, bounded. Exhausting the retries is LOGGED rather than silently
 * dropped: an undercounted ceiling is a security fact, not a rounding error.
 *
 * §Correction (FORM-BUDGET-1) — `delta` may be NEGATIVE, because the two row
 * counters are occupancy. Clamped at 0: a counter that could go negative would
 * hand out budget that no row ever paid for, which is the same class of lie in
 * the other direction.
 */
async function adjustCount(formId: string, tenantId: string, field: 'count' | 'flaggedCount' | 'droppedCount', delta = 1): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await submissionCounts.get(formId);
    // A decrement against a counter row that does not exist is a no-op, not a
    // row creation: there is no occupancy to give back.
    if (!current && delta < 0) return;
    const base: SubmissionCount = current ?? { formId, tenantId, count: 0 };
    const next: SubmissionCount = { ...base, [field]: Math.max(0, (base[field] ?? 0) + delta) };
    if (await submissionCounts.compareAndSwap(current, next)) return;
  }
  log.warn('submission_counter_contended', { tenantId, formId, field, delta });
}

/** Test-only — seed the counter so the cap path is testable without 50k rows. */
export async function __setSubmissionCountForTests(formId: string, tenantId: string, count: number, flaggedCount?: number): Promise<void> {
  const existing = await submissionCounts.get(formId);
  await submissionCounts.put({ ...(existing ?? {}), formId, tenantId, count, ...(flaggedCount !== undefined ? { flaggedCount } : {}) });
}

function sanitizeFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) throw new OpenwopError('validation_error', '`fields` MUST be an array.', 400, { field: 'fields' });
  if (input.length > MAX_FIELDS) throw new OpenwopError('validation_error', `A form may have at most ${MAX_FIELDS} fields.`, 400, {});
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) throw new OpenwopError('validation_error', `fields[${i}].key MUST match [a-zA-Z0-9_]{1,64}.`, 400, {});
    if (key === HONEYPOT_FIELD) throw new OpenwopError('validation_error', `fields[${i}].key is reserved.`, 400, { field: key });
    if (seen.has(key)) throw new OpenwopError('validation_error', `Duplicate field key: ${key}.`, 400, { field: key });
    seen.add(key);
    const type = FIELD_TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : 'text';
    // Trim + bound. Unbounded before ADR 0516 Phase 2a: a label is rendered on the
    // PUBLIC fill page, so its length is a resource question, not a taste one.
    const rawLabel = typeof f.label === 'string' ? f.label.trim() : '';
    const label = rawLabel ? rawLabel.slice(0, MAX_LABEL) : key;
    const field: FormField = { key, label, type, required: f.required === true };
    // Options are authored strings on a public page too — bound the COUNT and each
    // entry. A select with 100k options is a render-time denial of service that no
    // amount of field-count capping catches.
    if (type === 'select') {
      field.options = Array.isArray(f.options)
        ? f.options
            .filter((o): o is string => typeof o === 'string')
            .slice(0, MAX_OPTIONS)
            .map((o) => o.slice(0, MAX_OPTION_LEN))
        : [];
    }
    // F9 — number-only constraints; every other type DROPS them (the same
    // closed-world posture as `options`: an authored constraint on a text field
    // is an authoring error swallowed nowhere — it simply never persists).
    if (type === 'number') {
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const min = num(f.min);
      const max = num(f.max);
      const step = num(f.step);
      if (step !== undefined && step <= 0) throw new OpenwopError('validation_error', `fields[${i}].step MUST be > 0.`, 400, { field: key });
      if (min !== undefined && max !== undefined && min > max) throw new OpenwopError('validation_error', `fields[${i}].min MUST be ≤ max.`, 400, { field: key });
      if (min !== undefined) field.min = min;
      if (max !== undefined) field.max = max;
      if (step !== undefined) field.step = step;
    }
    // Trim FIRST so a whitespace-only description clears rather than persisting
    // an empty help slot the renderer would draw as a blank line.
    const description = typeof f.description === 'string' ? f.description.trim().slice(0, MAX_DESCRIPTION) : '';
    if (description) field.description = description;
    return field;
  });
}

/** ADR 0246 — validate an intake binding against the form's own fields. `listId`
 *  is well-formedness-only (opaque to forms; org-ownership is a write-boundary
 *  check in `submit-idea`). `null` clears the binding. */
function sanitizeIntakeBinding(raw: unknown, fields: FormField[]): IntakeBinding | undefined {
  if (raw === null || raw === undefined) return undefined;
  const b = (raw ?? {}) as Record<string, unknown>;
  const listId = typeof b.listId === 'string' ? b.listId.trim() : '';
  if (!listId || listId.length > 200) throw new OpenwopError('validation_error', '`intakeBinding.listId` is required.', 400, { field: 'intakeBinding.listId' });
  const keys = new Set(fields.map((f) => f.key));
  const field = (name: 'titleField' | 'requesterField' | 'notesField', required: boolean): string | undefined => {
    const v = typeof b[name] === 'string' ? (b[name] as string).trim() : '';
    if (!v) {
      if (required) throw new OpenwopError('validation_error', `\`intakeBinding.${name}\` is required.`, 400, { field: `intakeBinding.${name}` });
      return undefined;
    }
    if (!keys.has(v)) throw new OpenwopError('validation_error', `\`intakeBinding.${name}\` must name a form field.`, 400, { field: `intakeBinding.${name}`, value: v });
    return v;
  };
  const titleField = field('titleField', true) as string;
  const requesterField = field('requesterField', false);
  const notesField = field('notesField', false);
  return { listId, titleField, ...(requesterField ? { requesterField } : {}), ...(notesField ? { notesField } : {}) };
}

export async function listForms(tenantId: string, orgId: string): Promise<FormDef[]> {
  // Grade pass 2026-07-10 (FORMS-2): a tenant-slice scan via the GOV-1 index,
  // not a full cross-tenant `list()` — bounded by the caller's own forms.
  const all = await forms.listForTenantIndexed(tenantId);
  return all.filter((f) => f.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Tenant+org-guarded read (the authed surface + ctx.features.forms use this). */
export async function getForm(tenantId: string, orgId: string, formId: string): Promise<FormDef | null> {
  const f = await forms.get(formId);
  return f && f.tenantId === tenantId && f.orgId === orgId ? f : null;
}

function sanitizeEmailOptInField(raw: unknown, fields: FormField[]): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw new OpenwopError('validation_error', '`emailOptInField` MUST be a string field key.', 400, { field: 'emailOptInField' });
  const f = fields.find((x) => x.key === raw);
  if (!f || f.type !== 'checkbox') throw new OpenwopError('validation_error', '`emailOptInField` MUST name an existing checkbox field.', 400, { field: 'emailOptInField' });
  return raw;
}

export async function createForm(input: {
  tenantId: string; orgId: string; title: string; fields: unknown;
  createToContact?: boolean; emailOptInField?: unknown; submitMessage?: string; intakeBinding?: unknown; createdBy: string;
  /** Server-supplied only — see `FormDef.originTemplate`. Routes that create a
   *  form from a request body MUST NOT forward a client-provided value here. */
  originTemplate?: { templateId: string; packName: string; packVersion: string; templateVersion?: string };
}): Promise<FormDef> {
  const now = new Date().toISOString();
  const fields = sanitizeFields(input.fields ?? []);
  const intakeBinding = sanitizeIntakeBinding(input.intakeBinding, fields);
  const form: FormDef = {
    formId: `form:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    // Bounded like every other authored string (ADR 0516 Phase 2a) — the title
    // heads the PUBLIC fill page.
    title: input.title.trim().slice(0, MAX_TITLE),
    status: 'draft',
    fields,
    createToContact: input.createToContact === true,
    ...(sanitizeEmailOptInField(input.emailOptInField, fields) ? { emailOptInField: sanitizeEmailOptInField(input.emailOptInField, fields)! } : {}),
    ...(input.submitMessage ? { submitMessage: input.submitMessage.slice(0, MAX_SUBMIT_MESSAGE) } : {}),
    ...(intakeBinding ? { intakeBinding } : {}),
    ...(input.originTemplate ? { originTemplate: input.originTemplate } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await forms.put(form);
  return form;
}

export async function updateForm(tenantId: string, orgId: string, formId: string, patch: {
  title?: string; fields?: unknown; createToContact?: boolean; emailOptInField?: unknown; submitMessage?: string; intakeBinding?: unknown;
}): Promise<FormDef | null> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return null;
  const next: FormDef = { ...existing, updatedAt: new Date().toISOString() };
  // Same bound on the UPDATE path — a cap enforced only at create is a cap a
  // rename walks straight past.
  if (patch.title !== undefined) next.title = patch.title.trim().slice(0, MAX_TITLE);
  if (patch.fields !== undefined) next.fields = sanitizeFields(patch.fields);
  if (patch.createToContact !== undefined) next.createToContact = patch.createToContact === true;
  // ADR 0338 §D1 — validate against the NEXT fields; `null`/'' clears; a
  // fields-only patch that removes the designated checkbox clears it silently
  // (an opt-in designation is UX config, not a data mapping — unlike the
  // intake binding below, nothing downstream hard-fails on its absence).
  if (patch.emailOptInField !== undefined) {
    const opt = sanitizeEmailOptInField(patch.emailOptInField, next.fields);
    if (opt) next.emailOptInField = opt; else delete next.emailOptInField;
  } else if (patch.fields !== undefined && next.emailOptInField) {
    const still = next.fields.find((f) => f.key === next.emailOptInField && f.type === 'checkbox');
    if (!still) delete next.emailOptInField;
  }
  if (patch.submitMessage !== undefined) next.submitMessage = patch.submitMessage.slice(0, MAX_SUBMIT_MESSAGE);
  // Validate the binding against the NEXT fields (a same-patch field rename must
  // not orphan a mapping). `null` clears it.
  if (patch.intakeBinding !== undefined) {
    const binding = sanitizeIntakeBinding(patch.intakeBinding, next.fields);
    if (binding) next.intakeBinding = binding; else delete next.intakeBinding;
  } else if (patch.fields !== undefined && next.intakeBinding) {
    // A fields-ONLY patch (no binding re-sent) that renames/removes a mapped
    // field must not silently keep an orphaned binding (grade-code BE#1) — the
    // bridge run would later hard-fail on the missing field. Re-validate the
    // existing binding against the new fields; a broken mapping 400s at patch
    // time (surfaced) instead of failing silently downstream. (sanitize throws
    // on a broken mapping; it only returns undefined for a null/absent input.)
    const revalidated = sanitizeIntakeBinding(next.intakeBinding, next.fields);
    if (revalidated) next.intakeBinding = revalidated;
  }
  await forms.put(next);
  return next;
}

export async function setFormStatus(tenantId: string, orgId: string, formId: string, status: FormStatus): Promise<FormDef | null> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return null;
  const next: FormDef = { ...existing, status, updatedAt: new Date().toISOString() };
  await forms.put(next);
  return next;
}

export async function deleteForm(tenantId: string, orgId: string, formId: string): Promise<boolean> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return false;
  // Grade-data FRMD-2 — cascade the form's submissions: without an owning
  // form they are unreachable orphaned PII (list/read routes resolve the form
  // first). Children BEFORE parent so a mid-way failure leaves reachability
  // intact (fail-closed ordering). The abuse counter row goes with them.
  const rows = await submissions.listForTenantIndexed(tenantId);
  for (const s of rows) {
    if (s.formId === formId && s.orgId === orgId) await submissions.delete(s.submissionId);
  }
  await submissionCounts.delete(formId).catch(() => undefined);
  const deleted = await forms.delete(formId);
  // AFTER the row is gone — let consumers prune their soft refs (e.g. webinars
  // unbinds a form→event binding). Best-effort, never throws (ADR 0404 WEB-2).
  if (deleted) await fireFormDeleted({ tenantId, orgId, formId });
  return deleted;
}

/** Public resolver: a PUBLISHED form by id, NO tenant guard — the public route
 *  derives tenant from the result and then gates on its toggle (uniform 404). */
export async function getPublishedForm(formId: string): Promise<FormDef | null> {
  const f = await forms.get(formId);
  return f && f.status === 'published' ? f : null;
}

export async function listSubmissions(tenantId: string, orgId: string, formId: string): Promise<Submission[]> {
  // Grade pass 2026-07-10 (FORMS-2): tenant-slice scan via the GOV-1 index —
  // the public submit path appends unboundedly, so a full `list()` here was a
  // cross-tenant scan that grew with EVERY tenant's lead volume.
  const all = await submissions.listForTenantIndexed(tenantId);
  return all
    .filter((s) => s.orgId === orgId && s.formId === formId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** FORMS-3 (grade pass 2026-07-10) — the paged inbox read: newest-first,
 *  cursor = the last row's `createdAt~submissionId` (the chat-messages
 *  pattern), so the admin inbox stays O(page) to RENDER as forms grow toward
 *  the 50k cap. The tenant-slice read is still O(tenant rows) server-side —
 *  acceptable at the cap; a created-at index is the next step if it isn't. */
export interface SubmissionPage { submissions: Submission[]; nextCursor: string | null; flaggedCount: number; droppedCount: number }
export async function listSubmissionsPage(tenantId: string, orgId: string, formId: string, opts: { limit: number; before?: string }): Promise<SubmissionPage> {
  const all = await listSubmissions(tenantId, orgId, formId); // newest-first
  let start = 0;
  if (opts.before) {
    const [at, id] = [opts.before.slice(0, opts.before.indexOf('~')), opts.before.slice(opts.before.indexOf('~') + 1)];
    const ix = all.findIndex((s) => s.createdAt === at && s.submissionId === id);
    if (ix >= 0) start = ix + 1;
  }
  const page = all.slice(start, start + opts.limit);
  const last = page[page.length - 1];
  const nextCursor = last && start + opts.limit < all.length ? `${last.createdAt}~${last.submissionId}` : null;
  // ADR 0584 (FORM-UX-1) — the abuse numbers ride the page the inbox already
  // reads. They come from the COUNTER row, not from the loaded page, so the
  // ratio an operator sees is the form's true one and not "whatever fitted in
  // the last 100 rows". `droppedCount` in particular has no row to count.
  const stats = await submissionStatsOf(formId);
  return { submissions: page, nextCursor, flaggedCount: stats.flaggedCount, droppedCount: stats.droppedCount };
}

/** Validate raw submit values against the form's fields; returns the cleaned map. */
export function validateValues(form: FormDef, values: Record<string, unknown>): Record<string, string | number | boolean> {
  if (JSON.stringify(values).length > MAX_VALUES_CHARS) throw new OpenwopError('validation_error', 'Submission too large.', 413, {});
  const out: Record<string, string | number | boolean> = {};
  for (const f of form.fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (f.required && empty) throw new OpenwopError('validation_error', `Field \`${f.key}\` is required.`, 400, { field: f.key });
    if (empty) continue;
    if (f.type === 'checkbox') {
      const checked = v === true || v === 'true';
      // R2 F4 — a REQUIRED checkbox must be TRUE: check-then-uncheck used to
      // satisfy it and record `false`, which on the one control where required
      // means consent ("I agree to the terms") made the requirement void.
      if (f.required && !checked) throw new OpenwopError('validation_error', `Field \`${f.key}\` is required.`, 400, { field: f.key });
      out[f.key] = checked;
      continue;
    }
    if (typeof v !== 'string') throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be a string.`, 400, { field: f.key });
    if (v.length > MAX_FIELD_LEN) throw new OpenwopError('validation_error', `Field \`${f.key}\` is too long.`, 400, { field: f.key });
    if (f.type === 'email' && !EMAIL_RE.test(v)) throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be a valid email.`, 400, { field: f.key });
    if (f.type === 'select' && f.options && f.options.length > 0 && !f.options.includes(v)) throw new OpenwopError('validation_error', `Field \`${f.key}\` is not an allowed option.`, 400, { field: f.key });
    if (f.type === 'number') {
      // Stored as a NUMBER, not the submitted string — `Submission.values`
      // already admits it, and a downstream consumer summing a guest count
      // must not have to re-parse. Rejects NaN/Infinity rather than coercing.
      const num = Number(v);
      if (!Number.isFinite(num)) throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be a number.`, 400, { field: f.key });
      // F9 — authored constraints. The step check is epsilon-tolerant: 0.3/0.1
      // is 2.9999999999999996 in floats, and rejecting an exact-looking value
      // over binary representation would be the engine lying to the visitor.
      if (f.min !== undefined && num < f.min) throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be at least ${f.min}.`, 400, { field: f.key, min: f.min });
      if (f.max !== undefined && num > f.max) throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be at most ${f.max}.`, 400, { field: f.key, max: f.max });
      if (f.step !== undefined) {
        const base = f.min ?? 0;
        const ratio = (num - base) / f.step;
        if (Math.abs(Math.round(ratio) - ratio) > 1e-9) {
          throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be in steps of ${f.step}${f.min !== undefined ? ` from ${f.min}` : ''}.`, 400, { field: f.key, step: f.step });
        }
      }
      out[f.key] = num;
      continue;
    }
    out[f.key] = v;
  }
  return out;
}

/**
 * Record a submission (the capture path only ever appends), then run the registered submission sinks
 * (ADR 0330 §D1) — the lead is durably captured before any secondary effect,
 * so a destination hiccup degrades to a recorded `error` marker, never a lost
 * lead. A skipped destination (e.g. CRM toggled off) is NOT an error: the
 * sink simply returns no marker. `tenantId`/`orgId` come from the resolved
 * form, never the request.
 */
export async function recordSubmission(
  form: FormDef,
  values: Record<string, string | number | boolean>,
  meta: Submission['meta'],
  clientKey?: string,
  flagged?: Submission['flagged'],
): Promise<Submission> {
  // FRMB-IDEM — at-most-once capture (opt-in): a client-supplied key derives a
  // DETERMINISTIC submission id, so a network retry or double-click replays
  // the SAME row and short-circuits BEFORE the cap check, the counter bump,
  // and the sinks (no duplicate CRM contact). Keyless keeps always-append.
  const submissionId = clientKey
    ? `sub:ck:${createHash('sha256').update(`${form.formId}\n${clientKey}`).digest('hex').slice(0, 40)}`
    : `sub:${randomUUID()}`;
  if (clientKey) {
    const existing = await submissions.get(submissionId);
    if (existing && existing.tenantId === form.tenantId) {
      log.info('submission_replayed', { tenantId: form.tenantId, formId: form.formId, submissionId });
      return existing;
    }
  }
  // GC-FRM-7 — the abuse ceiling: refuse honestly at cap (a capture primitive
  // must never silently drop leads; past 50k/form the surface is being abused
  // or needs retention tooling — either way, 429 is the honest answer).
  //
  // ADR 0584 — a FLAGGED row is metered against its own, much smaller
  // quarantine budget, so bot volume can never crowd out real capture.
  const stats = await submissionStatsOf(form.formId);
  if (flagged) {
    if (stats.flaggedCount >= MAX_FLAGGED_PER_FORM) {
      // The honest end of the quarantine: we will NOT store it, so we must not
      // claim we did. `droppedCount` keeps the operator's ratio truthful even
      // for the submissions no row exists for.
      await adjustCount(form.formId, form.tenantId, 'droppedCount');
      log.warn('submission_flagged_cap_refused', { tenantId: form.tenantId, formId: form.formId, reason: flagged, cap: MAX_FLAGGED_PER_FORM });
      throw new OpenwopError('rate_limited', 'This form has reached its submission capacity.', 429);
    }
  } else if (stats.count >= MAX_SUBMISSIONS_PER_FORM) {
    log.warn('submission_cap_refused', { tenantId: form.tenantId, formId: form.formId, cap: MAX_SUBMISSIONS_PER_FORM });
    throw new OpenwopError('rate_limited', 'This form has reached its submission capacity.', 429);
  }
  const submission: Submission = {
    submissionId,
    tenantId: form.tenantId,
    orgId: form.orgId,
    formId: form.formId,
    values,
    meta,
    ...(flagged ? { flagged } : {}),
    createdAt: new Date().toISOString(),
  };
  // ADR 0584 (FORM-3) — the at-most-once guard is a CLAIM, not a read-then-write.
  // The old shape read `null` on both racing submits, fell through the cap and
  // the counter, and ran the sinks TWICE: a duplicate CRM contact, a duplicate
  // ticket, a second consent write — exactly the duplicates the key exists to
  // prevent, in the exact scenario it is for (a double-click on a slow link).
  //
  // The claim writes the REAL row (not a placeholder), so there is no window in
  // which a successful claim can be followed by a failed write and burn the key
  // — the compensation problem is removed by construction rather than handled.
  // A lost race resolves to the winner's row, which IS the replay answer.
  if (clientKey) {
    if (!(await submissions.compareAndSwap(null, submission))) {
      const winner = await submissions.get(submissionId);
      if (winner && winner.tenantId === form.tenantId) {
        log.info('submission_replayed', { tenantId: form.tenantId, formId: form.formId, submissionId, raced: true });
        return winner;
      }
      // The key is claimed by something we cannot read back. Never report
      // success over a row we did not see — a transient failure the client can
      // retry safely (the same key replays onto the winner).
      log.error('submission_claim_lost', { tenantId: form.tenantId, formId: form.formId, submissionId });
      throw new OpenwopError('internal_error', 'Could not record the submission. Please try again.', 500);
    }
  } else {
    await submissions.put(submission); // persist FIRST — capture before side-effects
  }
  await adjustCount(form.formId, form.tenantId, flagged ? 'flaggedCount' : 'count');
  log.info(flagged ? 'submission_quarantined' : 'submission_captured', { tenantId: form.tenantId, formId: form.formId, ...(flagged ? { reason: flagged } : {}) });
  // ADR 0584 — a QUARANTINED submission is stored and nothing more: no CRM
  // contact, no ticket, no consent write, no funnel-completion event, no host
  // event. The row exists so a human can rescue a false positive; it must not
  // move anything downstream until one does.
  //
  // §Correction (FORM-FUNNEL-1) — "no funnel-completion event" was FALSE when
  // this line was written, and returning here is only HALF of what makes it
  // true. This return skips the ADR 0332 sink, which is one of the two emitters
  // of `funnel.step_completed`. The other is the funnel viewer's own advance
  // (`GET …/funnels/:slug/next`), which fires on the renderer's `onSubmitted`
  // and knew nothing about the row — so a held submission still landed a
  // durable completion in the conversion rollup. The advance now passes the
  // submission id and consults `isSubmissionHeld` (see it, and the reason the
  // visitor still advances, in `features/funnels/routes.ts`). Both emitters are
  // required for the sentence above to hold; neither alone is sufficient.
  if (flagged) return submission;
  if (await runSubmissionSinks(form, submission)) {
    await submissions.put(submission); // re-persist with sink markers (contactId / error)
  }
  // ADR 0246 — announce the submission on the ADR 0208 host-event seam AFTER all
  // persistence. Ids-only + fire-and-forget: a bound bridge chain re-fetches the
  // values under authz and can file the submission as a priority-matrix idea.
  formSubmissionCreated({ tenantId: form.tenantId, orgId: form.orgId, formId: form.formId, submissionId: submission.submissionId });
  return submission;
}

/** ADR 0246 — one submission, tenant+org+form-guarded (the bridge chain reads
 *  values here under authz; the ids-only event carries none). */
export async function getSubmission(tenantId: string, orgId: string, formId: string, submissionId: string): Promise<Submission | null> {
  const s = await submissions.get(submissionId);
  return s && s.tenantId === tenantId && s.orgId === orgId && s.formId === formId ? s : null;
}

/**
 * ADR 0584 §Correction (FORM-FUNNEL-1) — is this submission QUARANTINED?
 *
 * The read an EMBEDDING surface needs to honour "a held submission moves
 * nothing downstream". It answers `false` for an unknown id on purpose: the
 * caller is a public path holding client-supplied input, and "I cannot see
 * this row" must degrade to today's behaviour, never to a refusal a bot could
 * provoke. Tenant-scoped — a cross-tenant id is a miss, so this is not a probe.
 *
 * Deliberately NOT exposed to the respondent: the submit response stays
 * BYTE-IDENTICAL for a clean and a held submission (ADR 0584 Decision 1's
 * anti-oracle property). Telling the client "you were flagged" would hand a
 * bot the decoy's name, which is the whole thing the honeypot buys.
 */
export async function isSubmissionHeld(tenantId: string, submissionId: string): Promise<boolean> {
  if (!tenantId || !submissionId) return false;
  const s = await submissions.get(submissionId);
  return !!s && s.tenantId === tenantId && !!s.flagged;
}

/**
 * ADR 0584 §Correction (FORM-BUDGET-1) — delete ONE submission, and give its
 * occupancy back.
 *
 * There was no per-submission delete path at all, which is what turned the
 * quarantine budget into a one-way ratchet: an operator looking at 1 000 held
 * rows had no way to clear them, and the only reset was `deleteForm`, which
 * destroys every real lead with them. So this is not a convenience route — it
 * is the half of the quarantine promise that was missing. `deleteForm`'s
 * cascade does NOT route through here on purpose: it drops the whole counter
 * row in one write rather than decrementing it N times.
 *
 * Tenant+org+form-guarded through `getSubmission`, so a cross-tenant id is a
 * miss rather than a probe.
 */
export async function deleteSubmission(tenantId: string, orgId: string, formId: string, submissionId: string): Promise<boolean> {
  const existing = await getSubmission(tenantId, orgId, formId, submissionId);
  if (!existing) return false;
  const deleted = await submissions.delete(submissionId);
  if (!deleted) return false;
  await adjustCount(formId, tenantId, existing.flagged ? 'flaggedCount' : 'count', -1);
  log.info('submission_deleted', { tenantId, formId, ...(existing.flagged ? { reason: existing.flagged } : {}) });
  return true;
}

/** Test-only: clear both stores. */
export async function __resetFormsStore(): Promise<void> {
  await forms.__clear();
  await submissions.__clear();
}
