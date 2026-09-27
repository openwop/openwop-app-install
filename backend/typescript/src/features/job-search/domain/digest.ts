/**
 * ADR 0540 D2 — the job digest is NOT a custom field.
 *
 * `Deal.customFields` is `Record<string, string | number | boolean>` — scalars
 * only. A digest is structured (`skills[]`, `requirements[]`,
 * `responsibilities[]`), and serialising it into a string field would put a
 * parser on every read, defeat CRM's typed-field system, and be invisible to
 * CRM's own validation.
 *
 * So the digest lives here, keyed by the deal it describes. It is DERIVED data
 * — re-derivable from the listing — and is never the source of truth for
 * anything CRM shows.
 *
 * Immutable per version (ADR 0540 matrix row 9): a re-scored or re-parsed
 * posting writes a NEW version rather than mutating the row a decision was made
 * against. A digest that could change under a recorded decision would let the
 * evidence for an application silently drift after the fact.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';

/** What the JD says about sponsoring a work visa. `silent` is a FIRST-CLASS
 *  value, not a missing one: ADR 0540 D5 makes "the posting did not mention it"
 *  explicitly NOT a disqualifier, and collapsing it into `not-offered` would
 *  turn silence into a rejection. */
export type SponsorshipStance = 'offered' | 'not-offered' | 'silent';

/** Employment shape. `1099`/contract is NEVER a skip on its own (D5). */
export type EmploymentType = 'w2' | '1099' | 'contract' | 'internship' | 'unknown';

export interface JobDigest {
  /** The CRM deal this describes — the digest's identity. */
  dealId: string;
  tenantId: string;
  /** Monotonic per deal. A new parse appends; it never overwrites. */
  version: number;
  title: string;
  companyName: string;
  location: string | null;
  remote: boolean | null;
  skills: string[];
  requirements: string[];
  responsibilities: string[];
  descriptionExcerpt: string;
  employmentType: EmploymentType;
  /** Sponsorship stance AS STATED. See `SponsorshipStance` on why `silent` matters. */
  sponsorship: SponsorshipStance;
  /** A JD-stated citizenship bar, quoted VERBATIM, or null when unstated. The
   *  quote is kept because D5 requires a disqualification to cite the posting
   *  rather than paraphrase it. */
  citizenshipRequirementQuote: string | null;
  /** A JD-stated clearance bar, quoted verbatim, or null when unstated. */
  clearanceRequirementQuote: string | null;
  /** The verbatim sentence stating no sponsorship, when `sponsorship` is `not-offered`. */
  sponsorshipQuote: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  sourceUrl: string | null;
  capturedAt: string;
}

/** Keyed by `<tenantId>:<dealId>:<version>` so a version is addressable and a
 *  tenant's rows are a bounded prefix scan rather than a cross-tenant scan. */
export const jobDigests = new DurableCollection<JobDigest>(
  'job-search:digest',
  (d) => `${d.tenantId}:${d.dealId}:${d.version}`,
  undefined,
  (d) => d.tenantId,
);

// JS-DATA-5 (resolved-by-doctrine + retention). A digest is a parsed JOB
// POSTING attached to a tenant deal — a business record about the job, not
// personal data of the applicant, so it follows CRM's deliberate
// retention-only erasure posture (`contactsService.ts` — a record about a
// person is the TENANT's business record) rather than a subject eraser: the
// row carries no subject, a subject eraser would have to guess via joins, and
// in a shared workspace it would destroy another member's live deal data.
// What a digest DOES get: it dies with its deal (the JS-RI-1 cascade,
// `lifecycle/crmCascade.ts`) and ages out here — closing its row in the
// assessment's UNBOUNDED retention table.
registerRetentionPurger({
  feature: 'job-search:digest',
  purge: async (tenantId, classification, cutoffIso) =>
    classification !== 'internal' ? 0 : purgeRowsByAge(
      'job-search:digest',
      await jobDigests.listForTenantIndexed(tenantId),
      tenantId,
      cutoffIso,
      (d) => ({ tenantId: d.tenantId, updatedAt: d.capturedAt, id: `${d.tenantId}:${d.dealId}:${d.version}` }),
      (id) => jobDigests.delete(id),
    ),
});
