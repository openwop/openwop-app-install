/**
 * Data classification taxonomy + PII field registry (ADR 0077 Phase 1).
 *
 * The FOUNDATION the PII log-masking pass (Phase 2) and the retention sweep
 * (Phase 3) consume. Phase 1 ships only the type + the registry — it changes no
 * masking and no retention behavior.
 *
 * Two pieces:
 *  - `DataClassification` — a Public / Internal / Confidential-PII label. Unlabeled
 *    data defaults to `internal` (an operational default — `confidential-pii`-by-default
 *    would mask everything and destroy log usefulness; the lint below backstops
 *    under-classification).
 *  - a process-global, code-declared **PII field registry**: which field names of which
 *    entity are PII. Features declare their PII fields once at module load via
 *    `declarePiiFields(...)` — the SAME side-effect-registration pattern as
 *    `host/subjectErasure.ts` (host owns the data; features import the host helper;
 *    core never imports features → no cycle).
 *
 * The registry is a SYNCHRONOUS in-memory point lookup (Phase 2 calls it on the log
 * hot path — no async, no DurableCollection scan). It exposes both a per-entity query
 * (`isPiiField`) and an entity-agnostic union (`isKnownPiiFieldName`), because the
 * log-masking deep walk usually has only a leaf key, not the entity it belongs to.
 *
 * @see docs/adr/0077-data-classification-pii-masking-retention.md
 */

import { createHash } from 'node:crypto';

export type DataClassification = 'public' | 'internal' | 'confidential-pii';

/** entity → set of its PII field names. */
const registry = new Map<string, Set<string>>();
/** Union of every declared PII field name (entity-agnostic fast path for log masking). */
const allPiiFieldNames = new Set<string>();

/** Options for {@link declarePiiFields}. */
export interface DeclarePiiFieldsOptions {
  /**
   * Whether these field NAMES also join the entity-agnostic union that
   * `isKnownPiiFieldName` (and therefore `maskPiiDeep`, and therefore EVERY log
   * bag) consults. Default `true` — the historical behaviour, and the right one
   * for a distinctive name like `ssn` or `sampleGoal`.
   *
   * Set `false` for a GENERIC field name whose PII-ness is a property of THIS
   * entity, not of the name. The union is keyed on the leaf key alone, so
   * declaring a common word globally masks it everywhere it ever appears — for
   * ADR 0582's `csm:account.owner` that would pseudonymize an
   * `owner` key belonging to a GitHub repo (app-builder's sync binding stores
   * exactly such an `owner`, a GitHub login), turning an operational field into
   * `pii_<sha>` and making the log actively misleading. `isPiiField(entity,
   * field)` still returns true, so entity-aware callers (erasure, exports,
   * retention) are unaffected.
   *
   * TRADE-OFF, stated: a value logged under a bare `owner` key is then NOT
   * masked for this entity either. Accepted here because the deep walk has only
   * the leaf key and cannot tell the two apart — and `src/features/csm/` emits
   * no logs at all (MEASURED 2026-08-18: zero `log.*` call sites), so the
   * declaration bought no masking in practice while costing the global union a
   * very common word.
   */
  readonly maskGloballyByFieldName?: boolean;
}

/**
 * Declare, once at module load, which fields of an entity are PII. Idempotent +
 * additive (re-declaring an entity merges). Co-locate the call in the feature's
 * service module next to the entity definition (mirrors `registerSubjectEraser`).
 */
export function declarePiiFields(
  entity: string,
  fields: readonly string[],
  opts: DeclarePiiFieldsOptions = {},
): void {
  const global = opts.maskGloballyByFieldName ?? true;
  const set = registry.get(entity) ?? new Set<string>();
  for (const f of fields) {
    set.add(f);
    if (global) allPiiFieldNames.add(f);
  }
  registry.set(entity, set);
}

/** O(1) — is `field` a declared PII field of `entity`? */
export function isPiiField(entity: string, field: string): boolean {
  return registry.get(entity)?.has(field) ?? false;
}

/** O(1) — is `field` a PII field of ANY declared entity? The masking deep-walk fast path. */
export function isKnownPiiFieldName(field: string): boolean {
  return allPiiFieldNames.has(field);
}

/**
 * The classification of an entity: `confidential-pii` if it has any declared PII field,
 * else the `internal` default. (`public` is opt-in via a future explicit declaration —
 * nothing defaults to public.)
 */
export function classificationOf(entity: string): DataClassification {
  return (registry.get(entity)?.size ?? 0) > 0 ? 'confidential-pii' : 'internal';
}

/** Introspection for tests + the lint. */
export function piiFieldRegistry(): ReadonlyMap<string, ReadonlySet<string>> {
  return registry;
}

/**
 * Heuristic: does a field NAME look like PII? Used by (a) the Phase-1 lint that flags
 * obvious-PII fields lacking an explicit declaration, and (b) Phase-2 masking as a
 * conservative secondary signal. Deliberately narrow — high-precision shapes only.
 */
// High-precision PII-name detection. Two checks on the snake-normalized name:
//  - EXACT standalone PII words (so `email`/`phone` match, but `emailSubject`,
//    `phoneType` do NOT — substring matching over-masked operational compounds like
//    `ipAddress`/`fromAddress`/`emailSubject`, code-review MEDIUM); and
//  - explicit PII COMPOUNDS (so `firstName`/`dateOfBirth`/`streetAddress` match, but
//    `ipAddress`/`addressBookId` do not, since `ip_address`/`address_book` aren't listed).
// (Declared fields like `email`/`displayName` are masked everywhere anyway via the
// registry UNION — the heuristic exists only to catch UNDECLARED PII.)
const PII_EXACT = new Set(['email', 'phone', 'mobile', 'ssn', 'sin', 'dob', 'fax', 'surname', 'passport']);
const PII_COMPOUND = /(first_name|last_name|full_name|display_name|given_name|family_name|date_of_birth|email_address|home_address|street_address|mailing_address|postal_address|billing_address|shipping_address|phone_number|mobile_number|zip_code|post_code|national_id|tax_id)/;
export function looksLikePiiName(field: string): boolean {
  // Normalize camelCase / kebab / dotted → snake so all spellings collapse to one form.
  const normalized = field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s]+/g, '_')
    .toLowerCase();
  return PII_EXACT.has(normalized) || PII_COMPOUND.test(normalized);
}

// ── PII log masking (ADR 0077 Phase 2) ──────────────────────────────────────────
//
// Pseudonymize a PII value for logs: `pii_<first 10 hex of sha256(value)>`. PLAIN
// SHA-256 (keyless) is deliberate — it is DETERMINISTIC across processes + restarts, so
// the same value yields the same token and log lines stay correlatable. This is
// correlation-preserving PSEUDONYMIZATION, NOT encryption: low-cardinality PII (a small
// name set) is dictionary-reversible by anyone who already has log access + the value
// space. That is acceptable here — the control's goal is preventing CASUAL/accidental
// log exposure (screenshots, a non-targeted pipeline breach), not defeating a targeted
// attacker (who must never have log access). For true irreversibility, swap to an opaque
// marker for `confidential-pii` contexts (loses correlation).
/**
 * ADR 0733 — the VALUE-shaped email scanner, exported as the SSoT so the other sinks
 * that carry the same bytes (`host/exceptionProjection.ts`, `middleware/errorEnvelope.ts`)
 * can reuse it rather than growing a seventh copy of an email regex.
 *
 * NOT one of the six in-tree `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` copies. Those are ANCHORED
 * validators; unanchored as a scanner that shape backtracks super-quadratically —
 * MEASURED on node v22.22.3 with `'a'.repeat(n) + '@' + 'b'.repeat(n)` (no dot, so the
 * match is forced to fail only after exhausting the alternatives): n=2000 → 28ms,
 * n=4000 → 112ms, n=8000 → 465ms. That would run on the error path, on
 * attacker-influenceable strings, some unbounded (a child process folds captured stdio
 * into its error message). So: bounded character classes, no nested quantifier over the
 * same class, and a hard cap on how much of a string is scanned at all.
 */
const EMAIL_VALUE_SCAN =
  /[\p{L}\p{M}\p{N}._%+'-]{1,64}@[\p{L}\p{M}\p{N}-]{1,63}(?:\.[\p{L}\p{M}\p{N}-]{1,63}){0,3}\.\p{L}[\p{L}\p{M}\p{N}-]{1,62}/gu;

/**
 * The final label MUST start with a letter (`\.\p{L}…`), and that is a correctness
 * requirement, not tidiness. Review finding 2: with an all-numeric final label allowed,
 * `pkg@1.2.3` is email-shaped, so THIS repo's most common identifier form hashed on a
 * default-ON path — `manifest_identity_mismatch: requested core.openwop.workflows.crm@1.4.0,
 * got …@1.4.1` (`packs/registryInstaller.ts`, logged by `bootstrap/installRegistryPacks.ts`)
 * became two identical-looking hashes, destroying the pin-drift lane ENG-PACKS-1 exists to
 * debug. Every real TLD begins with a letter, punycode (`xn--p1ai`) included, so this costs
 * no recall. The ADR rejected phone scanning because digit runs cannot be told from
 * operational integers; a numeric-TLD "email" cannot be told from a semver specifier, and
 * the same argument decides it the same way.
 *
 * CORRECTION (CLNP-5, 2026-09-25) — "starts with a letter" was necessary but not
 * sufficient. A ONE-letter final label still matched, so `sdk@1.0.x`, `pkg@1.2.x` and
 * `@a2a-js/sdk@1.0.x` (a live pin string in this repo) kept hashing. No delegated TLD is
 * one character, so the final label now needs at least TWO (`{1,62}` after the leading
 * letter); `a@b.io` still masks. Still over-masked, and deliberately left alone: GCP
 * service accounts (they ARE email-shaped) and DSN/URL userinfo (`user:pw@host.tld`),
 * which no live `log.*` payload carries today.
 *
 * `\p{L}`/`\p{M}`/`\p{N}` rather than `[A-Za-z0-9]` (finding 3): `josé@example.com` and
 * `alice@münchen.de` were silently unmasked by the ASCII-only class — a recall hole in a
 * control whose whole job is recall. `\p{M}` is not decoration: an NFD-decomposed `é` is
 * `e` + U+0301, a COMBINING MARK, so a `\p{L}`-only class masked the composed spelling of
 * a name and missed the decomposed one — the same address, two encodings, two answers. Residual, stated plainly: a local part using an RFC
 * special outside this class (`!#$%&*\/=?^\`{|}~`) still masks only from the last in-class
 * run, and quoted (`"a b"@x.com`) and IP-literal (`a@[192.168.1.1]`) forms do not match at
 * all. Those specials are NOT added because `/`, `?` and `=` would swallow a URL query into
 * one mask and take the path with it.
 */

/** Strings longer than this are scanned only up to the cap — plus whatever address
 *  STRADDLES it. See `maskEmailsInText`. */
const EMAIL_SCAN_MAX_CHARS = 8192;

/**
 * The scanner's SHAPE, as inert strings, so a ratchet can assert the bounded-quantifier
 * property without holding the regex itself. `EMAIL_VALUE_SCAN` stays module-private on
 * purpose: it carries the `g` flag, so a `.test()` on it from another module would advance
 * `lastIndex` and silently skip every other call.
 */
export const EMAIL_SCANNER_SHAPE: { readonly source: string; readonly flags: string } = Object.freeze({
  source: EMAIL_VALUE_SCAN.source,
  flags: EMAIL_VALUE_SCAN.flags,
});

/** Single address character — used ONLY to find a safe cut point. Deliberately NOT
 *  global: a `g` regex carries `lastIndex` across `.test()` calls and would skip every
 *  other character. */
const ADDRESS_CHAR = /[\p{L}\p{M}\p{N}._%+'@-]/u;

/** Longest address the scanner can match: 64-char local + `@` + 255-char domain. The
 *  straddle extension is bounded by this, so the cost guarantee above still holds. */
const EMAIL_MAX_LEN = 320;

/**
 * Replace every email-shaped run in `text` with the shared `pii_<10hex>` marker.
 *
 * The `indexOf('@')` guard is not an optimisation detail, it is what makes scanning
 * EVERY string leaf affordable, and therefore what lets this control cover `stack`,
 * `err`, `errorMessage` and `cause` without a key allowlist to maintain. MEASURED over
 * 1M typical 70-char messages: unguarded +410% vs the existing secret passes; guarded
 * +17%.
 */
export function maskEmailsInText(text: string): string {
  if (text.indexOf('@') < 0) return text;
  if (text.length <= EMAIL_SCAN_MAX_CHARS) return text.replace(EMAIL_VALUE_SCAN, (m) => maskPiiValue(m));
  // A FIXED cut leaks (review finding 1): `'x'.repeat(8180) + 'alice@example.com'` put
  // `alice@exampl` in the head — no dot, so no match — and `e.com` in the verbatim tail,
  // reassembling the address perfectly in the output. Extend the cut forward through any
  // run of address characters so a straddling address lands WHOLE in the scanned half.
  let cut = EMAIL_SCAN_MAX_CHARS;
  const limit = Math.min(text.length, EMAIL_SCAN_MAX_CHARS + EMAIL_MAX_LEN);
  while (cut < limit && ADDRESS_CHAR.test(text[cut]!)) cut++;
  return text.slice(0, cut).replace(EMAIL_VALUE_SCAN, (m) => maskPiiValue(m)) + text.slice(cut);
}

export function maskPiiValue(value: string): string {
  return `pii_${createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
}

/**
 * Key-aware deep walk that masks the VALUES of PII-named fields (ADR 0077 P2). A value
 * is masked iff its KEY is a declared PII field (`isKnownPiiFieldName`) or — when
 * `heuristic` is on — its key `looksLikePiiName`. Operational fields (`runId`, `count`,
 * `status`) are never masked WHOLE by the key pass.
 *
 * CORRECTED 2026-09-19 (ADR 0733): this used to end "so this cannot over-mask". With
 * `values: true` that is no longer true in the strict sense — the value pass rewrites
 * email-shaped RUNS inside any string leaf, including operational fields like `error`
 * and `stack`. That is the point: a name-keyed mask cannot see an address embedded in a
 * driver's error text. The value pass is substring-scoped (the rest of the message
 * survives), email-only, and separately flagged. A NEW walk (not
 * `sanitizeFreeTextDeep`, which is value-only and loses the key). Cycle-SAFE (GOV-6): a
 * `WeakSet` of in-progress objects short-circuits a reference cycle to `'[Circular]'`
 * instead of recursing forever — a self-referential log payload no longer stack-overflows
 * the logger's emit() (it still runs inside emit()'s try/catch as defence in depth).
 */
export function maskPiiDeep(value: unknown, opts: { heuristic?: boolean; values?: boolean } = {}): unknown {
  const heuristic = opts.heuristic ?? true;
  const values = opts.values ?? false;
  const seen = new WeakSet<object>();
  const keyIsPii = (k: string): boolean => isKnownPiiFieldName(k) || (heuristic && looksLikePiiName(k));
  const maskLeaf = (v: unknown): unknown =>
    (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? maskPiiValue(String(v)) : walk(v);
  function walk(v: unknown): unknown {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]'; // a cycle — short-circuit instead of recursing forever
      seen.add(v);
      const out: unknown = Array.isArray(v)
        ? v.map(walk)
        : Object.fromEntries(
            // The KEY is a string leaf too (review finding 4): an address-keyed counter
            // (per-recipient bounce tallies) emitted its addresses intact.
            Object.entries(v as Record<string, unknown>).map(([k, val]) => [
              values ? maskEmailsInText(k) : k,
              keyIsPii(k) ? maskLeaf(val) : walk(val),
            ]),
          );
      seen.delete(v); // allow the SAME object reached via a sibling path (not a cycle) to mask normally
      return out;
    }
    if (values && typeof v === 'string') return maskEmailsInText(v);
    return v;
  }
  return walk(value);
}

/**
 * Data-plane field masking (ADR 0268 / CDP-F Phase 2) — the read-serialization
 * counterpart to `maskPiiDeep` (which is log-only). Given an ENTITY name + a record,
 * mask the VALUES of that entity's declared PII fields (`isPiiField`) using the same
 * deterministic pseudonymizer. Entity-scoped (uses the precise per-entity registry,
 * not the heuristic name union), so it never over-masks an operational field. Callers
 * apply this at a read seam when the caller lacks a PII-read scope — enforcement of
 * WHO may see unmasked PII stays with the route's scope check; this is the mechanism.
 * Shallow by design: masks the record's own declared PII fields (nested entities mask
 * via their own call). Non-string PII values are coerced then masked.
 */
export function maskRecordForRead<T extends Record<string, unknown>>(entity: string, record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const key of Object.keys(out)) {
    if (isPiiField(entity, key)) {
      const v = out[key];
      if (v !== undefined && v !== null) out[key] = maskPiiValue(String(v));
    }
  }
  return out as T;
}

/** TEST-ONLY — clear the registry (mirrors `__resetSubjectErasers`). */
export function __resetPiiRegistry(): void {
  registry.clear();
  allPiiFieldNames.clear();
}
