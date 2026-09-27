/**
 * CDP W3d — per-tenant purpose-vocabulary registry (ADR 0302; cites RFC 0128 R3).
 *
 * An ADVISORY, HOST-LOCAL catalog of known permitted-purpose codes. It exists to
 * catch NEW consent-purpose drift at capture time — it does NOT turn purposes into
 * a wire enum.
 *
 * ── The RFC 0128 opaque-string contract is UNCHANGED ────────────────────────────
 * RFC 0128 deliberately keeps `permittedPurposes` as OPAQUE strings on the wire; it
 * does NOT freeze an enum. This registry therefore:
 *   - does NOT touch `purposeLabels.ts` (`normalizeLabel` and the R3 onward-hop
 *     egress algebra are byte-for-byte unchanged) — the wire always passes;
 *   - NEVER rejects an already-stored opaque label (retro-stored labels egress
 *     verbatim through the propagation seam — see the "wire-unchanged" test);
 *   - fails OPEN on every read/egress path — `validatePurposes` is a pure advisory
 *     splitter that never throws.
 * The ONLY place it can fail CLOSED is at CONSENT CAPTURE, and only when a tenant
 * has opted into `strictPurposes`. That is a host-local admission choice, not a
 * wire claim — no new RFC, no protocol surface.
 *
 * Single owner: this service is the ONE owner of the tenant purpose vocabulary +
 * the `strictPurposes` flag. Its validators (`validatePurposes` / `assertPurposesAtCapture`)
 * are the ONLY callers consent-capture (and, advisorily, label normalization) use —
 * never a second, drifting copy of the known-purpose set.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/**
 * Host-default seed vocabulary — the codes every tenant starts with. Kept
 * intentionally small + generic (the common consent-purpose taxonomy); a tenant
 * layers its own additions on top and MAY disable a seed code it does not use.
 * These are opaque strings, not a wire enum.
 */
export const PURPOSE_VOCAB_SEED: readonly string[] = [
  'analytics',
  'billing',
  'marketing',
  'personalization',
  'support',
];

/**
 * Per-tenant vocabulary delta over the seed. We store a DELTA (additions +
 * disabled-seed codes) rather than a materialized full list so that a change to
 * the host `PURPOSE_VOCAB_SEED` propagates to every tenant that did not explicitly
 * disable the affected code. `strict` is the per-tenant capture-admission flag.
 */
interface TenantPurposeVocab {
  tenantId: string;
  /** Non-seed codes this tenant added. */
  added: string[];
  /** Seed codes this tenant disabled. */
  removed: string[];
  /** When true, consent capture REJECTS an unknown purpose (host-local). Default false. */
  strict: boolean;
}

const store = new DurableCollection<TenantPurposeVocab>(
  'cdp:purpose-vocab',
  (r) => r.tenantId,
  undefined,
  (r) => r.tenantId,
);

/** A purpose code is an opaque, trimmed, non-empty string. Case is preserved
 *  (the wire treats purposes as opaque — we do NOT case-fold). */
function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function requireCode(raw: unknown): string {
  const code = normalizeCode(raw);
  if (code === null) {
    throw new OpenwopError('validation_error', 'Field `code` is required and MUST be a non-empty string.', 400, { field: 'code' });
  }
  return code;
}

function seedHas(code: string): boolean {
  return PURPOSE_VOCAB_SEED.includes(code);
}

async function load(tenantId: string): Promise<TenantPurposeVocab> {
  return (await store.get(tenantId)) ?? { tenantId, added: [], removed: [], strict: false };
}

/** Effective vocabulary = (seed − disabled) ∪ additions, deduped + sorted. */
function effective(row: TenantPurposeVocab): string[] {
  const set = new Set<string>(PURPOSE_VOCAB_SEED.filter((c) => !row.removed.includes(c)));
  for (const c of row.added) set.add(c);
  return [...set].sort();
}

/** List a tenant's effective purpose vocabulary (seed + its additions). */
export async function listPurposeVocab(tenantId: string): Promise<string[]> {
  return effective(await load(tenantId));
}

/** Add a purpose code to a tenant's vocabulary. Idempotent. Re-enables a
 *  previously disabled seed code. Returns the new effective vocabulary. */
export async function addPurposeCode(tenantId: string, rawCode: unknown): Promise<string[]> {
  const code = requireCode(rawCode);
  const row = await load(tenantId);
  const removed = row.removed.filter((c) => c !== code); // re-enable if it was a disabled seed
  const added = seedHas(code) || removed.length !== row.removed.length
    ? row.added.filter((c) => c !== code) // it's a seed (or was just re-enabled) — no custom entry needed
    : [...new Set([...row.added, code])];
  const next: TenantPurposeVocab = { ...row, added, removed };
  await store.put(next);
  return effective(next);
}

/** Remove a purpose code from a tenant's vocabulary. Disabling a seed code records
 *  it in `removed`; removing a custom addition drops it. Idempotent. Returns the
 *  new effective vocabulary. NOTE: this only shrinks the ADVISORY catalog — it never
 *  touches any already-stored opaque label. */
export async function removePurposeCode(tenantId: string, rawCode: unknown): Promise<string[]> {
  const code = requireCode(rawCode);
  const row = await load(tenantId);
  const added = row.added.filter((c) => c !== code);
  const removed = seedHas(code) ? [...new Set([...row.removed, code])] : row.removed;
  const next: TenantPurposeVocab = { ...row, added, removed };
  await store.put(next);
  return effective(next);
}

/** Whether strict-purpose capture admission is on for the tenant (default false). */
export async function isStrictPurposes(tenantId: string): Promise<boolean> {
  return (await load(tenantId)).strict;
}

/** Set the strict-purpose capture flag. Returns the new value. */
export async function setStrictPurposes(tenantId: string, strict: boolean): Promise<boolean> {
  const row = await load(tenantId);
  const next: TenantPurposeVocab = { ...row, strict };
  await store.put(next);
  return next.strict;
}

/**
 * ADVISORY splitter — partitions `purposes` into `known` / `unknown` against the
 * tenant's effective vocabulary. NEVER throws and NEVER mutates anything: this is
 * the fail-open primitive both consent-capture and (advisorily) label normalization
 * call. Input purposes are normalized (trimmed, non-empty, deduped, opaque/case-
 * preserving); order follows first appearance.
 */
export async function validatePurposes(
  tenantId: string,
  purposes: readonly unknown[],
): Promise<{ known: string[]; unknown: string[] }> {
  const vocab = new Set(await listPurposeVocab(tenantId));
  const seen = new Set<string>();
  const known: string[] = [];
  const unknown: string[] = [];
  for (const raw of purposes) {
    const code = normalizeCode(raw);
    if (code === null || seen.has(code)) continue;
    seen.add(code);
    (vocab.has(code) ? known : unknown).push(code);
  }
  return { known, unknown };
}

/**
 * The CAPTURE hook. Runs `validatePurposes`, then fails CLOSED (400) **only** when
 * the tenant is in strict mode AND at least one purpose is unknown — so new drift
 * is caught at the point of capture. When strict is OFF (the default) it never
 * throws; the caller gets the `unknown` split back to surface as a non-fatal
 * warning. This is the ONLY fail-closed path in this service; every read/egress
 * path stays fail-open, so the RFC 0128 opaque-string wire is unaffected.
 */
export async function assertPurposesAtCapture(
  tenantId: string,
  purposes: readonly unknown[],
): Promise<{ known: string[]; unknown: string[]; strict: boolean }> {
  const strict = await isStrictPurposes(tenantId);
  const split = await validatePurposes(tenantId, purposes);
  if (strict && split.unknown.length > 0) {
    throw new OpenwopError(
      'validation_error',
      `Unknown purpose code(s) rejected under strict-purpose mode: ${split.unknown.join(', ')}.`,
      400,
      { field: 'purposes', unknownPurposes: split.unknown },
    );
  }
  return { ...split, strict };
}

/** Test-only: clear the vocab store. */
export async function __resetPurposeVocabStore(): Promise<void> {
  await store.__clear();
}
