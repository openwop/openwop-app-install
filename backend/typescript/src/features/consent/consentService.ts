/**
 * Consent & Compliance service (host-extension, ADR 0020) — the GOVERN leg. A
 * tenant-scoped, region-aware consent store + the ONE centralized enforcement
 * helper (`isAllowed`) that Analytics (0018) + Email (0019) call — a single consent
 * rule, never per-feature copies (the Sharing-registry lesson). Permissive
 * when the `consent` toggle is off (honest opt-in).
 *
 * R2 CN-SP-2 — `regulatedRegions` is DECLARATIVE ONLY: no enforcement path
 * reads it (subjects carry no region data to match against). Enforcement
 * rides `defaultMode` + per-record categories. The old "fail-closed in
 * regulated regions" claim here was false; the editor now discloses the
 * field's informational role.
 */

import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { eraseSubject, type SubjectErasureResult } from '../../host/subjectErasure.js';
import { onCrmRecordMerged } from '../../host/crmRecordLifecycle.js';
import { recordGovernanceDecision } from '../../host/governanceDecisionLog.js';
import { getRetentionHold, RetentionHoldError } from '../../host/retentionHold.js';
import { appendAudit, AUDIT_KIND_CONSENT_CHANGE } from '../../host/auditChainService.js';
import { createLogger } from '../../observability/logger.js';
import { assertPurposesAtCapture } from '../cdp/purposeVocabService.js';

const log = createLogger('feature.consent');

/** Per-channel marketing specifics (ADR 0227) — OPTIONAL keys layered over the
 *  `marketing` umbrella. Old records simply lack them (see `isAllowed`). */
export type MarketingChannel = 'email' | 'sms' | 'push' | 'whatsapp';
export const MARKETING_CHANNELS: readonly MarketingChannel[] = ['email', 'sms', 'push', 'whatsapp'];
export type MarketingChannelCategory = `marketing.${MarketingChannel}`;

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing' | MarketingChannelCategory;
export const CONSENT_CATEGORIES: readonly ConsentCategory[] = [
  'necessary', 'analytics', 'marketing', 'marketing.email', 'marketing.sms', 'marketing.push', 'marketing.whatsapp',
];

function isMarketingChannelCategory(category: ConsentCategory): category is MarketingChannelCategory {
  return category === 'marketing.email' || category === 'marketing.sms' || category === 'marketing.push' || category === 'marketing.whatsapp';
}

/**
 * ADR 0394 — categories Meta's Business Solution Terms require EXPLICIT per-number
 * opt-in for: the umbrella `marketing:true` grant, the tenant's `opt-out` default
 * mode, and the consent-toggle-off permissive escape must NEVER permit them. The
 * single `isAllowed` evaluator honors this set (no second evaluator).
 */
export const STRICT_EXPLICIT_OPT_IN: ReadonlySet<ConsentCategory> = new Set(['marketing.whatsapp']);

/** Stored shape stays BACKWARD-COMPATIBLE (ADR 0227): the three base keys are
 *  always present; the per-channel specifics are optional — a record written
 *  before ADR 0227 has none, and the `marketing` umbrella governs it. */
export interface ConsentCategories {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  'marketing.email'?: boolean;
  'marketing.sms'?: boolean;
  'marketing.push'?: boolean;
  /** ADR 0394 — WhatsApp requires an EXPLICIT true (never umbrella-derived). */
  'marketing.whatsapp'?: boolean;
}

/** GDPR Art. 6 lawful bases (ADR 0268 / CDP-F) — additive; recorded for audit, not
 *  yet an enforcement input (consent categories remain the gate). */
export type LegalBasis = 'consent' | 'contract' | 'legal-obligation' | 'vital-interest' | 'public-task' | 'legitimate-interest';

export interface ConsentRecord {
  tenantId: string;
  subjectKey: string;   // opaque, non-PII (an anon cookie id or User.userId)
  region?: string;
  categories: ConsentCategories;
  source: string;
  ts: string;
  expiresAt?: string;
  /** ADR 0268 — the lawful basis asserted for this consent (additive). */
  legalBasis?: LegalBasis;
  /** ADR 0302 — the OPAQUE permitted-purpose codes captured with this consent
   *  (additive; old records lack it). Stored verbatim — never re-validated on read,
   *  so a retro-stored label survives a later vocabulary/strict change unchanged. */
  purposes?: readonly string[];
}

/** A business PURPOSE (ADR 0268 / CDP-F) — the "permitted downstream use" a
 *  segment/sync/API artifact declares. Each maps to the ONE consent category it
 *  requires, so `isPermittedForPurpose` reuses the single `isAllowed` chokepoint
 *  (never a second evaluator). */
export type Purpose = 'transactional' | 'analytics' | 'personalization' | 'marketing-email' | 'marketing-sms' | 'marketing-push' | 'marketing-whatsapp' | 'advertising';
const PURPOSES: readonly Purpose[] = ['transactional', 'analytics', 'personalization', 'marketing-email', 'marketing-sms', 'marketing-push', 'marketing-whatsapp', 'advertising'];
const PURPOSE_TO_CATEGORY: Record<Purpose, ConsentCategory> = {
  transactional: 'necessary',
  analytics: 'analytics',
  personalization: 'marketing',
  'marketing-email': 'marketing.email',
  'marketing-sms': 'marketing.sms',
  'marketing-push': 'marketing.push',
  'marketing-whatsapp': 'marketing.whatsapp', // ADR 0394 — strict explicit opt-in (see STRICT_EXPLICIT_OPT_IN)
  advertising: 'marketing', // ad-audience targeting rides the broad marketing grant (ADR 0227, audienceService)
};
export function isPurpose(v: string): v is Purpose {
  return (PURPOSES as readonly string[]).includes(v);
}

export type DefaultMode = 'opt-in' | 'opt-out';
export interface ConsentPolicy { tenantId: string; regulatedRegions: string[]; defaultMode: DefaultMode }

const records = new DurableCollection<ConsentRecord>('consent:record', (r) => `${r.tenantId}:${r.subjectKey}`);
const policies = new DurableCollection<ConsentPolicy>('consent:policy', (p) => p.tenantId);

/**
 * CONS-1 — the ERASURE TOMBSTONE, and why it is a hash rather than a record.
 *
 * `deleteSubject` deletes the subject's `consent:record`. `isAllowed` with no
 * record falls through to `policy.defaultMode === 'opt-out'`, so on an opt-out
 * tenant a GDPR erasure used to flip `analytics` / `marketing` / `marketing.sms`
 * / `marketing.push` from DENY to ALLOW — the deletion was a GRANT. (Email
 * survived only incidentally, because CRM deliberately retains `crm:suppression`
 * — `features/crm/erasure.ts:196-206`; WhatsApp only because
 * `STRICT_EXPLICIT_OPT_IN` short-circuits.) The erased subject cannot re-opt-out,
 * so the failure is unrecoverable.
 *
 * OPTIONS WEIGHED, and why this one:
 *
 *  (a) Deny-by-default — drop the `opt-out` fallback entirely. Rejected: it
 *      changes the verdict for every subject who never consented, which is a
 *      different (and legitimate) operator posture, not a bug.
 *  (b) Write a terminal all-false `consent:record` instead of deleting.
 *      Rejected: the row is keyed `${tenantId}:${subjectKey}`, so the subject's
 *      raw identifier — since ADR 0394 possibly a raw E.164 phone number —
 *      SURVIVES the erasure inside the store the erasure is supposed to clear.
 *      A tombstone that re-identifies the subject defeats the erasure.
 *  (c) THIS — a separate, deliberately PII-free tombstone keyed by the
 *      TENANT-SALTED SHA-256 of the subject key (`tombstoneId`). The hash is
 *      derivable from `(tenantId, subjectKey)` at check time, so `isAllowed` can
 *      answer "this subject was erased ⇒ deny" without the store ever holding
 *      the key. Same pseudonymisation primitive the governance rows already use
 *      (`hashSubjectKey`), so the two agree.
 *
 * Lawful basis for keeping anything at all: Art. 17(3) / Recital 65 — an
 * operator may retain the minimum needed to keep honouring the erasure/objection
 * itself. `crm:suppression` is the same argument, already accepted in this repo;
 * this row keeps strictly LESS than that one does.
 *
 * RESIDUAL, stated rather than implied: a SHA-256 over a low-entropy identifier
 * (an E.164 number) is dictionary-reversible by someone who already holds the
 * store, because the salt is the tenantId and is not secret. It is a
 * re-identification cost, not a re-identification barrier. A keyed HMAC would
 * close that, but the only host secret available (`readSessionSecret`) is
 * rotatable and ephemeral in dev, so a rotation would silently drop every
 * tombstone and fail OPEN — the exact direction this fix exists to prevent.
 *
 * Over-restriction is deliberate: erasing a subject who never recorded anything
 * still tombstones them, because an erasure request IS an objection to
 * processing. It is per-subject, so a subject who never asked for anything is
 * untouched — that is the second arm the tests assert.
 */
interface ConsentErasureTombstone {
  tenantId: string;
  /** Tenant-salted SHA-256 of the erased subject key — NEVER the key itself. */
  subjectHash: string;
  erasedAt: string;
  /** ADR 0657 D7 — the DSAR group(s) this tombstone belongs to: `tombstoneId(tenantId,
   *  requestedKey)` of every erasure request that wrote it (hash→hash, no PII). Readmit
   *  reverses a whole group — the requested key's forms AND every ADR 0381-resolved key,
   *  which the resolvers can no longer recover once the ident rows are gone. */
  dsarHashes?: string[];
}
const tombstones = new DurableCollection<ConsentErasureTombstone>(
  'consent:erasure-tombstone',
  (t) => `${t.tenantId}:${t.subjectHash}`,
  undefined,
  (t) => t.tenantId,
);

function normCategories(input: unknown): ConsentCategories {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: ConsentCategories = { necessary: true, analytics: c.analytics === true, marketing: c.marketing === true };
  // Per-channel specifics (ADR 0227): stored ONLY when the caller sent an
  // explicit boolean — an absent specific means "the umbrella governs", and
  // that absence is meaningful, so it is never defaulted in.
  for (const ch of MARKETING_CHANNELS) {
    const key = `marketing.${ch}` as const;
    const v = c[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/**
 * Upsert a visitor's consent (latest-wins per tenant+subject).
 *
 * ADR 0302 — when the caller supplies OPAQUE permitted-purpose codes, they run
 * through the CAPTURE hook (`assertPurposesAtCapture`), which fails closed (400)
 * ONLY when the tenant opted into strict-purpose mode and a code is unknown. In the
 * default (non-strict) mode capture is fail-open: unknown codes are accepted and
 * stored verbatim. The stored codes are never re-validated on read/egress, so the
 * RFC 0128 opaque-string contract is untouched.
 */
/** CONS-18 — a bound on the subject key. It was passed through `requireString`
 *  only: no length cap and no emptiness check, so any writer could mint an
 *  unbounded row key in a collection with no age-out. Generous enough for every
 *  real shape (a UUID, a `crm:`-prefixed contactId, an email, an E.164 number)
 *  and small enough that a key cannot become a payload. Deliberately NOT a
 *  charset restriction: `:` is the store's own separator but is also legitimate
 *  inside real keys (`crm:`, `user:`, `visitor:`), and tenant ids carry `ws:` /
 *  `anon:` prefixes — a naive ban would break live data. */
const MAX_SUBJECT_KEY_LENGTH = 256;
function assertSubjectKey(subjectKey: string): void {
  if (!subjectKey || !subjectKey.trim()) {
    throw new OpenwopError('validation_error', 'Field `subjectKey` must be a non-empty string.', 400, { field: 'subjectKey' });
  }
  if (subjectKey.length > MAX_SUBJECT_KEY_LENGTH) {
    throw new OpenwopError('validation_error', `Field \`subjectKey\` must be at most ${MAX_SUBJECT_KEY_LENGTH} characters.`, 400, { field: 'subjectKey' });
  }
}

export async function recordConsent(input: { tenantId: string; subjectKey: string; categories: unknown; region?: string; source: string; legalBasis?: LegalBasis; purposes?: readonly string[];
  /** CONS-28 — set ONLY by `mergeConsentCategories`' retries-exhausted fallthrough: the
   *  caller-supplied purposes were asserted at merge entry, and STORED purposes are never
   *  re-validated on a write (the contract at the top of this file) — so a revocation cannot
   *  400 on the rare path after an operator removed a code. */
  purposesAsserted?: boolean }): Promise<ConsentRecord> {
  assertSubjectKey(input.subjectKey);
  if (input.purposes !== undefined && !input.purposesAsserted) await assertPurposesAtCapture(input.tenantId, input.purposes); // fail-closed only in strict mode
  await assertNotErased(input.tenantId, input.subjectKey); // D10
  const rec: ConsentRecord = {
    tenantId: input.tenantId,
    subjectKey: input.subjectKey,
    categories: normCategories(input.categories),
    source: input.source,
    ts: new Date().toISOString(),
    ...(input.region ? { region: input.region } : {}),
    ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}),
    ...(input.purposes !== undefined ? { purposes: [...input.purposes] } : {}),
  };
  await records.put(rec);
  // D10 post-write re-check: a DSAR that tombstoned between the barrier and the put
  // deletes the record AFTER writing the tombstone, so if we see the tombstone now the
  // DSAR's delete may already have run — remove what we just wrote and refuse.
  if (await isErasureTombstoned(rec.tenantId, rec.subjectKey)) {
    await records.delete(`${rec.tenantId}:${rec.subjectKey}`);
    await assertNotErased(rec.tenantId, rec.subjectKey);
  }
  // CONS-1's "symmetric half" (clear the tombstone on an affirmative write) is RETIRED
  // (ADR 0657 D7/D10): re-admission is an attested operator act — `readmitSubject` is the
  // only clearer. A write never clears, and never lands while the tombstone stands.
  // ADR 0301 / CDP-F — append the consent change to the tamper-evident hash-chain
  // (best-effort: an audit-chain failure must never break recording consent).
  try {
    await appendAudit(rec.tenantId, AUDIT_KIND_CONSENT_CHANGE, {
      // ADR 0657 D11 (CONS-26) — the chain is DSAR-exempt, un-redactable and exportable:
      // never the raw key (an E.164 since ADR 0394); the hash keeps cross-row correlation.
      subjectHash: hashSubjectKey(rec.tenantId, rec.subjectKey),
      categories: rec.categories,
      source: rec.source,
      ...(rec.region ? { region: rec.region } : {}),
      ...(rec.legalBasis ? { legalBasis: rec.legalBasis } : {}),
    });
  } catch (err) {
    log.warn('audit_chain_append_failed', { tenantId: rec.tenantId, kind: AUDIT_KIND_CONSENT_CHANGE, error: String(err) });
  }
  return rec;
}

/**
 * Purpose-based permitted-use check (ADR 0268 / CDP-F) — the single seam an
 * egress path calls to ask "may I use this subject's data for PURPOSE?". Resolves
 * the purpose to its required consent category and defers to the ONE `isAllowed`
 * chokepoint. Fails closed on an unknown purpose. NOT a second evaluator — a thin
 * purpose→category adapter over existing consent enforcement.
 */
export async function isPermittedForPurpose(tenantId: string, subjectKey: string, purpose: string): Promise<boolean> {
  if (!isPurpose(purpose)) return false; // fail closed on an unknown purpose
  return isAllowed(tenantId, subjectKey, PURPOSE_TO_CATEGORY[purpose]);
}

export async function getConsent(tenantId: string, subjectKey: string): Promise<ConsentRecord | null> {
  return records.get(`${tenantId}:${subjectKey}`);
}

/**
 * The subset of `categories` a caller EXPLICITLY spoke to.
 *
 * CONS-3 — this is the difference between a partial update and a wholesale
 * overwrite, and the reason a form EMAIL opt-in used to grant SMS and PUSH:
 * `recordConsent` normalises an absent specific away, `isAllowed` then falls
 * back to the `marketing` umbrella when a specific is absent, so a dropped
 * `marketing.sms: false` silently became ALLOW. An absent key must stay absent
 * all the way into `mergeConsentCategories`, where the STORED value governs.
 */
export function partialCategories(input: unknown): Partial<ConsentCategories> {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: Partial<ConsentCategories> = {};
  if (typeof c.analytics === 'boolean') out.analytics = c.analytics;
  if (typeof c.marketing === 'boolean') out.marketing = c.marketing;
  for (const ch of MARKETING_CHANNELS) {
    const key = `marketing.${ch}` as const;
    const v = c[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/**
 * Review F4 — the category shape a FULL marketing opt-out must write.
 *
 * This exists because moving the unsubscribe lanes off the wholesale
 * `recordConsent` onto `mergeConsentCategories` introduces a trap that the
 * wholesale write did not have. `isAllowed` resolves a channel as
 * `typeof specific === 'boolean' ? specific : umbrella`, so a merged
 * `{ marketing: false }` leaves a STORED `marketing.email: true` standing and
 * still answers ALLOW — a one-click unsubscribe that does not unsubscribe.
 * Replace-semantics hid that by dropping every specific; merge-semantics must
 * say it out loud.
 *
 * DERIVED from `MARKETING_CHANNELS`, never hand-listed: the whole reason CONS-3
 * existed is that an omitted channel reads as a grant, so a channel added later
 * must be covered automatically rather than by remembering this call site.
 */
export function fullMarketingOptOut(): Partial<ConsentCategories> {
  const out: Partial<ConsentCategories> = { marketing: false };
  for (const ch of MARKETING_CHANNELS) out[`marketing.${ch}`] = false;
  return out;
}

/**
 * GRADE-DATA 2026-07-17 (ADR 0394 keyword ladder) — CAS-merge a PARTIAL
 * category update into the subject's record so a STOP/START keyword can never
 * be silently overwritten by a racing consent write (recordConsent is
 * latest-wins by design; a compliance revocation must not lose that race).
 * Stays inside the ONE consent owner — callers never touch the store.
 *
 * CONS-3 — this is now the DEFAULT write path, not the WhatsApp special case.
 * `region` / `legalBasis` / `purposes` are additive: a caller that supplies one
 * updates it, a caller that does not keeps whatever the record already carried
 * (previously only the stored value survived, which made this unusable for the
 * public capture lane and is why that lane kept using the wholesale write).
 */
export async function mergeConsentCategories(input: {
  tenantId: string;
  subjectKey: string;
  categories: Partial<ConsentCategories>;
  source: string;
  region?: string;
  legalBasis?: LegalBasis;
  purposes?: readonly string[];
}): Promise<ConsentRecord> {
  assertSubjectKey(input.subjectKey); // CONS-18 — the merge lane is a write path too
  if (input.purposes !== undefined) await assertPurposesAtCapture(input.tenantId, input.purposes); // fail-closed only in strict mode
  await assertNotErased(input.tenantId, input.subjectKey); // D10 — the barrier, at entry
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await records.get(`${input.tenantId}:${input.subjectKey}`);
    // D10 — a null read on a retry is exactly the DSAR interleaving (CONS-25): re-check
    // the barrier before a swap that would RE-INSERT the record after its erasure.
    if (cur === null && attempt > 0) await assertNotErased(input.tenantId, input.subjectKey);
    const region = input.region ?? cur?.region;
    const legalBasis = input.legalBasis ?? cur?.legalBasis;
    const purposes = input.purposes ?? cur?.purposes;
    const rec: ConsentRecord = {
      tenantId: input.tenantId,
      subjectKey: input.subjectKey,
      categories: normCategories({ ...(cur?.categories ?? {}), ...input.categories }),
      source: input.source,
      ts: new Date().toISOString(),
      ...(region ? { region } : {}),
      ...(legalBasis ? { legalBasis } : {}),
      ...(purposes !== undefined ? { purposes: [...purposes] } : {}),
    };
    if (await records.compareAndSwap(cur ?? null, rec)) {
      if (await isErasureTombstoned(rec.tenantId, rec.subjectKey)) { // D10 post-swap re-check
        await records.delete(`${rec.tenantId}:${rec.subjectKey}`);
        await assertNotErased(rec.tenantId, rec.subjectKey);
      }
      try {
        await appendAudit(rec.tenantId, AUDIT_KIND_CONSENT_CHANGE, {
          subjectHash: hashSubjectKey(rec.tenantId, rec.subjectKey), categories: rec.categories, source: rec.source, // D11 — never the raw key
        });
      } catch { /* best-effort — audit-chain failure never breaks recording */ }
      return rec;
    }
  }
  // Exhausted retries under pathological contention: fall through to the
  // latest-wins path rather than dropping the compliance write entirely. It
  // still merges over the freshest read, so no specific is DROPPED — only a
  // concurrent writer's newer value can be lost, which is the trade the CAS
  // exists to minimise and cannot eliminate.
  const cur = await records.get(`${input.tenantId}:${input.subjectKey}`);
  return recordConsent({
    tenantId: input.tenantId,
    subjectKey: input.subjectKey,
    categories: normCategories({ ...(cur?.categories ?? {}), ...input.categories }),
    source: input.source,
    ...(input.region ?? cur?.region ? { region: (input.region ?? cur?.region)! } : {}),
    ...(input.legalBasis ?? cur?.legalBasis ? { legalBasis: (input.legalBasis ?? cur?.legalBasis)! } : {}),
    ...(input.purposes ?? cur?.purposes ? { purposes: [...(input.purposes ?? cur!.purposes!)] } : {}),
    // Review F8 — carry the flag across the fallthrough, or a non-consent write
    // would clear the tombstone under contention and not on the fast path.
    purposesAsserted: true, // CONS-28 — asserted at entry; stored purposes are never re-validated
  });
}

/**
 * CRM-5 — a CRM contact merge must never lose an opt-out.
 *
 * `consent:record` is keyed `${tenantId}:${subjectKey}` and CRM passes the
 * contactId as the subject key. A merge tombstones the source contact and
 * ABSORBS its email onto the survivor's identifier set, so after the merge the
 * survivor is reachable at an address whose owner may have opted out — while the
 * opt-out record still sits under the tombstoned contactId, which no enforcement
 * path ever consults again. That is a recorded revocation silently becoming a
 * send.
 *
 * The rule is MOST-RESTRICTIVE-WINS, per category, not latest-wins. A merge is a
 * bookkeeping operation performed by an operator; it is not evidence that anyone
 * changed their mind, so it must never UPGRADE a permission. Concretely: `false`
 * on either side ⇒ `false` on the survivor; a category only stays `true` when both
 * sides say `true` (or the survivor says `true` and the source never spoke to it).
 *
 * `necessary` is exempt — it is `true` by definition (`isAllowed` short-circuits
 * on it), so folding it would be meaningless.
 *
 * The source row is deliberately LEFT IN PLACE. Deleting it was the first draft,
 * on the reasoning that a consent record under a tombstoned id is unreachable —
 * but a contact merge is REVERSIBLE (`unmergeContacts` restores the source as a
 * live contact), so deleting the source's record would have destroyed a
 * revocation that an unmerge then had no way to bring back. Fixing a lost opt-out
 * by losing a different opt-out is the shape this whole finding is about.
 *
 * The residual, stated rather than hidden: after an unmerge the survivor keeps the
 * restriction it absorbed even though it has shed the source's identifier. That is
 * over-restrictive, which is the safe direction for consent and is recoverable by
 * the subject re-opting in through a consent-bearing flow.
 *
 * Idempotent: re-running recomputes the same intersection, and nothing is deleted.
 */
export async function foldConsentOnMerge(tenantId: string, sourceKey: string, survivorKey: string): Promise<boolean> {
  if (!tenantId || !sourceKey || !survivorKey || sourceKey === survivorKey) return false;
  const source = await records.get(`${tenantId}:${sourceKey}`);
  if (!source) return false;

  const restrictive: Partial<ConsentCategories> = {};
  for (const category of CONSENT_CATEGORIES) {
    if (category === 'necessary') continue;
    const sourceSays = source.categories[category];
    // An ABSENT per-channel specific means "the umbrella governs" and that
    // absence is meaningful (see `normCategories`) — never fold it in as `false`,
    // which would silently narrow the survivor on a channel the source never
    // spoke to.
    if (typeof sourceSays !== 'boolean') continue;
    if (sourceSays === false) restrictive[category] = false;
  }
  if (Object.keys(restrictive).length === 0) return false;
  // Review F8 — a merge is an OPERATOR's bookkeeping act, not the subject
  // changing their mind, so it must not clear their erasure tombstone. It can
  // never GRANT (it only ever writes `false`), but the tombstone is the marker
  // `isAllowed`'s no-record branch denies on — erasing it means a later state
  // with no record falls back to the permissive policy default. Same reasoning
  // as MOST-RESTRICTIVE-WINS above: a bookkeeping operation may narrow a
  // permission, never widen one.
  try {
    await mergeConsentCategories({
      tenantId, subjectKey: survivorKey, categories: restrictive,
      source: `crm-merge:${sourceKey}`,
    });
  } catch (err) {
    // ADR 0657 D10 — the survivor is ERASED: the barrier refuses the write, the tombstone
    // stands (it already denies everything), and the merge is not an error.
    if ((err as { code?: string }).code === 'subject_erased') return false;
    throw err;
  }
  return true;
}

// Registered at module load, keyed, so a repeated boot overwrites the same slot.
onCrmRecordMerged('consent-crm-merge', async ({ tenantId, entity, sourceId, survivorId }) => {
  if (entity !== 'contact') return; // only contacts are consent subjects
  await foldConsentOnMerge(tenantId, sourceId, survivorId);
});

/**
 * CONS-9 — a BOUNDED per-tenant read.
 *
 * This was `records.list()` — a full-collection scan across EVERY tenant —
 * followed by an in-memory filter, on a compliance surface whose collection
 * grows with every visitor. The id shape is `${tenantId}:${subjectKey}`, so a
 * storage-level prefix scan is available and needs no secondary index and no
 * migration. The `r.tenantId === tenantId` filter is KEPT as a belt-and-braces
 * check: a tenant id is caller-influenced in places (`ws:`/`anon:` prefixes
 * contain `:`), so `ws:acme` must never be able to read `ws:acme-corp`'s rows
 * by prefix.
 */
export async function listConsent(tenantId: string): Promise<ConsentRecord[]> {
  if (!tenantId) return []; // fail-closed — never an ambiguous-tenant scan
  const rows = await records.listByPrefix(`${tenantId}:`);
  return rows.filter((r) => r.tenantId === tenantId).sort((a, b) => b.ts.localeCompare(a.ts));
}

export async function getPolicy(tenantId: string): Promise<ConsentPolicy | null> {
  return policies.get(tenantId);
}

export async function setPolicy(tenantId: string, input: { regulatedRegions?: string[]; defaultMode?: DefaultMode }): Promise<ConsentPolicy> {
  const existing = await policies.get(tenantId);
  const policy: ConsentPolicy = {
    tenantId,
    regulatedRegions: input.regulatedRegions ?? existing?.regulatedRegions ?? [],
    defaultMode: input.defaultMode ?? existing?.defaultMode ?? 'opt-in',
  };
  await policies.put(policy);
  return policy;
}

/**
 * Data-subject (GDPR) erasure over a subjectKey — deletes the consent record AND
 * fans out to every registered feature eraser (Analytics events, …) via the
 * subject-erasure seam, so the "delete" reaches ALL of the subject's data, not
 * just consent. Idempotent: erasing a subject with no consent record still purges
 * downstream data. Returns whether a consent record existed.
 *
 * CONS-G1 (docs/steward/UX_UPGRADE-consent.md) — and the OUTCOME of the fan-out. `eraseSubject`
 * has always returned `{ total, failed, keysResolved }` (its docblock describes the
 * shape in terms of "the caller's `failed > 0` reaction"), and this caller used to
 * discard it, so a partially-failed GDPR erasure was indistinguishable from a clean
 * one all the way up to a green toast. `failed > 0` means the subject's data is
 * still present in that many feature stores; the operator has to be able to see
 * that, because under Art. 5(2) they must be able to demonstrate the erasure.
 */
/** Pseudonymous subject reference for audit rows — TENANT-SALTED exactly
 *  like the subjectKeyHash pattern below (review F3: an unsalted hash split
 *  the subject's audit trail from its consent-change rows AND made identical
 *  keys linkable across tenants in the host-global stream). Never the raw key. */
export function hashSubjectKey(tenantId: string, subjectKey: string): string {
  return createHash('sha256').update(`${tenantId}:${subjectKey}`).digest('hex').slice(0, 16);
}

/** CONS-1 — the tombstone's row id component. FULL digest, not `hashSubjectKey`'s
 *  16-char audit-field truncation: this one is a lookup key, and a truncation
 *  collision would deny an unrelated subject (over-erasure of a permission is
 *  the one direction that is not obviously safe). */
export function tombstoneId(tenantId: string, subjectKey: string): string {
  return createHash('sha256').update(`${tenantId}:${subjectKey}`).digest('hex');
}

/** ADR 0655 D1 — the key FORMS a tombstone is written and read under. A DSAR names
 *  the subject as the operator typed it (`Erased@X.test`); every egress path folds
 *  addresses (trim + lowercase, the `crm/suppressionService` `normalizeEmail` rule —
 *  duplicated here rather than imported: crm depends on consent, not the reverse).
 *  Writing BOTH forms keeps the hash-only store (no key retained) while letting a
 *  folded lookup hit. Non-email subjects have one form. */
/** The forms a subject key is tombstoned (and looked up) under: the key itself, an email
 *  folded to lower-case, and — ADR 0657 D9 — a phone-shaped key folded to bare E.164
 *  (`+` + digits) so `+1 (555) 000-1111` and `+15550001111` are ONE tombstone. Write and
 *  read use the same function, so a fold added here binds both. */
export function tombstoneKeyForms(subjectKey: string): string[] {
  const forms = [subjectKey];
  if (subjectKey.includes('@')) {
    const folded = subjectKey.trim().toLowerCase();
    if (folded !== subjectKey) forms.push(folded);
  } else if (/^\+?[\d\s().-]{6,}$/.test(subjectKey.trim())) {
    const digits = subjectKey.replace(/\D/g, '');
    const folded = `+${digits}`;
    if (digits.length >= 6 && folded !== subjectKey) forms.push(folded);
  }
  return forms;
}

/** CONS-1 — record that this subject was erased, WITHOUT retaining their key. Get-then-put:
 *  an existing row keeps its original `erasedAt` (the durable prior-erasure evidence D6's
 *  repeat detection reads) and accumulates `dsarHashes`. */
export async function writeErasureTombstone(tenantId: string, subjectKey: string, dsarHash?: string): Promise<void> {
  const erasedAt = new Date().toISOString();
  for (const k of tombstoneKeyForms(subjectKey)) {
    const subjectHash = tombstoneId(tenantId, k);
    const existing = await tombstones.get(`${tenantId}:${subjectHash}`);
    const dsarHashes = new Set(existing?.dsarHashes ?? []);
    if (dsarHash) dsarHashes.add(dsarHash);
    await tombstones.put({
      tenantId, subjectHash, erasedAt: existing?.erasedAt ?? erasedAt,
      ...(dsarHashes.size ? { dsarHashes: [...dsarHashes] } : {}),
    });
  }
}

/** ADR 0657 D1 — the consent eraser's record delete (the fan-out reaches keys
 *  `deleteSubject` never saw). Returns whether a row existed. */
export async function deleteConsentRecordForErasure(tenantId: string, subjectKey: string): Promise<boolean> {
  return records.delete(`${tenantId}:${subjectKey}`);
}

/** The prior tombstone for a key (any form), or null. */
async function getErasureTombstone(tenantId: string, subjectKey: string): Promise<{ erasedAt: string } | null> {
  for (const k of tombstoneKeyForms(subjectKey)) {
    const row = await tombstones.get(`${tenantId}:${tombstoneId(tenantId, k)}`);
    if (row) return { erasedAt: row.erasedAt };
  }
  return null;
}

/**
 * ADR 0657 D7 — the ONE tombstone clearer. Reverses exactly what one DSAR wrote: every
 * tombstone in the tenant slice whose `subjectHash` is one of the key's forms OR whose
 * `dsarHashes` contains the key's group id — the resolved keys and any resolver
 * over-reach included. Clears tombstones ONLY: no consent is granted; the subject's next
 * affirmative opt-in re-grants. Audited on the tenant chain (the attestation in plaintext —
 * it IS the evidence) and as a governance decision (hashed subject, attestation hash).
 */
const READMIT_ATTESTATION_MIN_LENGTH = 20;
export async function readmitSubject(
  tenantId: string,
  subjectKey: string,
  attestation: string,
): Promise<{ readmitted: boolean; tombstonesCleared: number }> {
  assertSubjectKey(subjectKey);
  if (typeof attestation !== 'string' || attestation.trim().length < READMIT_ATTESTATION_MIN_LENGTH) {
    throw new OpenwopError('validation_error', `Field \`attestation\` must be at least ${READMIT_ATTESTATION_MIN_LENGTH} characters — the operator's statement that the subject asked to return.`, 400, { field: 'attestation' });
  }
  const ids = new Set(tombstoneKeyForms(subjectKey).map((k) => tombstoneId(tenantId, k)));
  let tombstonesCleared = 0;
  for (const row of await tombstones.listForTenantIndexed(tenantId)) {
    if (ids.has(row.subjectHash) || (row.dsarHashes ?? []).some((h) => ids.has(h))) {
      if (await tombstones.delete(`${row.tenantId}:${row.subjectHash}`)) tombstonesCleared += 1;
    }
  }
  const subjectHash = hashSubjectKey(tenantId, subjectKey);
  const attestationHash = createHash('sha256').update(attestation.trim()).digest('hex');
  try {
    await appendAudit(tenantId, 'consent.readmit', { subjectHash, tombstonesCleared, attestation: attestation.trim() });
  } catch (err) {
    log.warn('audit_chain_append_failed', { tenantId, kind: 'consent.readmit', error: String(err) });
  }
  await recordGovernanceDecision({
    tenantId, kind: 'retention', outcome: 'allow', subject: hashSubjectKey(tenantId, subjectKey),
    reason: 'readmit', detail: { tombstonesCleared, attestationHash },
  });
  log.info('consent_subject_readmitted', { tenantId, subjectKeyHash: subjectHash, tombstonesCleared });
  return { readmitted: tombstonesCleared > 0, tombstonesCleared };
}

/** ADR 0657 D10 — the tombstone is the write barrier: no consent write lands on an erased
 *  subject until an administrator re-admits them (the CONS-25 race: a public write that
 *  lost its CAS to a DSAR used to retry from a null read and RE-INSERT the record). */
async function assertNotErased(tenantId: string, subjectKey: string): Promise<void> {
  if (await isErasureTombstoned(tenantId, subjectKey)) {
    throw new OpenwopError(
      'subject_erased',
      'This subject was erased at their request; consent cannot be written until an administrator re-admits them.',
      409, { subjectKeyHash: hashSubjectKey(tenantId, subjectKey) },
    );
  }
}

/** CONS-1 — has this subject been erased? ADR 0657 D2: consulted by `isAllowed` FIRST
 *  (before the toggle and before any record) and by every writer as the D10 barrier. */
export async function isErasureTombstoned(tenantId: string, subjectKey: string): Promise<boolean> {
  for (const k of tombstoneKeyForms(subjectKey)) {
    if ((await tombstones.get(`${tenantId}:${tombstoneId(tenantId, k)}`)) !== null) return true;
  }
  return false;
}

// HIGH-2 fold-in — the declared type used to NARROW `erasure` to five fields
// while the runtime object (the full `eraseSubject` result) rode the wire whole,
// so `foundNothing` reached the SPA untyped and unconsumed and the receipt
// rendered green over a zero-row fan-out. Declare what is actually returned.
export async function deleteSubject(
  tenantId: string,
  subjectKey: string,
): Promise<{ consentRecord: boolean; erasure: SubjectErasureResult }> {
  // CONS-4 / WF-CONS-1 — the LEGAL HOLD gate, asserted BEFORE anything mutates.
  // `eraseSubject` re-asserts it (the host seam defends itself for its other
  // caller), but doing it here first is what keeps a refused erasure from
  // leaving a tombstone behind for a subject who was not erased. The refusal is
  // recorded as a governance decision: an attempted erasure under hold is
  // exactly the kind of event Art. 5(2) accountability wants evidence of, and
  // this path used to write `outcome:'allow'` for a held tenant.
  const hold = await getRetentionHold(tenantId);
  if (hold) {
    await recordGovernanceDecision({
      tenantId,
      kind: 'retention',
      outcome: 'deny',
      subject: hashSubjectKey(tenantId, subjectKey),
      reason: 'erasure_refused_legal_hold',
      detail: { holdReason: hold.reason, holdSince: hold.createdAt },
    });
    throw new RetentionHoldError(hold);
  }
  // CONS-1 — the tombstone is written BEFORE the record is destroyed, and its
  // failure ABORTS the erasure. Deliberately fail-closed in this direction: a
  // failed-and-reported erasure is retryable, whereas destroying the refusal and
  // then failing to record it is the unrecoverable state this fix exists to
  // prevent. (An erasure that never ran is not silently reported as done — the
  // throw reaches the route.)
  // ADR 0657 D6 — repeat detection reads the PRIOR tombstone (its `erasedAt` is the durable
  // evidence); the first receipt is never flipped by a repeat.
  const prior = await getErasureTombstone(tenantId, subjectKey);
  await writeErasureTombstone(tenantId, subjectKey, tombstoneId(tenantId, subjectKey)); // D7 — this DSAR's group id
  const consentRecord = await records.delete(`${tenantId}:${subjectKey}`);
  let erasure: SubjectErasureResult;
  try {
    erasure = await eraseSubject(tenantId, subjectKey);
  } catch (err) {
    if (err instanceof RetentionHoldError) {
      // CONS-29 — a hold placed mid-request: the tombstone and the record delete have
      // ALREADY happened; the one lane that mutates under a hold must leave evidence.
      await recordGovernanceDecision({
        tenantId, kind: 'retention', outcome: 'deny', subject: hashSubjectKey(tenantId, subjectKey),
        reason: 'erasure_refused_legal_hold_mid_request',
        detail: { holdReason: err.reason, holdSince: err.createdAt, mutated: { tombstone: true, consentRecord } },
      });
    }
    throw err;
  }
  // D10 belt — a write that slipped past the barrier before the tombstone landed.
  await records.delete(`${tenantId}:${subjectKey}`);
  const reason = erasure.failed > 0
    ? 'erasure_partial'
    : erasure.foundNothing
      ? (prior ? 'erasure_repeat_no_data_found' : 'erasure_no_data_found')
      : 'erasure_complete';
  await recordGovernanceDecision({
    tenantId,
    kind: 'retention',
    outcome: erasure.failed === 0 ? 'allow' : 'deny',
    subject: hashSubjectKey(tenantId, subjectKey),
    reason,
    detail: {
      // `erasureScope` — an `erasure_complete` here means complete WITHIN THIS
      // TENANT. The fan-out deliberately does not cross the tenant axis (see the
      // WF-TWIN-3 correction in `host/subjectErasure.ts:174-181` — widening it is
      // a caller-supplied-key destructive escalation), so a subject whose personal
      // data lives in their HOME workspace is untouched by an erasure run from a
      // shared one. Recorded so the durable decision says what it actually claims.
      erasureScope: 'this-tenant-only',
      total: erasure.total, failed: erasure.failed, keysResolved: erasure.keysResolved,
      resolverFailures: erasure.resolverFailures, failedFeatures: erasure.failedFeatures,
      rowsTouched: erasure.rowsTouched, reportingErasers: erasure.reportingErasers,
      consentRecord,
      ...(prior ? { repeat: true, priorErasedAt: prior.erasedAt } : {}),
    },
  });
  return { consentRecord, erasure };
}

/**
 * The ONE enforcement helper Analytics (0018) + Email (0019) call. `necessary` is
 * always allowed. When the `consent` toggle is OFF for the tenant → permissive (no
 * regime configured). Otherwise: latest record → policy default → FAIL-CLOSED
 * (deny) when the default mode is opt-in / unset.
 *
 * Per-channel asks (`marketing.<channel>`, ADR 0227) resolve on the record as:
 * the specific key when the record carries one (it governs) → else the
 * `marketing` umbrella → else (no record) the existing policy-default path.
 * Old records have no specifics, so the umbrella keeps governing them —
 * stored records are untouched by the vocabulary extension.
 */
export async function isAllowed(tenantId: string, subjectKey: string, category: ConsentCategory): Promise<boolean> {
  if (category === 'necessary') return true;
  // ADR 0394 — strict explicit-opt-in categories (WhatsApp): ONLY a recorded
  // explicit `true` for the specific channel permits. No umbrella fallback, no
  // opt-out-default permission, no toggle-off permissive escape — Meta requires
  // explicit per-number opt-in regardless of the tenant's regional posture.
  const strict = STRICT_EXPLICIT_OPT_IN.has(category);
  let allowed: boolean;
  let basis: string;
  // ADR 0657 D2 — precedence: necessary → strict → TOMBSTONE (deny) → toggle-off (permit)
  // → record → policy default. A tombstone is a refusal that erasure wrote, not a feature
  // a tenant buys, so it out-ranks the toggle; and a record never out-ranks a tombstone
  // (a write cannot land on an erased subject — D10 — but a row that pre-dates the barrier
  // must not be the one thing that un-erases). An EMPTY key is never tombstoned (the
  // analytics beacon's `''`) and skips the point read. (The ADR 0394 strict-channel and
  // ADR 0227 umbrella notes that used to sit inline here are unchanged in substance —
  // only the tombstone moved to the front.)
  if (subjectKey && (await isErasureTombstoned(tenantId, subjectKey))) {
    allowed = false;
    basis = 'erased';
  } else {
    const assignment = await resolveOne('consent', { tenantId });
    if (!strict && (!assignment || !assignment.enabled)) return true; // toggle off ⇒ permissive (honest opt-in)
    const rec = await getConsent(tenantId, subjectKey);
    const policy = rec || strict ? null : await getPolicy(tenantId);
    basis = rec ? 'record' : (policy?.defaultMode ?? 'unset');
    if (strict) {
      allowed = rec?.categories[category as MarketingChannelCategory] === true;
    } else if (rec) {
      if (isMarketingChannelCategory(category)) {
        const specific = rec.categories[category];
        allowed = typeof specific === 'boolean' ? specific : rec.categories.marketing === true;
      } else {
        allowed = rec.categories[category] === true;
      }
    } else {
      allowed = policy?.defaultMode === 'opt-out';
    }
  }
  if (!allowed) {
    // A compliance-relevant denial under an active regime — log it so the
    // gate's decisions are auditable (FEAT-2). GRADE-DATA 2026-07-17: since
    // ADR 0394 a subjectKey can be a raw E.164 phone number, so the log line
    // carries a stable HASH, never the key itself (the audit chain keeps the
    // real key under its own access control).
    log.info('consent_denied', {
      tenantId,
      subjectKeyHash: createHash('sha256').update(`${tenantId}:${subjectKey}`).digest('hex').slice(0, 16),
      category,
      basis,
    });
    // ADR 0268 / CDP-F — also route the denial into the unified decision log
    // (fire-and-forget; the helper is best-effort and never breaks the gate).
    //
    // WF-CONS-14 — this line used to pass `subject: subjectKey` RAW, three lines
    // below the sibling log call that hashes the same value under a comment
    // explaining exactly why. The PII-hashing fix landed on the log line and was
    // never carried to the DURABLE write — which is the higher-frequency path
    // (every denial, versus once per DSAR) and the one that cannot be cleaned
    // up: `recordGovernanceDecision` writes into the global `audit_log` table,
    // which has no tenant column, no eraser, no purger and is excluded from
    // ADR 0284 tenant teardown by `deleteAllTenantData`'s own docblock. A
    // subject could be fully erased and still have their phone number in every
    // denial row the gate ever wrote. `GovernanceDecision.subject` declares
    // itself "opaque subject id (non-PII)"; this now honours it.
    //
    // The population that flows in here is not hypothetical: bare E.164 numbers
    // (whatsappService -> isPermittedForPurpose), CRM contactIds (email,
    // journeys, audiences), and unauthenticated caller-supplied session/visitor
    // keys (the analytics beacon, public form submits, pixels/conversions).
    void recordGovernanceDecision({
      tenantId, kind: 'consent', outcome: 'deny', subject: hashSubjectKey(tenantId, subjectKey),
      reason: `category:${category}`, detail: { basis },
    });
  }
  return allowed;
}

/** Test-only: clear all three stores (records, policies, erasure tombstones). */
export async function __resetConsentStore(): Promise<void> {
  await records.__clear();
  await policies.__clear();
  await tombstones.__clear();
}
