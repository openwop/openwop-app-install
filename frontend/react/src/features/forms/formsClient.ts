/**
 * Forms API client (ADR 0017). Authed org-scoped builder under
 * /host/openwop-app/forms/orgs/:orgId; surfaces the PUBLIC /public-forms/:formId URL
 * and a form's captured submissions.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type FieldType = 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'email', 'number', 'textarea', 'select', 'checkbox'];
export interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[]; /** UX_UPGRADE-forms F-G1 — optional per-field help text. */ description?: string; /** F9 — number-only authored constraints. */ min?: number; max?: number; step?: number }
export type FormStatus = 'draft' | 'published';

/** ADR 0246 — routes this form's submissions to a priority-matrix intake list. */
export interface IntakeBinding { listId: string; titleField: string; requesterField?: string; notesField?: string }

export interface FormDef {
  formId: string;
  orgId: string;
  title: string;
  status: FormStatus;
  fields: FormField[];
  createToContact: boolean;
  emailOptInField?: string;
  submitMessage?: string;
  intakeBinding?: IntakeBinding;
  /** ADR 0516 §Provenance — server-stamped at from-template instantiation
   *  (registry-sourced, forgery-refused). Absent on hand-authored forms.
   *  DOCTPL-19: declared here so the detail surface can render the origin. */
  originTemplate?: { templateId: string; packName: string; packVersion: string; templateVersion?: string };
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  submissionId: string;
  formId: string;
  values: Record<string, string | number | boolean>;
  contactId?: string;
  error?: string;
  createdAt: string;
  /** R2 FRM2-8 — the attribution the server has always stored and the client
   *  type used to STRIP: where the lead came from. */
  meta?: { referrer?: string; utm?: Record<string, string>; context?: Record<string, string> };
  /** ADR 0584 (FORM-UX-1) — this submission tripped an abuse control and is
   *  QUARANTINED: stored so a false positive is recoverable, but no CRM contact,
   *  ticket, consent write or funnel-completion EVENT ran off it.
   *
   *  §Correction (FORM-FUNNEL-1): the last clause read "funnel completion" and
   *  was half true — the ADR 0332 submission sink never runs for a held row,
   *  but the funnel viewer's own advance emitted `funnel.step_completed`
   *  anyway, because it did not know which submission it was advancing off.
   *  It now passes the id and the server withholds the event. The VISITOR
   *  still advances, deliberately (a false positive must not be walled into a
   *  step they cannot leave), so what is suppressed is the analytics event —
   *  which is the half that inflates conversion. */
  flagged?: 'honeypot' | 'guard';
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * FORM-UX-5 (ADR 0584) — a TYPED failure, the `CsmRequestError` shape.
 *
 * Every function here used to throw a bare `Error`, so both Forms pages' idiom
 * — `e instanceof Error ? e.message : t('…')` — ALWAYS took the first arm. A
 * network rejection is a `TypeError`, which is also an `Error`, so there was no
 * input that could reach the second. Seven localized failure strings ×
 * four locales — **28 translations** — were dead by construction, and every
 * failure a French or pt-BR operator saw was raw English: either the backend's
 * `OpenwopError` prose ("Form not found.", "fields[0].key is reserved.") or the
 * browser's own "Failed to fetch". Carrying the status lets the page pick a
 * localized sentence and demote the server's words to a detail line.
 */
export class FormsRequestError extends Error {
  readonly status: number;
  /** The server's own `message`, when it sent one. Never the primary copy. */
  readonly detail: string | undefined;
  constructor(op: string, status: number, detail?: string) {
    super(detail || `${op} returned ${status}`);
    this.name = 'FormsRequestError';
    this.status = status;
    this.detail = detail || undefined;
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new FormsRequestError(ctx, res.status, detail);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/forms/orgs/${encodeURIComponent(orgId)}/forms`;

export async function listForms(orgId: string): Promise<FormDef[]> {
  const res = await fetch(base(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ forms: FormDef[] }>(res, 'listForms')).forms;
}

/** ONE form by id — what `/forms/:formId` loads (ADR 0519). The detail page is
 *  reachable by URL alone (a bookmark, a shared link, a reload), so it must not
 *  depend on the collection page's list having been fetched first. A 404 here IS
 *  the "no such form in this workspace" answer the page renders. */
export async function getForm(orgId: string, formId: string): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<FormDef>(res, 'getForm');
}

export async function createForm(orgId: string, input: { title: string; fields: FormField[]; createToContact: boolean; submitMessage?: string }): Promise<FormDef> {
  const res = await fetch(base(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<FormDef>(res, 'createForm');
}

/** ADR 0516 — the installed form templates (pack-sourced, read-only). */
export interface FormTemplate {
  templateId: string;
  label: string;
  description?: string;
  category?: string;
  title: string;
  fields: FormField[];
  /** DOCTPL-19 — the pack this catalog entry ships in (server-supplied from the
   *  registry). The gallery's source-attribution chip — the cheap half of the
   *  ADR 0516 §Provenance phishing mitigation. */
  packName?: string;
  packVersion?: string;
}

export async function listFormTemplates(orgId: string): Promise<FormTemplate[]> {
  const res = await fetch(`${root}/forms/orgs/${encodeURIComponent(orgId)}/form-templates`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ templates: FormTemplate[] }>(res, 'listFormTemplates');
  return body.templates ?? [];
}

/** Instantiate a template. The SERVER creates through `createForm`, so pack fields
 *  are sanitized there — this never posts field definitions itself. */
export async function createFormFromTemplate(orgId: string, templateId: string, title?: string): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/from-template`, fetchOpts({
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ templateId, ...(title ? { title } : {}) }),
  }));
  return asJson<FormDef>(res, 'createFormFromTemplate');
}

export async function updateForm(orgId: string, formId: string, patch: { title?: string; fields?: FormField[]; createToContact?: boolean; emailOptInField?: string | null; submitMessage?: string; intakeBinding?: IntakeBinding | null }): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<FormDef>(res, 'updateForm');
}

/** The org's priority-matrix intake lists, for the intake-binding picker (ADR
 *  0246). FE-composition — the backend features stay import-independent. */
export async function listIntakeLists(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${root}/priority-matrix/lists`, fetchOpts({ headers: authedHeaders() }));
  // R2 FRM2-6 — feature-off/no-access (403/404) stays fail-soft (no picker);
  // a 5xx is a FAILED read and must throw so the page's failed flag fires
  // instead of rendering "no lists yet — create one" over a server error.
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) throw new FormsRequestError('listIntakeLists', res.status);
  const { lists } = (await res.json()) as { lists: Array<{ id: string; name: string; orgId: string }> };
  return lists.filter((l) => l.orgId === orgId).map((l) => ({ id: l.id, name: l.name }));
}

export async function setFormStatus(orgId: string, formId: string, status: FormStatus): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/status`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson<FormDef>(res, 'setFormStatus');
}

export async function deleteForm(orgId: string, formId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new FormsRequestError('deleteForm', res.status);
}

export async function listSubmissions(orgId: string, formId: string): Promise<Submission[]> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/submissions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ submissions: Submission[] }>(res, 'listSubmissions')).submissions;
}

/** ADR 0584 §Correction (FORM-BUDGET-1) — delete ONE submission.
 *
 *  The operator lever for an occupancy-metered quarantine budget: a form that
 *  has filled its 1 000 held rows had NO way to give any of them back short of
 *  deleting the form (which cascades every real lead), and retention is off on
 *  two independent default switches. 404 is a uniform miss (wrong form, wrong
 *  org, wrong row) — it does not distinguish, by design. */
export async function deleteSubmission(orgId: string, formId: string, submissionId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new FormsRequestError('deleteSubmission', res.status);
}

/** FRMB-PAGE — paged variant (the channels idiom): newest-first `limit` page +
 *  a `nextCursor` to walk older (`null` at end of history). */
export interface SubmissionPage {
  submissions: Submission[];
  nextCursor: string | null;
  /** ADR 0584 (FORM-UX-1) — the operator-visible abuse numbers, from the SERVER's
   *  counter row rather than the loaded page, so the ratio is the form's true one
   *  and not "whatever fitted in the last 100 rows". `dropped` has no rows to
   *  count at all: those submissions were refused once the quarantine budget was
   *  full. Without these, a form losing every lead to a false-positive honeypot
   *  looks identical to a form nobody submits. */
  flaggedCount: number;
  droppedCount: number;
}
export async function listSubmissionsPage(orgId: string, formId: string, limit: number, before?: string): Promise<SubmissionPage> {
  const q = `limit=${encodeURIComponent(limit)}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/submissions?${q}`, fetchOpts({ headers: authedHeaders() }));
  const r = await asJson<{ submissions: Submission[]; nextCursor?: string | null; flaggedCount?: number; droppedCount?: number }>(res, 'listSubmissionsPage');
  return { submissions: r.submissions ?? [], nextCursor: r.nextCursor ?? null, flaggedCount: r.flaggedCount ?? 0, droppedCount: r.droppedCount ?? 0 };
}

/** The public, unauthenticated form URL (render + submit live under it). */
export const publicFormUrl = (formId: string): string => `${root}/public-forms/${encodeURIComponent(formId)}`;

/** ADR 0331 §D3 — the hosted SPA fill page (share this); the JSON API URL above
 *  remains the embed contract. */
export const hostedFormUrl = (formId: string): string => `${window.location.origin}/f/${encodeURIComponent(formId)}`;
