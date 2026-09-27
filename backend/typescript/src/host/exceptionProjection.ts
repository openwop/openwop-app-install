/**
 * ADR 0460 Phase 2 — the host EXCEPTION PROJECTION.
 *
 * A read-first projection over the owners that ALREADY hold the exceptions —
 * never a second store (the `host/reviewProjection.ts` precedent: it composes
 * live owners and stores nothing). The 0438 admin "command center" renders the
 * result as the Exception Ledger.
 *
 * Contract (two established host idioms, deliberately combined):
 *   - KEYED registry, repeat boots overwrite — `rosterLifecycle.ts`'s
 *     `Map<string, fn>` (a feature that re-registers replaces its own source,
 *     so a hot-reload / double-boot never doubles a source).
 *   - PER-SOURCE degradation, never silently empty — `retentionPurger.ts`'s
 *     try/catch-per-registrant returning a `{ ok, error }` result. A source that
 *     throws is reported DEGRADED (so the ledger says "this feed is down"),
 *     never dropped into a misleading "all clear".
 *
 * Honesty invariants (this is an ADR 0460 surface — the whole point is that the
 * admin can trust the ledger):
 *   - fail-closed: no acting tenant ⇒ empty result (never a cross-tenant read);
 *   - each source is TENANT-SCOPED (a `${tenantId}::` prefix read — NO
 *     cross-tenant `DurableCollection.list()` on this path);
 *   - each source is BOUNDED (`SOURCE_ROW_CAP`) and reports `truncated` so a
 *     capped list is never mistaken for "everything";
 *   - every row's `severity`/`owner`/`action` is SERVER-authoritative (derived
 *     from the source record, never client input).
 *
 * The registry is app-generic by construction — any feature may register a
 * source later; ADR 0460 ships the five kicktodo sources.
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.exceptionProjection');

/** Per-source cap — an admin read, not a participant hot path, but still bounded
 *  so one noisy tenant can't unbounded-scan. A capped source sets `truncated`. */
export const SOURCE_ROW_CAP = 200;

/** Severity conveyed BY SHAPE (a category the UI maps to a glyph), never by colour
 *  alone. `degraded` is the source-is-down row the projection injects itself. */
export type ExceptionSeverity = 'blocker' | 'action-required' | 'attention' | 'degraded';

/** The server-authoritative owner of the exception (who must act / whose work it is). */
export interface ExceptionOwner {
  kind: 'user' | 'agent' | 'system';
  /** An opaque ref (subject/rosterId/'system') — never PII. */
  ref: string;
  label: string;
}

/** ONE safe action: a deep-link to the OWNING surface (the projection never acts). */
export interface ExceptionAction {
  labelKey: string;
  /** An in-app path to the owning admin/participant surface. */
  href: string;
}

export interface ExceptionRow {
  /** Mono id, `<source>:<owner-record-id>` (the reviewProjection id convention). */
  id: string;
  /** The registry key that produced this row. */
  source: string;
  severity: ExceptionSeverity;
  /** A short, already-localizable label key OR literal one-liner (server truth). */
  label: string;
  owner: ExceptionOwner;
  action: ExceptionAction;
  audit: { detectedAt: string; tenantId: string };
}

/** A source reads ITS OWN store, tenant-scoped, and returns the exceptions it owns.
 *  It MUST no-op (return []) on a falsy tenant. It MAY throw — the projection
 *  reports that as a degraded source rather than letting it sink the whole read. */
export type ExceptionSource = (tenantId: string) => Promise<ExceptionRow[]>;

/** Per-source outcome — mirrors `retentionPurger`'s `PurgeResult`. */
export interface ExceptionSourceResult {
  key: string;
  ok: boolean;
  count: number;
  truncated: boolean;
  error?: string;
}

export interface ListExceptionsResult {
  rows: ExceptionRow[];
  /** Every registered source's outcome — a down source appears here `ok:false`. */
  sources: ExceptionSourceResult[];
}

const sources = new Map<string, ExceptionSource>();

/** A feature registers (idempotently, keyed) its exception source at boot.
 *  Repeat registration with the same key OVERWRITES (double-boot safe). */
export function registerExceptionSource(key: string, fn: ExceptionSource): void {
  sources.set(key, fn);
}

/** Test-only: drop all registrations so suites don't leak sources across files. */
export function __resetExceptionSources(): void {
  sources.clear();
}

/** Compose every registered source for one tenant. Fail-closed on a blank tenant;
 *  per-source try/catch so a thrown source is reported degraded, never silently
 *  empty; each source capped + `truncated`-flagged. Also emits a synthetic
 *  `degraded` ExceptionRow for a down source so the ledger SHOWS the outage. */
export async function listExceptions(tenantId: string): Promise<ListExceptionsResult> {
  if (!tenantId) return { rows: [], sources: [] };
  const rows: ExceptionRow[] = [];
  const results: ExceptionSourceResult[] = [];
  for (const [key, fn] of sources) {
    try {
      const produced = await fn(tenantId);
      const truncated = produced.length > SOURCE_ROW_CAP;
      const kept = truncated ? produced.slice(0, SOURCE_ROW_CAP) : produced;
      rows.push(...kept);
      results.push({ key, ok: true, count: kept.length, truncated });
      if (truncated) {
        log.warn('exception_source_truncated', { source: key, produced: produced.length, cap: SOURCE_ROW_CAP });
      }
    } catch (err) {
      // A down source is a first-class, VISIBLE exception — never a silent gap.
      const message = err instanceof Error ? err.message : String(err);
      log.error('exception_source_failed', { source: key, error: message });
      rows.push({
        id: `degraded:${key}`,
        source: key,
        severity: 'degraded',
        label: `The "${key}" exception feed could not be read.`,
        owner: { kind: 'system', ref: 'system', label: key },
        action: { labelKey: 'exceptionActionRetry', href: '/admin/kicktodo' },
        audit: { detectedAt: new Date().toISOString(), tenantId },
      });
      results.push({ key, ok: false, count: 0, truncated: false, error: message });
    }
  }
  return { rows, sources: results };
}
