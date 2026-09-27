/**
 * Config-domain registry (ADR 0387) — the dependency-inversion seam that lets a
 * config OWNER contribute its snapshot/restore/diff logic to `environments`
 * WITHOUT `environments` importing the owner's internals. Mirrors
 * `forms/submissionSinks.ts` (ADR 0330): a module-private array, an idempotent
 * registrar the owner calls at boot, and an integrator (`environmentsService`)
 * that iterates the registered contributors.
 *
 * Boundary: this host module imports NO feature. Each config owner depends on
 * the host (imports `registerConfigDomain`) and self-registers — never the
 * reverse. `environments` reads the registered set via `listConfigDomains`.
 *
 * Determinism contract (load-bearing — the snapshot hash depends on it):
 * `export()` MUST return an order-normalized, JSON-serializable payload — maps
 * keyed by a stable id, NEVER arrays whose element order depends on a KV scan.
 * Canonical-JSON sorts object KEYS recursively; it does NOT sort array
 * ELEMENTS, so an array payload would hash non-deterministically. A domain that
 * has list-shaped data keys it by id.
 */

/** A per-domain, per-tenant config payload — any JSON-serializable, order-
 *  normalized value (see the determinism contract above). */
export type ConfigDomainPayload = unknown;

export interface ConfigDomainDiff {
  added: number;
  changed: number;
  removed: number;
}

/**
 * ONE entry-level change inside a domain payload — the value-level view behind
 * the counts in `ConfigDomainDiff`.
 *
 * `path` is the flattened key (`orgId/funnelId` for a nested payload like
 * publish-pointers, a bare id for a flat one like feature-toggles), matching how
 * those domains already flatten inside their own `diff()`.
 */
export interface ConfigEntryChange {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  /** Absent for `added` — there was no prior value. */
  from?: unknown;
  /** Absent for `removed` — there is no incoming value. */
  to?: unknown;
}

export interface ConfigEntryDiff {
  changes: ConfigEntryChange[];
  /** Entries beyond `cap` that were not listed. The UI must say so rather than
   *  imply the list is complete — a truncated diff that looks whole is exactly
   *  the "counts you can't verify" problem this feature exists to fix. */
  truncated: number;
}

/**
 * Flatten a domain payload into `path → leaf` pairs.
 *
 * Safe to do generically because of the determinism contract above: payloads are
 * order-normalized MAPS keyed by stable ids, never arrays. A nested plain object
 * is a nested map (publish-pointers is `{orgId: {funnelId: status}}`); anything
 * that is not a plain object is a leaf.
 */
function flattenPayload(value: unknown, prefix = '', out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flattenPayload(v, prefix ? `${prefix}/${k}` : k, out);
  }
  return out;
}

/**
 * A generic VALUE-level diff of two domain payloads.
 *
 * Deliberately generic rather than a new `ConfigDomain` method: the determinism
 * contract already guarantees the payload shape, so every registered domain —
 * including ones added later, by anyone — gets this for free instead of having
 * to implement it. The per-domain `diff()` remains the source of truth for the
 * COUNTS; this is the detail behind them.
 *
 * Carries no data the snapshot does not already contain — it reports what is in
 * the payload, and the payload is what `export()` captured. Notably it does NOT
 * reach for secrets: ADR 0387's "secret VALUES are never copied" is a property
 * of `export()`, so a value-level view of the same payload cannot leak one that
 * was not already there.
 */
export function diffEntries(
  from: ConfigDomainPayload | undefined,
  to: ConfigDomainPayload,
  cap = 50,
): ConfigEntryDiff {
  const a = flattenPayload(from ?? {});
  const b = flattenPayload(to);
  const all: ConfigEntryChange[] = [];

  for (const [path, toVal] of b) {
    if (!a.has(path)) all.push({ path, kind: 'added', to: toVal });
    else if (JSON.stringify(a.get(path)) !== JSON.stringify(toVal)) {
      all.push({ path, kind: 'changed', from: a.get(path), to: toVal });
    }
  }
  for (const [path, fromVal] of a) {
    if (!b.has(path)) all.push({ path, kind: 'removed', from: fromVal });
  }

  // Stable order so a preview is reproducible between calls (and so the cap
  // takes a deterministic slice rather than an arbitrary one).
  all.sort((x, y) => x.path.localeCompare(y.path));
  return { changes: all.slice(0, cap), truncated: Math.max(0, all.length - cap) };
}

export interface ConfigDomain {
  /** Stable domain id (e.g. `feature-toggles`, `publish-pointers`). Re-registering
   *  an id REPLACES the prior contributor (idempotent across boots). */
  id: string;
  /** Human label for the environments UI. */
  label: string;
  /** Capture this tenant's current config for the domain. MUST be
   *  order-normalized + deterministic (same live state ⇒ byte-identical JSON). */
  export(tenantId: string): Promise<ConfigDomainPayload>;
  /** Restore a captured payload onto the tenant's live config. TWO registers
   *  (ADR 0479 correction — the original comment claimed one, but the built
   *  domains already disagreed):
   *   - STATE domains (feature-toggles): EXACT-MATCH — apply everything in
   *     the payload AND clear live config it omits, so `import(export(state))`
   *     leaves zero drift.
   *   - PRODUCTION-POINTER domains (publish-pointers, workflow-pins):
   *     APPLY-ONLY — omitted live pointers are left untouched (clearing them
   *     would change production behavior, e.g. a cleared workflow pin flips
   *     launches back to head); environment DRIFT detection is the honesty
   *     surface for the divergence. */
  import(tenantId: string, payload: ConfigDomainPayload): Promise<void>;
  /** Summarize the difference between two captured payloads (both from THIS
   *  domain's `export`). Pure — no side effects, no I/O. */
  diff(from: ConfigDomainPayload | undefined, to: ConfigDomainPayload): ConfigDomainDiff;
  /** ADR 0479 — which register this domain's import belongs to (typed so the
   *  UI can label "removed" counts honestly instead of hardcoding ids):
   *  'exact-match' clears omitted live config; 'apply-only' keeps it (drift
   *  is the honesty surface). */
  restore: 'exact-match' | 'apply-only';
}

const domains: ConfigDomain[] = [];

/** Owner-facing registrar (called at the owning feature's boot). Idempotent:
 *  re-registering the same id replaces, so repeated boots don't duplicate. */
export function registerConfigDomain(domain: ConfigDomain): void {
  const i = domains.findIndex((d) => d.id === domain.id);
  if (i >= 0) domains[i] = domain;
  else domains.push(domain);
}

/** The registered domains, in registration order (stable for hashing — the
 *  snapshot keys payloads by domain id, so order is not itself hashed, but a
 *  stable order keeps the UI predictable). */
export function listConfigDomains(): readonly ConfigDomain[] {
  return domains;
}

export function getConfigDomain(id: string): ConfigDomain | undefined {
  return domains.find((d) => d.id === id);
}

/** Test seam — clear registrations between tests (mirrors
 *  `clearSubmissionSinksForTest`). */
export function clearConfigDomainsForTest(): void {
  domains.length = 0;
}
