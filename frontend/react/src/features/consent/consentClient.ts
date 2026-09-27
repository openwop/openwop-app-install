/**
 * Consent API client (ADR 0020). Authed org-scoped policy + records +
 * data-subject (GDPR) lookup/delete under /host/openwop-app/consent/orgs/:orgId.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type DefaultMode = 'opt-in' | 'opt-out';
export interface ConsentPolicy { tenantId: string; regulatedRegions: string[]; defaultMode: DefaultMode }
export interface ConsentRecord {
  subjectKey: string;
  region?: string;
  /** R2 CN-SP-4 — the FULL wire shape: per-channel specifics (whatsapp is
   *  strict explicit-opt-in per ADR 0394) + provenance, previously dropped by
   *  this type so the UI could render a whatsapp-true record as "necessary
   *  only". */
  categories: {
    necessary: boolean; analytics: boolean; marketing: boolean;
    'marketing.email'?: boolean; 'marketing.sms'?: boolean; 'marketing.push'?: boolean; 'marketing.whatsapp'?: boolean;
  };
  source?: string;
  legalBasis?: string;
  purposes?: string[];
  ts: string;
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * A refusal the UI can BRANCH ON without reading English.
 *
 * Review F10 — `ConsentPage.doErase` decided whether a failure was a legal hold
 * with `/legal hold/i.test(msg)`, an English substring test in a 4-locale app.
 * It was worse than locale-fragile: `deleteSubject` never parsed the response
 * body at all, so the message was always the literal
 * `` `deleteSubject returned ${res.status}` `` and the pattern could NEVER
 * match — in ANY locale, including English. The hold branch was unreachable and
 * the operator saw a raw status string instead of the cause and its exit.
 *
 * The server already sends what is needed (`{ error, message, details }` from
 * `OpenwopError.toEnvelope()`); the client was throwing it away. `code` is the
 * stable machine identifier (`legal_hold`), `message` stays for display.
 */
export class ConsentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ConsentApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Parse an error envelope into a `ConsentApiError`. Never throws on a
 *  non-JSON/HTML body (a proxy 502 is still a refusal the UI must render). */
async function asError(res: Response, ctx: string): Promise<ConsentApiError> {
  let code = '';
  let message = '';
  let details: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as { error?: string; message?: string; details?: Record<string, unknown> };
    code = body?.error ?? '';
    message = body?.message ?? '';
    details = body?.details ?? {};
  } catch { /* non-JSON body — fall through to the status-only form */ }
  return new ConsentApiError(res.status, code, message || `${ctx} returned ${res.status}`, details);
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw await asError(res, ctx);
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/consent/orgs/${encodeURIComponent(orgId)}`;

/** CONS-4 / CONS-UX-2 — an active tenant LEGAL HOLD, read-only. Placing and
 *  lifting a hold stays on the superadmin ops surface; the compliance console
 *  needs only to know that erasure is currently forbidden, so it can say so
 *  BEFORE the operator commits to an irreversible action. */
export interface LegalHold { reason: string; since: string }

export async function getPolicy(orgId: string): Promise<{ policy: ConsentPolicy; legalHold: LegalHold | null }> {
  const res = await fetch(`${base(orgId)}/policy`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ policy: ConsentPolicy; legalHold?: LegalHold }>(res, 'getPolicy');
  return { policy: body.policy, legalHold: body.legalHold ?? null };
}

export async function setPolicy(orgId: string, input: { regulatedRegions: string[]; defaultMode: DefaultMode }): Promise<ConsentPolicy> {
  const res = await fetch(`${base(orgId)}/policy`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ policy: ConsentPolicy }>(res, 'setPolicy')).policy;
}

export async function listRecords(orgId: string): Promise<ConsentRecord[]> {
  const res = await fetch(`${base(orgId)}/records`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ records: ConsentRecord[] }>(res, 'listRecords')).records;
}

export async function getSubject(orgId: string, subjectKey: string): Promise<ConsentRecord | null> {
  const res = await fetch(`${base(orgId)}/subjects/${encodeURIComponent(subjectKey)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ record: ConsentRecord | null }>(res, 'getSubject')).record;
}

/**
 * The outcome of a data-subject erasure (CONS-G1). `failed` counts DISTINCT
 * feature erasers that threw — the subject's data is STILL PRESENT in that many
 * stores, so a `failed > 0` result is a partial erasure, not a success.
 * `keysResolved` is how many linked identity keys the subject expanded to
 * (ADR 0381) — one person can span a session key and a contact id.
 */
export interface SubjectErasureResult {
  ok: boolean;
  consentRecord: boolean;
  erasure: {
    total: number; failed: number; keysResolved: number; resolverFailures?: number; failedFeatures?: string[];
    /** `true` when erasers reported and TOTAL rows touched was zero: either the
     *  subject genuinely had no data HERE, or the request named a subject whose
     *  data lives in another workspace (erasure is tenant-scoped by design — the
     *  WF-TWIN-3 correction). The wire has always carried this; the UI must not
     *  render it as the green "erased" receipt. */
    foundNothing?: boolean;
    /** Rows deleted/scrubbed, summed over erasers that report (opt-in). */
    rowsTouched?: number;
    /** ADR 0657 D9 (CONS-UX-27) — erasers the host EXPECTED for this subject's
     *  data but that never registered on this install. Not a failure (nothing
     *  threw) and not a success (nothing ran): a third class the receipt must
     *  name on its own line, never folded into `failedFeatures`. */
    missing?: string[];
  };
}

export async function deleteSubject(orgId: string, subjectKey: string): Promise<SubjectErasureResult> {
  const res = await fetch(`${base(orgId)}/subjects/${encodeURIComponent(subjectKey)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // Review F10 — this discarded the body, so the 409's `error: 'legal_hold'`
  // never reached the caller and the page's hold branch was dead code.
  if (!res.ok) throw await asError(res, 'deleteSubject');
  return (await res.json()) as SubjectErasureResult;
}

/**
 * ADR 0657 D7 — the audited door back for an ERASED subject.
 *
 * `POST …/subjects/:subjectKey/readmit { attestation }` clears the erasure
 * TOMBSTONE only. It grants NO consent: the subject's next affirmative opt-in
 * (a form, the public capture, a preference link) is what re-grants. The
 * attestation (≥ 20 chars) is the operator's statement that the person asked
 * to return; the server hashes it into a `governance_decision` row.
 *
 * `{ readmitted: false, reason: 'not_erased' }` is a 200, not an error: the
 * key carried no tombstone, so there was nothing to clear. The page renders it
 * as information, never as a failure.
 */
export type ReadmitResult =
  | { readmitted: true; subjectKey: string }
  | { readmitted: false; reason: 'not_erased' };

export const READMIT_ATTESTATION_MIN_CHARS = 20;

export async function readmitSubject(orgId: string, subjectKey: string, attestation: string): Promise<ReadmitResult> {
  const res = await fetch(
    `${base(orgId)}/subjects/${encodeURIComponent(subjectKey)}/readmit`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ attestation }) }),
  );
  if (!res.ok) throw await asError(res, 'readmitSubject');
  return (await res.json()) as ReadmitResult;
}
