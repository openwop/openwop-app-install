/**
 * ADR 0542 D2/P1 — a job listing is a KERNEL entity, not a bespoke table.
 *
 * `job.listing` is a system-type façade over the `entities` kernel, the same
 * shape ADR 0409/0410 gave company/deal/product and cms.page. Scalars ride the
 * typed `values` seam; the structured remainder rides `ext`, which the kernel
 * stores blind for the owning feature — the same split the ADR 0540 D2 digest
 * decision made, for the same reason.
 *
 * ## Why not our own store (architect review, before implementation)
 *
 * The kernel's `recordKey` is `${typeId}|${entityId}` and `typeId` embeds the
 * tenant, so a tenant FOLD rewrites the row's content `tenantId` without
 * rewriting its key — the known fold-orphan class. That exposure is inherited,
 * not introduced: every existing system-type façade has it. Standing up a
 * private listing store to dodge it would trade one known, shared, fixable
 * problem for a second content system that drifts from the kernel — which is
 * the outcome the boundaries audit exists to prevent. So: use the seam, and
 * record the exposure where the next person will find it.
 *
 * ## Dedupe is structural, not a cleanup job
 *
 * `entityId` is a CONTENT hash. The same posting syndicated to two boards
 * normalises to the same id, so the second write is an idempotent no-op at the
 * store rather than a duplicate somebody reconciles later (ADR 0162's
 * deterministic-id rule). The hash deliberately excludes the board, the URL and
 * the capture time — all of which differ across boards for one job.
 */
import { createHash } from 'node:crypto';
import { mintSystemType, putSystemEntity, getSystemEntity, listSystemEntities, updateEntityType, getEntityType } from '../../entities/entitiesService.js';
import { screenPostingText, type SkipReason } from './screening.js';

export const LISTING_TYPE = 'job.listing';

/** The scalar fields the kernel validates. Everything structured goes to `ext`. */
const LISTING_FIELDS = [
  { key: 'title', label: 'Title', type: 'string', required: true },
  { key: 'company_name', label: 'Company', type: 'string', required: true },
  { key: 'location', label: 'Location', type: 'string', required: false },
  { key: 'remote', label: 'Remote', type: 'boolean', required: false },
  { key: 'source_board', label: 'Source board', type: 'string', required: false },
  { key: 'source_url', label: 'Source URL', type: 'string', required: false },
];

export interface ListingInput {
  title: string;
  companyName: string;
  location?: string | null;
  remote?: boolean | null;
  /** Which board this copy came from. NOT part of the identity. */
  sourceBoard?: string;
  sourceUrl?: string;
  /** Structured remainder — skills, requirements, the raw excerpt. */
  ext?: Record<string, unknown>;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    // Strip diacritics and collapse punctuation/whitespace, so "Sr. Engineer"
    // and "Senior Engineer  " do not become two jobs. Cheap, and the failure
    // mode of under-normalising (a duplicate) is the one users notice.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The content-derived stable id.
 *
 * Deliberately EXCLUDES `sourceBoard`, `sourceUrl` and any timestamp: those are
 * properties of a COPY of the posting, not of the job, and including any of them
 * would defeat the cross-board dedupe this exists for.
 */
export function listingIdFor(input: Pick<ListingInput, 'title' | 'companyName' | 'location'>): string {
  const basis = [norm(input.title), norm(input.companyName), norm(input.location ?? '')].join(' ');
  return `job-${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

/** Idempotent: mints the system type once per tenant (CAS inside the kernel). */
export async function ensureListingType(tenantId: string, actor: string) {
  return mintSystemType({
    tenantId,
    name: LISTING_TYPE,
    displayName: 'Job listing',
    description: 'A job posting, deduped across boards by content (ADR 0542 D2).',
    fields: LISTING_FIELDS,
    actor,
  });
}

export interface UpsertResult {
  listingId: string | null;
  /** False when an identical listing already existed — the dedupe hit. */
  created: boolean;
  /** ADR 0542 D3 — set when the posting was SKIPPED. A skip is always
   *  attributable: an unexplained one is indistinguishable from a job that was
   *  never found, which is the failure mode that erodes trust in an autonomous
   *  product. */
  skipped?: { reason: SkipReason; evidence: string | null };
}

/**
 * Record a listing. The SECOND board offering the same job is a no-op.
 *
 * Dedupe is guaranteed by the KEY, not by a compare-and-swap. `entityId` is a
 * content hash, and the kernel keys a row `${typeId}|${entityId}`, so two boards
 * describing one job address the same row by construction — a duplicate is
 * unrepresentable rather than merely unlikely, and two writers racing simply
 * write identical content to the same place.
 *
 * (An earlier draft used `casSystemEntity` with an absent expectation. That is
 * an UPDATE-CAS: it returns null when no row exists, so it could never create
 * one. The key-based argument above is the stronger property anyway.)
 */
export async function upsertListing(tenantId: string, actor: string, input: ListingInput): Promise<UpsertResult> {
  // ADR 0542 D3 — screen BEFORE the row exists. Storing hostile text and fencing
  // it later would leave it in the tenant's data and in every projection built
  // over it; the campaign continues either way, which is the point.
  const screen = screenPostingText(
    input.title,
    typeof input.ext?.descriptionExcerpt === 'string' ? input.ext.descriptionExcerpt : null,
    ...(Array.isArray(input.ext?.requirements) ? (input.ext.requirements as string[]) : []),
    ...(Array.isArray(input.ext?.responsibilities) ? (input.ext.responsibilities as string[]) : []),
  );
  if (!screen.ok && screen.reason) {
    return { listingId: null, created: false, skipped: { reason: screen.reason, evidence: screen.evidence } };
  }

  await ensureListingType(tenantId, actor);
  const listingId = listingIdFor(input);

  const existing = await getSystemEntity(tenantId, LISTING_TYPE, listingId);
  if (existing) return { listingId, created: false };

  await putSystemEntity({
    tenantId,
    typeName: LISTING_TYPE,
    entityId: listingId,
    values: {
      title: input.title,
      company_name: input.companyName,
      ...(input.location != null ? { location: input.location } : {}),
      ...(input.remote != null ? { remote: input.remote } : {}),
      ...(input.sourceBoard ? { source_board: input.sourceBoard } : {}),
      ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
    },
    ...(input.ext ? { ext: input.ext } : {}),
    actor,
  });
  return { listingId, created: true };
}

export async function listListings(tenantId: string) {
  return listSystemEntities(tenantId, LISTING_TYPE);
}

export async function getListing(tenantId: string, listingId: string) {
  return getSystemEntity(tenantId, LISTING_TYPE, listingId);
}


/**
 * ADR 0542 D4 — publishing is a deliberate, gated act.
 *
 * Listings are tenant-private by DEFAULT: `ensureListingType` mints the type
 * without `publicRead`, so a scrape never becomes another tenant's public
 * content by accident. Publishing flips `publicRead` on the TYPE through the
 * entities kernel's own gate — no second published-flag, no new public route.
 * The kernel already serves `public-entities` with tenant derived from the
 * RESOURCE rather than the request, which is exactly D4's requirement.
 */
export async function setListingsPublic(tenantId: string, publicRead: boolean, actor: string): Promise<boolean> {
  const updated = await updateEntityType({
    tenantId,
    name: LISTING_TYPE,
    patch: { publicRead },
    actor,
  });
  return updated !== null;
}

/** Are this tenant's listings publicly readable? Defaults to false. */
export async function listingsArePublic(tenantId: string): Promise<boolean> {
  const type = await getEntityType(tenantId, undefined, LISTING_TYPE);
  return type?.publicRead === true;
}
