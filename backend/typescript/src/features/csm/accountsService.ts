/**
 * CSM accounts store (host-extension, best-effort — ADR 0001 §6 Phase 6).
 *
 * The second feature, added as a PURE addition (zero core edits) to prove the
 * feature-package contract. Tenant-scoped accounts with a health score, backed
 * by the durable host_ext_kv collection.
 *
 * ADR 0212 (CSM↔CRM linkage) added two things, both routes-only (the workflow
 * surface intentionally does NOT expose `crmRef` in v1 — see surface.ts):
 *   §1 `crmRef` — a validated reference into the CRM company graph (csm→crm,
 *      never the reverse). Both-or-neither; the referenced company MUST exist
 *      for the caller's tenant+org and MUST NOT be a merge tombstone at write
 *      time (`validateCrmRef`, fail-closed 404). A LATER dangle — the company
 *      is deleted/merged after the ref is set — is tolerated at read.
 *   §2 `healthFactors`/`healthComputedAt` — computed-health provenance. The
 *      workflow surface's `setHealth` (surface.ts) accepts an optional
 *      `factors` array; a plain `healthScore` set with NO factors (the ONLY
 *      shape the HTTP PATCH route sends — it never carries `factors`) clears
 *      any prior factors/stamp, because a hand-typed score is not a computed
 *      one.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerRetentionPurger } from '../../host/retentionPurger.js';
import { getCompany } from '../crm/crmEntitiesService.js';

export interface CrmRef {
  orgId: string;
  companyId: string;
}

export interface HealthFactor {
  factor: string;
  weight: number;
  value: number;
}

/**
 * ADR 0582 §5 — WHICH ARITHMETIC produced `healthFactors`. Two in-tree producers
 * emit the SAME `{factor, weight, value}` header shape from DIFFERENT formulas:
 * `feature.csm.nodes.health-set` computes `100 − Σ(weight × value)` (a penalty
 * sum, where `value` is a COUNT of open rows), while `demoOpsPlanningSeed`
 * computes `Σ(weight × value) / Σ(weight)` (a weighted mean, where `value` is a
 * 0–100 sub-score). Under identical column headers the two are indistinguishable
 * and mutually contradictory, so the breakdown was uninterpretable. The method is
 * now stated with the numbers. Absent = the producer did not say; the UI renders
 * the rows without claiming a formula rather than inventing one.
 */
export type HealthMethod = 'penalty-sum' | 'weighted-mean';
const HEALTH_METHODS: readonly HealthMethod[] = ['penalty-sum', 'weighted-mean'];

/** ADR 0582 §4 — why the last automated compute attempt declined to score. */
const MAX_MEASURE_REASON = 200;

export interface Account {
  accountId: string;
  tenantId: string;
  name: string;
  /**
   * ADR 0582 §4 — 0..100, and **OPTIONAL: ABSENT MEANS NOT SCORED**.
   *
   * It used to be non-optional with a silent `50` default (`clampScore`), so an
   * account nobody had ever measured was byte-identical to one deliberately
   * scored at the middle of the band — and the SPA's create form pre-filled
   * `'50'`, making the default and a real mid-band judgement the same value.
   * "Unmeasured" now has no representation as a number, which is the only way
   * the UI can render it as a state rather than as a score.
   */
  healthScore?: number;
  /** ADR 0212 §1 — a validated reference into the CRM company graph. */
  crmRef?: CrmRef;
  /** ADR 0212 §2 — the factor breakdown behind a COMPUTED healthScore. */
  healthFactors?: HealthFactor[];
  /** ADR 0212 §2 — when healthFactors was last (re)computed. */
  healthComputedAt?: string;
  /** ADR 0582 §5 — the arithmetic `healthFactors` came out of. */
  healthMethod?: HealthMethod;
  /**
   * ADR 0582 §4 — the last automated compute attempt REFUSED to score (its CRM
   * fan-in was absent, partial, or could not be scoped to this account's linked
   * company). Recorded rather than swallowed, because the alternative shipped so
   * far was to score the absence as 100 and stamp it as computed. Cleared by any
   * successful score write.
   */
  healthMeasureFailedAt?: string;
  healthMeasureFailedReason?: string;
  /** CRM-3 (ADR 0212 §4) — first-class account commercial depth (all optional, additive;
   *  pre-existing rows simply lack them). `renewalDate` ISO; `arr` annual recurring revenue
   *  in MAJOR units (matches the commerce `price: number` domain convention); `owner` an
   *  opaque CS-owner subject id. */
  renewalDate?: string;
  arr?: number;
  /** R2 CS-SP-2 — ISO 4217 code for `arr` (additive; absent = unitless). */
  arrCurrency?: string;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

// R2 CS-SP-6 — `tenantOf` gives listForTenant() an INDEXED tenant slice; the
// old bare list() scanned every tenant's rows and filtered in memory.
const store = new DurableCollection<Account>('csm:account', (a) => a.accountId, undefined, (a) => a.tenantId);

const MAX_FACTORS = 12;
const MAX_FACTOR_NAME = 64;

/**
 * ADR 0582 §4 (CSM-11) — clamp a score the caller ACTUALLY SUPPLIED.
 *
 * This used to substitute **50** for a missing or non-finite input, which is
 * where "unmeasured reads as measured" entered the store: a create with no
 * score, a node handed a `{{params.*}}` value frozen to a STRING (the recorded
 * RFC 0013 Path-A behaviour), and a deliberate 50 were all indistinguishable
 * afterwards. A present-but-invalid score is now a typed failure and an absent
 * one is simply absent; there is no path that invents a number.
 */
function clampScore(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new OpenwopError('validation_error', 'Field `healthScore` MUST be a finite number in [0, 100].', 400, { field: 'healthScore' });
  }
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

const MAX_OWNER = 200;
const MAX_DATE = 40;
/** CSM-5 — `name` was the ONE user-authored field that never reached
 *  `host/boundedStrings.ts`: unbounded and un-secret-scrubbed into the durable
 *  store, from there into the run-event log (node outputs are recorded) and into
 *  LLM context via the chat tool, while every sibling field was capped. Same cap
 *  as the CRM entity convention. */
const MAX_NAME = 200;

/** CSM-5 — the shared name cleaner for both write paths (HTTP + the workflow
 *  surface). Fail-closed: a name that scrubs down to nothing is a 400, never a
 *  silently blank row. */
function cleanName(raw: unknown): string {
  const s = cleanString(raw, MAX_NAME);
  if (!s) {
    throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, { field: 'name' });
  }
  return s;
}
/** CRM-3 field validators — fail-closed like validateHealthFactors (a bad value 400s, never
 *  silently mangled). Each returns the cleaned value, or undefined for an absent/blank input. */
function cleanRenewalDate(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new OpenwopError('validation_error', 'Field `renewalDate` MUST be an ISO date string.', 400, { field: 'renewalDate' });
  const s = cleanString(v, MAX_DATE);
  if (!s) return undefined;
  if (Number.isNaN(Date.parse(s))) throw new OpenwopError('validation_error', 'Field `renewalDate` MUST be a valid ISO date.', 400, { field: 'renewalDate' });
  return s;
}
function cleanArr(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new OpenwopError('validation_error', 'Field `arr` MUST be a non-negative number.', 400, { field: 'arr' });
  return v;
}
function cleanOwner(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new OpenwopError('validation_error', 'Field `owner` MUST be a string.', 400, { field: 'owner' });
  const s = cleanString(v, MAX_OWNER);
  return s || undefined;
}

/**
 * Validate a `crmRef` against CRM (ADR 0212 §1, fail-closed): the company MUST
 * exist for this tenant+org and MUST NOT be a merge tombstone (`getCompany`
 * deliberately does not filter tombstones — see crmEntitiesService — so this
 * checks `mergedInto` itself). csm→crm import direction only; CRM never
 * learns about csm.
 */
export async function validateCrmRef(tenantId: string, ref: CrmRef): Promise<void> {
  const company = await getCompany(tenantId, ref.orgId, ref.companyId);
  if (!company || company.mergedInto) {
    throw new OpenwopError('not_found', 'Linked CRM company not found.', 404, { orgId: ref.orgId, companyId: ref.companyId });
  }
}

/**
 * Bounded, fail-closed validation for a `healthFactors` payload (ADR 0212 §2):
 * at most `MAX_FACTORS` entries, each a non-empty `factor` name capped at
 * `MAX_FACTOR_NAME` chars, `weight`/`value` finite numbers. Rejects (never
 * silently clamps/drops) a malformed entry — a caller that sends bad shape
 * gets a 400/validation error, not a silently-mangled record.
 */
export function validateHealthFactors(raw: unknown): HealthFactor[] {
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'Field `healthFactors` MUST be an array.', 400, { field: 'healthFactors' });
  }
  if (raw.length > MAX_FACTORS) {
    throw new OpenwopError('validation_error', `Field \`healthFactors\` MUST have at most ${MAX_FACTORS} entries.`, 400, { field: 'healthFactors', max: MAX_FACTORS });
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new OpenwopError('validation_error', `healthFactors[${i}] MUST be an object.`, 400, { field: 'healthFactors' });
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.factor !== 'string' || e.factor.trim().length === 0) {
      throw new OpenwopError('validation_error', `healthFactors[${i}].factor MUST be a non-empty string.`, 400, { field: 'healthFactors' });
    }
    if (e.factor.length > MAX_FACTOR_NAME) {
      throw new OpenwopError('validation_error', `healthFactors[${i}].factor MUST be at most ${MAX_FACTOR_NAME} chars.`, 400, { field: 'healthFactors', max: MAX_FACTOR_NAME });
    }
    if (typeof e.weight !== 'number' || !Number.isFinite(e.weight)) {
      throw new OpenwopError('validation_error', `healthFactors[${i}].weight MUST be a finite number.`, 400, { field: 'healthFactors' });
    }
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
      throw new OpenwopError('validation_error', `healthFactors[${i}].value MUST be a finite number.`, 400, { field: 'healthFactors' });
    }
    return { factor: cleanString(e.factor, MAX_FACTOR_NAME), weight: e.weight, value: e.value };
  });
}

/**
 * ADR 0582 §8 (CSM-6) — a bounded compare-and-swap around a read-modify-write.
 *
 * Every write here was an unguarded whole-row `put` over a value read moments
 * earlier, while `DurableCollection.compareAndSwap` was available and the CRM
 * sibling had already adopted it for its convert/merge TOCTOU. Two concurrent
 * PATCHes lost a field; a node `setHealth` racing a UI edit clobbered it; and a
 * PATCH racing a DELETE RESURRECTED the deleted row, because `updateAccount`
 * re-read, then put. `mutate` re-reads and re-applies on a lost race, and
 * returns `null` when the row is gone — so a resurrection is now impossible and
 * the caller 404s (CSM-7) instead of reporting success.
 */
const CAS_ATTEMPTS = 4;
async function mutate(accountId: string, apply: (existing: Account) => Account): Promise<Account | null> {
  for (let i = 0; i < CAS_ATTEMPTS; i += 1) {
    const existing = await store.get(accountId);
    if (!existing) return null; // deleted under us — never re-create it
    const next = apply(existing);
    if (await store.compareAndSwap(existing, next)) return next;
  }
  throw new OpenwopError('conflict', 'The account changed while this update was being applied. Try again.', 409, { accountId });
}

export async function listAccounts(tenantId: string): Promise<Account[]> {
  const rows = await store.listForTenantIndexed(tenantId);
  // Lowest health first — the at-risk view. ADR 0582 §4: an UNSCORED row is not
  // a low score, it is an unknown one, so it sinks to the end (the same
  // nulls-last convention `DataTable` uses) rather than pretending to be the
  // most at-risk row in the book. The UI counts them out loud instead.
  return rows.sort((a, b) => {
    if (a.healthScore === undefined) return b.healthScore === undefined ? 0 : 1;
    if (b.healthScore === undefined) return -1;
    return a.healthScore - b.healthScore;
  });
}

export async function getAccount(accountId: string): Promise<Account | null> {
  return store.get(accountId);
}

function cleanArrCurrency(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v)) {
    throw new OpenwopError('validation_error', 'Field `arrCurrency` MUST be a 3-letter ISO 4217 code.', 400, { field: 'arrCurrency' });
  }
  return v.toUpperCase();
}

export async function createAccount(input: { tenantId: string; name: string; healthScore?: number; crmRef?: CrmRef; renewalDate?: string; arr?: number; arrCurrency?: string; owner?: string }): Promise<Account> {
  if (input.crmRef) await validateCrmRef(input.tenantId, input.crmRef);
  const renewalDate = cleanRenewalDate(input.renewalDate);
  const arr = cleanArr(input.arr);
  const arrCurrency = cleanArrCurrency(input.arrCurrency);
  const owner = cleanOwner(input.owner);
  const now = new Date().toISOString();
  const account: Account = {
    accountId: `csm:${randomUUID()}`,
    tenantId: input.tenantId,
    name: cleanName(input.name),
    // ADR 0582 §4 — no score supplied ⇒ the row is UNSCORED. No `50`.
    ...(input.healthScore !== undefined ? { healthScore: clampScore(input.healthScore) } : {}),
    ...(input.crmRef ? { crmRef: input.crmRef } : {}),
    ...(renewalDate !== undefined ? { renewalDate } : {}),
    ...(arr !== undefined ? { arr } : {}),
    ...(arr !== undefined && arrCurrency !== undefined ? { arrCurrency } : {}),
    ...(owner !== undefined ? { owner } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await store.put(account);
  return account;
}

/**
 * The HTTP PATCH route's update path. `crmRef: null` clears an existing link;
 * a provided `{orgId, companyId}` is (re-)validated against CRM (ADR 0212
 * §1). A `healthScore` set here — the route NEVER sends `factors` — clears
 * any prior `healthFactors`/`healthComputedAt` (ADR 0212 §2: hand-typed ≠
 * computed).
 */
export async function updateAccount(
  accountId: string,
  patch: { name?: string; healthScore?: number | null; crmRef?: CrmRef | null; renewalDate?: string | null; arr?: number | null; arrCurrency?: string | null; owner?: string | null },
): Promise<Account | null> {
  const preRead = await store.get(accountId);
  if (!preRead) return null;
  // Validated ONCE, outside the CAS retry: `validateCrmRef` is a CRM round-trip
  // and the tenant of a row never changes.
  if (patch.crmRef) await validateCrmRef(preRead.tenantId, patch.crmRef);
  return mutate(accountId, (existing) => {
  const next: Account = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.healthScore !== undefined) {
    // ADR 0582 §4 — an explicit `null` RETURNS the row to unscored. That is the
    // affordance an operator needs once a score is distrusted: today the only
    // way to un-assert a number was to delete the account, which minted a new
    // accountId and destroyed the CRM link and the health history with it.
    if (patch.healthScore === null) delete next.healthScore;
    else next.healthScore = clampScore(patch.healthScore);
    delete next.healthFactors;
    delete next.healthComputedAt;
    delete next.healthMethod;
    // A human has spoken about this score, so the stale machine complaint goes.
    delete next.healthMeasureFailedAt;
    delete next.healthMeasureFailedReason;
  }
  if (patch.crmRef !== undefined) {
    if (patch.crmRef === null) delete next.crmRef;
    else next.crmRef = patch.crmRef;
  }
  // CRM-3 — null clears; a value is validated (fail-closed); undefined leaves it untouched.
  if (patch.renewalDate !== undefined) {
    const v = patch.renewalDate === null ? undefined : cleanRenewalDate(patch.renewalDate);
    if (v === undefined) delete next.renewalDate; else next.renewalDate = v;
  }
  if (patch.arr !== undefined) {
    const v = patch.arr === null ? undefined : cleanArr(patch.arr);
    if (v === undefined) delete next.arr; else next.arr = v;
  }
  if (patch.arrCurrency !== undefined) {
    if (patch.arrCurrency === null) delete next.arrCurrency;
    else next.arrCurrency = cleanArrCurrency(patch.arrCurrency) as string;
  }
  // A row without an amount must not carry a unit.
  if (next.arr === undefined) delete next.arrCurrency;
  if (patch.owner !== undefined) {
    const v = patch.owner === null ? undefined : cleanOwner(patch.owner);
    if (v === undefined) delete next.owner; else next.owner = v;
  }
  return next;
  });
}

/**
 * ADR 0283 consumer (grade-data CRM-5) — when a CRM company is deleted, SCRUB
 * (never delete) the `crmRef` off accounts pointing at it: the account and its
 * health history have standalone value; the dangling ref goes. Idempotent.
 */
export async function scrubCrmRefsForDeletedCompany(tenantId: string, companyId: string, orgId?: string): Promise<number> {
  let scrubbed = 0;
  for (const a of await listAccounts(tenantId)) {
    // CSM-13 — narrow on BOTH halves of the ref WHEN THE ORG IS KNOWN. Matching
    // on `companyId` alone over-scrubs if two orgs ever share a company id
    // (harmless today — ids are UUIDs). `orgId` is OPTIONAL on the ADR 0283
    // delete payload, and a stricter guard that skipped every row when the org
    // is absent would leave dangling refs behind — a worse defect than the one
    // it closes — so an absent org keeps the original, wider match.
    if (a.crmRef?.companyId !== companyId) continue;
    if (orgId && a.crmRef.orgId !== orgId) continue;
    const updated = await mutate(a.accountId, (existing) => {
      const next = { ...existing };
      delete next.crmRef;
      return next;
    });
    if (updated) scrubbed += 1;
  }
  return scrubbed;
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  return store.delete(accountId);
}

/* ─── ADR 0582 §7 — `owner` privacy (CSM-4 / CSM-12) ───────────────────── */

/**
 * `Account.owner` is documented as "an opaque CS-owner subject id", but its ONLY
 * producer is a free-text "Account owner" input in the SPA, searchable next to
 * the account name — in practice a person's name. It was invisible to ALL THREE
 * privacy mechanisms at once: no `declarePiiFields`, no `SubjectEraser`, no
 * retention purger, and `looksLikePiiName('owner')` is FALSE so even the
 * undeclared-PII backstop missed it. The only thing that ever reclaimed it was
 * ADR 0284 tenant teardown.
 *
 * The house norm is that a deliberate skip carries an explicit opt-out comment
 * (`features/production/productionService.ts`). This is NOT a skip: `owner` is
 * declared, erased and purged below.
 *
 * ERASURE SHAPE — anonymize, do not delete, the `crm/erasure.ts` precedent. A CSM
 * account is the TENANT's commercial record (ARR, renewal date, health history);
 * deleting it because the CS owner exercised a DSAR would destroy the business's
 * own data to erase one person's attribution. The `owner` value is redacted in
 * place instead.
 *
 * HOW FAR THE DSAR ACTUALLY REACHES — stated plainly, because the sentence
 * above ("owner is in practice a person's NAME") and the eraser below (exact
 * equality against a `subjectKey`) do not meet. `eraseCsmSubject` redacts a row
 * only when `owner === subjectKey`, i.e. only when the field happens to hold a
 * subject ref. For the field's REAL producer — the free-text "Account owner"
 * box in the SPA — a display name will never equal a subject key, so the DSAR
 * sweep is a NO-OP for exactly the values that motivated declaring it PII. The
 * test below pins the documented contract (`owner:'user:cs-1'`), not the
 * producer, so it does not witness that gap either.
 *
 * What IS real coverage today: the retention purger (age-based, value-agnostic
 * — it does not care what shape `owner` holds) and ADR 0284 tenant teardown.
 * Making the DSAR reach the common case needs `owner` normalised to a subject
 * ref at the WRITE boundary (a user picker in the SPA rather than a free-text
 * box) — a product change, recorded as open work in ADR 0582 §13 rather than
 * papered over with a substring match, which would erase the wrong people.
 *
 * RE-MEASURED 2026-08-18 (the previous figures here were wrong; corrected
 * rather than deleted, per the ADR house rule). The ADR 0464 feature-store gate
 * binds SIX signals — `userId`, `subjectKey`, `subjectId|managerSubjectId`,
 * `contactId`, email, and the KB-3 actor signal `createdBy|uploadedBy|authorId`
 * — and `owner` is none of them, so `csm:account` has never been classified by
 * that gate in EITHER direction. Replaying the gate's OWN enumerator with an
 * `owner` signal added binds **4** stores, not 7: `app-builder:sync-binding`,
 * `crm:contact`, `crm:deal`, `csm:account`. Exactly **ONE** holds a GitHub repo
 * owner (`SyncBinding.owner`, constrained by `GH_OWNER_RE` — "GitHub login"),
 * not three: the two other stores previously named here (`sync-webhook`'s
 * `WebhookRef`, `sync-deliveries`' `DeliveryRow`) carry no `owner` field at all.
 * All four already register a module-level eraser, so the widening would add
 * ZERO new debt-ledger rows — the harm originally claimed ("booking those as
 * newly-classified") does not occur. The refusal still stands, but on a
 * NARROWER ground: `eraseSyncBindingSubject` rewrites `boundBy` only and has no
 * reason to touch a GitHub login, so a widened matcher would let the gate
 * assert `owner` coverage that nothing provides — false coverage, one instance
 * rather than three.
 */
const CSM_STORE = 'csm:account';
// ADR 0582 §12 — entity-scoped, NOT global. `owner` is a generic word, and the
// log-mask union is keyed on the leaf key with no entity context, so declaring
// it globally would rewrite every `owner` log key in the app to `pii_<sha>` —
// including app-builder's sync-binding `owner`, which is a GITHUB LOGIN
// (`GH_OWNER_RE`), not a person. That is precisely the repo-owner
// false-positive class §11 cites as its reason NOT to widen the erasure
// matcher; introducing it here instead would be the same mistake one layer
// over. `isPiiField('csm:account','owner')` is still true, so erasure /
// retention / export are unaffected.
declarePiiFields(CSM_STORE, ['owner'], { maskGloballyByFieldName: false });

/** The redaction marker a DSAR leaves behind — the row keeps its shape, the
 *  person does not keep their attribution. */
const ERASED_OWNER = '[erased]';

async function eraseCsmSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  for (const a of await store.listForTenantIndexed(tenantId)) {
    if (a.owner !== subjectKey) continue;
    const next: Account = { ...a, owner: ERASED_OWNER, updatedAt: new Date().toISOString() };
    // CAS, not put: a DSAR sweep racing a UI edit must not resurrect the old
    // owner. A lost race means the row changed under us; the next sweep sees it.
    if (!(await store.compareAndSwap(a, next))) {
      const current = await store.get(a.accountId);
      if (current && current.owner === subjectKey) {
        await store.compareAndSwap(current, { ...current, owner: ERASED_OWNER, updatedAt: new Date().toISOString() });
      }
    }
  }
}

/**
 * Retention (ADR 0077) for `csm:account`. The row is NOT deleted: an account
 * carries the tenant's own ARR/renewal history and a time-based sweep must not
 * silently destroy commercial records. What ages out is the PERSON on it, so the
 * purger redacts `owner` on rows untouched since the cutoff and reports how many
 * it redacted. Stated here rather than left to be inferred from a count.
 */
registerRetentionPurger({
  feature: 'csm',
  purge: async (tenantId, classification, cutoffIso) => {
    if (!tenantId) return 0; // fail-closed — never a global purge
    if (classification !== 'confidential-pii') return 0;
    let redacted = 0;
    for (const a of await store.listForTenantIndexed(tenantId)) {
      if (!a.owner || a.owner === ERASED_OWNER) continue;
      if (a.updatedAt >= cutoffIso) continue;
      if (await store.compareAndSwap(a, { ...a, owner: ERASED_OWNER })) redacted += 1;
    }
    return redacted;
  },
});

registerSubjectEraser(eraseCsmSubject);

/**
 * Tenant-guarded read for the workflow surface + nodes (ADR 0014). Unlike
 * `getAccount` (by id, NO tenant check — route-only, the routes guard it), this is
 * safe to expose to `ctx.features.csm`: a cross-tenant accountId reads as not-found
 * (CTI-1), so a node cannot probe another workspace's accounts.
 */
export async function getAccountForTenant(tenantId: string, accountId: string): Promise<Account | null> {
  const a = await store.get(accountId);
  return a && a.tenantId === tenantId ? a : null;
}

/**
 * Tenant-guarded health/name set for the workflow surface + nodes. **Idempotent by
 * accountId** (same inputs → same result), so a fork/replay never duplicates.
 * Updates an EXISTING account only — node-driven create is intentionally not
 * offered (a caller-supplied id would be non-deterministic). Returns null if the
 * account is absent or belongs to another tenant.
 *
 * ADR 0212 §2: `factors` (validated + bounded via `validateHealthFactors`) sets
 * `healthFactors` + stamps `healthComputedAt = now` — this is the COMPUTED path
 * (the `csm-ops.health-from-crm` chain drives it via `feature.csm.nodes.health-set`).
 * A `healthScore` given WITHOUT `factors` clears any prior factors/stamp — the
 * same "hand-typed ≠ computed" rule the HTTP route applies, kept in one place so
 * a plain node-driven score set can't leave a stale computed breakdown behind.
 *
 * ADR 0582 §4/§5 adds three fail-closed obligations to the COMPUTED path, all at
 * this one choke:
 *
 *   1. `computedForCompanyId` is REQUIRED and MUST equal `crmRef.companyId`.
 *      The `csm-ops.health-from-crm` chain takes `orgId`/`companyId`/`accountId`
 *      as three INDEPENDENT run parameters and its description states twice that
 *      the account's `crmRef` MUST already reference them — a MUST enforced
 *      nowhere. A mis-parameterised run therefore scored an account from a
 *      DIFFERENT company's deals and stamped the result as computed. This is the
 *      same shape as the R2 CS-SP-4 rule one line below it: a provenance stamp
 *      may not assert more than the caller proved.
 *   2. `method` is REQUIRED — see {@link HealthMethod}.
 *   3. A successful score write CLEARS any recorded measurement failure.
 *
 * `measureFailed` is the honest alternative to the behaviour this replaces: a
 * compute that cannot scope or complete its fan-in records WHY and leaves the
 * score alone, instead of scoring the absence as 100 and stamping it computed.
 */
export async function setAccountHealthForTenant(
  tenantId: string,
  accountId: string,
  patch: {
    name?: string;
    healthScore?: number;
    factors?: unknown;
    /** The company the factors were actually measured over (ADR 0582 §4). */
    computedForCompanyId?: string;
    /** Which arithmetic produced them (ADR 0582 §5). */
    method?: HealthMethod;
    /** Record a REFUSAL to score. Mutually exclusive with `factors`. */
    measureFailed?: { reason: string };
  },
): Promise<Account | null> {
  // Validate shape BEFORE the existence lookup — malformed input is rejected
  // fail-closed regardless of whether the account exists (also avoids doing a
  // store read for garbage input).
  const validatedFactors = patch.factors !== undefined ? validateHealthFactors(patch.factors) : undefined;
  // R2 CS-SP-4 — factors WITHOUT a score would stamp `healthComputedAt = now`
  // beside a score that was NOT recomputed: the honesty stamp lying at its one
  // choke point. A computed set carries both, so require both (fail-closed).
  if (validatedFactors !== undefined && patch.healthScore === undefined) {
    throw new OpenwopError('validation_error', 'Field `factors` MUST be accompanied by the `healthScore` they computed — factors alone would stamp a stale score as freshly computed.', 400, { field: 'factors' });
  }
  if (validatedFactors !== undefined && patch.measureFailed !== undefined) {
    throw new OpenwopError('validation_error', 'A computed set and a measurement failure are mutually exclusive.', 400, { field: 'measureFailed' });
  }
  if (validatedFactors !== undefined && (patch.method === undefined || !HEALTH_METHODS.includes(patch.method))) {
    throw new OpenwopError('validation_error', `Field \`method\` MUST accompany \`factors\` and be one of ${HEALTH_METHODS.join('/')} — a weight/value breakdown with no stated arithmetic is not interpretable.`, 400, { field: 'method' });
  }
  const preRead = await store.get(accountId);
  if (!preRead || preRead.tenantId !== tenantId) return null;
  // CSMWF-2 / ADR 0645 D2 — REFUSE TO SCORE AN ABSENT COMPANY, and RECORD the
  // refusal. Two doors led to a dishonest row here:
  //
  //  1. MERGE. `mergeCompany` tombstones without firing `fireCrmRecordDeleted`,
  //     so `crmRef` still names the tombstone and the equality check below still
  //     passes. `listDeals`/`listTasks` FILTER without validating existence and
  //     return [], so the fan-in looks complete, every ADR 0582 §4 guard passes,
  //     and `100 - 0 - 0` is stamped as a real measurement — the greenest chip on
  //     the page. That is ADR 0582's own headline defect through a new door, and
  //     it is worse than a wrong number: `portfolioArrAtRisk` counts `< 70`, so
  //     the executive summary gets QUIETER exactly when measurement breaks.
  //  2. DELETE. The cascade scrubs `crmRef`, after which the equality check below
  //     THREW — so the durable "why I stopped measuring" marker was never
  //     written and the account kept its last score and stamp forever, which
  //     defeats `measureFailed` on the one path where the link is legitimately
  //     gone.
  //
  // Both now take the refusal path instead. `validateCrmRef` is REUSED rather
  // than restated — it already rejects a tombstone, and a second copy of that
  // rule is how the two drift.
  if (validatedFactors !== undefined) {
    // CSMCD-2 — narrow catch. `validateCrmRef` throws `not_found` for the
    // tombstone/absent case, but it is a STORE ROUND TRIP: a storage outage or a
    // decode failure would otherwise be recorded on a durable, operator-facing
    // row as "the linked CRM company is no longer resolvable" — a wrong,
    // confident, PERMANENT explanation for a transient fault. Anything that is
    // not a genuine not-found propagates.
    let linkGone: string | null = preRead.crmRef ? null : 'crm-link-removed';
    if (preRead.crmRef) {
      try {
        await validateCrmRef(tenantId, preRead.crmRef);
      } catch (err) {
        if (err instanceof OpenwopError && err.code === 'not_found') linkGone = 'crm-company-gone';
        else throw err;
      }
    }
    if (linkGone) {
      // CSMCD-1 — RECORD THE REFUSAL, THEN FAIL TYPED. The first cut of D2
      // `return`ed the marker row, which is truthy, so `surface.setHealth`
      // handed the node a non-null `{account}` and `healthSet` reported
      // `status:'success'`. A `csm-ops.health-from-crm` run against a merged
      // company therefore COMPLETED GREEN while its declared output
      // (`outputs.account` — "the Account after the write") was a row that had
      // never been rescored. That is success-with-empty on a durable write path,
      // the exact class this pack's docblock calls out, and it made the fix for
      // a dishonest SCORE into a dishonest RUN STATUS.
      //
      // The pack's other refusal (`refuseToScore`) already has the right shape:
      // write the marker first — the run failing is invisible from the CSM
      // console, so the durable marker is what tells the operator — then throw
      // typed. This now matches it, so the two refusal paths agree.
      await setAccountHealthForTenant(tenantId, accountId, {
        measureFailed: { reason: `Stopped measuring: ${linkGone}. The linked CRM company is no longer resolvable, so an empty deal/task fan-in would score a fabricated 100.` },
      });
      throw new OpenwopError(
        'validation_error',
        'Refused to score: the linked CRM company is no longer resolvable. The refusal has been recorded on the account.',
        409,
        { accountId, reason: linkGone },
      );
    }
  }
  if (validatedFactors !== undefined) {
    const measuredFor = patch.computedForCompanyId;
    if (!measuredFor || measuredFor !== preRead.crmRef?.companyId) {
      throw new OpenwopError(
        'validation_error',
        'A computed health set MUST name the CRM company it measured, and it MUST be the company this account is linked to — otherwise the score describes a different customer.',
        400,
        { field: 'computedForCompanyId', accountId },
      );
    }
  }
  return mutate(accountId, (existing) => {
  const next: Account = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.healthScore !== undefined) next.healthScore = clampScore(patch.healthScore);
  if (validatedFactors !== undefined) {
    next.healthFactors = validatedFactors;
    next.healthComputedAt = next.updatedAt;
    next.healthMethod = patch.method as HealthMethod;
  } else if (patch.healthScore !== undefined) {
    delete next.healthFactors;
    delete next.healthComputedAt;
    delete next.healthMethod;
  }
  if (patch.healthScore !== undefined) {
    // A fresh number supersedes an older refusal.
    delete next.healthMeasureFailedAt;
    delete next.healthMeasureFailedReason;
  }
  if (patch.measureFailed !== undefined) {
    next.healthMeasureFailedAt = next.updatedAt;
    next.healthMeasureFailedReason = cleanString(patch.measureFailed.reason, MAX_MEASURE_REASON, 'The health measurement could not be completed.');
  }
  return next;
  });
}

/** Test-only: clear all accounts. */
export async function __resetCsmStore(): Promise<void> {
  await store.__clear();
}
