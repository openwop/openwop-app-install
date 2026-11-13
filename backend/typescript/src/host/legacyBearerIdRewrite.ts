/**
 * ADR 1045 CHAN-F14 (TST-FUD-GC-1 follow-up) — the one-time rewrite of stored
 * legacy env-key principal ids, `bearer:<first 8 raw key chars>`, to the id the
 * same key presents today, `envKeyPrincipalId(key)`.
 *
 * Why: the legacy matching rule is DELETED (CHAN-F14, 2026-11-12), so a stored
 * legacy id matches nothing: delegations an env key minted, its run actors and
 * scheduled jobs lose operator standing (fail closed), and env-key-created org
 * members stay orphaned, until this job rewrites them. openwop-dev ran it in
 * apply mode on 2026-11-12. It stays for white-label installs that upgrade
 * without having run it (0.12.0 called it optional); removing it is TODO
 * `CHAN-F18`. It needs no legacy rule: it maps prefixes from the configured keys.
 *
 * What is rewritten, and only for a prefix exactly ONE configured key holds at
 * the time of the run (an ambiguous prefix is counted and left: nothing says
 * which key minted the record):
 *  - every string VALUE equal to a mapped legacy id, at any depth, in the rows of
 *    every registered `hostext:` collection and in its `hostextidx:` markers
 *    (delegations' `createdBy`, scheduled jobs' and chats' owners and actors,
 *    owner-of-record fields), each row by compare-and-swap;
 *  - org member subjects, through `rekeyMemberSubject` (it re-derives the
 *    workspace-root member id and moves the point-read index entry);
 *  - `metadata.actingUserId` of runs that carry an RFC 0165 owner stamp.
 *
 * What is NOT rewritten (each is counted in the report):
 *  - audit-like collections (`AUDIT_COLLECTIONS`): what was recorded stays as
 *    recorded;
 *  - run owner stamps, and the `actingUserId` of runs WITHOUT a stamp: the
 *    owner block of such a run is derived from `actingUserId` and was echoed in
 *    its persisted `run.started` event, so a rewrite would make the snapshot
 *    disagree with the event log;
 *  - object KEYS and row ids that contain a legacy id (other than members);
 *  - legacy-form ids no configured key's prefix accounts for (a removed key's).
 *
 * Modes, from `OPENWOP_LEGACY_BEARER_REWRITE` (read when the background job runs):
 *  - unset / anything else: does nothing; the job stays pending.
 *  - `report`: scans and logs the counts (`legacy_bearer_rewrite`), writes
 *    nothing; the job stays pending so `apply` can follow.
 *  - `apply`: rewrites, logs the same counts, and completes only when no row
 *    lost its compare-and-swap three times and nothing failed.
 * Ids are never logged: a legacy id IS eight characters of a key.
 *
 * Idempotent and safe on two instances at once: a rewritten value is no longer a
 * legacy id, every kv write is a CAS against the value it read, the member
 * re-key is idempotent, and a run's `actingUserId` merge writes a deterministic
 * value.
 */
import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { OWNER_METADATA_KEY } from './runOwner.js';
import { readKeyTenants } from '../middleware/apiKeyTenants.js';
import { envKeyPrincipalId } from '../middleware/envKeyPrincipal.js';
import { hostExtCollectionPrefixes } from './hostExtPersistence.js';
import { rekeyMemberSubject } from './accessControlService.js';
import { createLogger } from '../observability/logger.js';
import { AUDIT_CHAIN_COLLECTION } from './auditChainService.js';

const log = createLogger('host.legacyBearerIdRewrite');

export const LEGACY_BEARER_REWRITE_ENV = 'OPENWOP_LEGACY_BEARER_REWRITE';
const LEGACY_PREFIX_LENGTH = 8;
/** A legacy-form id: `bearer:` + 1..8 characters (the new form is 16 hex). */
const LEGACY_FORM = /^bearer:[^\s]{1,8}$/;
const CAS_ATTEMPTS = 3;
const RUN_PAGE = 200;

/** Collections whose rows record what happened; their ids stay as recorded. */
export const AUDIT_COLLECTIONS: readonly string[] = [
  // The tamper-evident hash chain (ADR 0301): rewriting an entry breaks `verifyChain`.
  AUDIT_CHAIN_COLLECTION,
  'brand:audit',
  'email:sendlog',
  'analytics:event',
  'crm:merge-event',
  'crm:company-merge-event',
  'crm:stagehistory',
  'billing:webhook-event',
  'commerce-connect:webhook-event',
];
/** Rewritten through `rekeyMemberSubject`, never by the generic walk. */
const MEMBER_COLLECTIONS: readonly string[] = ['access-members', 'access-member-index'];

export type LegacyBearerRewriteMode = 'report' | 'apply';

export interface LegacyBearerRewriteReport {
  mode: LegacyBearerRewriteMode;
  configuredKeys: number;
  /** Prefixes exactly one configured key holds (their ids are rewritten). */
  mappedPrefixes: number;
  /** Prefixes two or more configured keys share (their ids are left). */
  ambiguousPrefixes: number;
  /** Rows with at least one value rewritten (or to be), per collection. */
  rowsByCollection: Record<string, number>;
  /** Index markers with at least one value rewritten (or to be). */
  markers: number;
  /** Values rewritten (or to be) across rows and markers. Not named `values`:
   *  the log sink masks a field of that name as PII (ADR 0733). */
  valueCount: number;
  /** Rows in audit collections that carry a mapped id (left). */
  auditRowsLeft: number;
  /** Rows whose id or an object key contains a mapped id (left). */
  keyedRowsLeft: number;
  /** Legacy-form values no unique configured prefix accounts for (left). */
  unmappedValues: number;
  /** Org member rows whose subject is a mapped id (re-keyed, or to be). */
  members: number;
  /** Stamped runs whose `actingUserId` is a mapped id (rewritten, or to be). */
  runs: number;
  /** Unstamped runs whose `actingUserId` is a mapped id (left). */
  unstampedRunsLeft: number;
  /** Rows that lost their compare-and-swap every attempt (apply only). */
  conflicts: number;
  /** Writes that threw (apply only). */
  failures: number;
}

export function legacyBearerRewriteMode(env: NodeJS.ProcessEnv = process.env): LegacyBearerRewriteMode | null {
  const v = env[LEGACY_BEARER_REWRITE_ENV]?.trim().toLowerCase();
  return v === 'report' || v === 'apply' ? v : null;
}

/** legacy id → new id, for prefixes exactly one configured key holds. */
export function legacyBearerIdMap(): { map: ReadonlyMap<string, string>; configuredKeys: number; ambiguousPrefixes: number } {
  const byPrefix = new Map<string, string[]>();
  let configuredKeys = 0;
  for (const [key] of readKeyTenants()) {
    configuredKeys += 1;
    const prefix = key.slice(0, LEGACY_PREFIX_LENGTH);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(key); else byPrefix.set(prefix, [key]);
  }
  const map = new Map<string, string>();
  let ambiguousPrefixes = 0;
  for (const [prefix, keys] of byPrefix) {
    if (keys.length === 1) map.set(`bearer:${prefix}`, envKeyPrincipalId(keys[0]!));
    else ambiguousPrefixes += 1;
  }
  return { map, configuredKeys, ambiguousPrefixes };
}

interface Walk { next: unknown; values: number; keyed: boolean; unmapped: number }

/** Replace every string value equal to a mapped id, at any depth. */
function rewriteValue(v: unknown, map: ReadonlyMap<string, string>): Walk {
  if (typeof v === 'string') {
    const to = map.get(v);
    if (to !== undefined) return { next: to, values: 1, keyed: false, unmapped: 0 };
    return { next: v, values: 0, keyed: false, unmapped: LEGACY_FORM.test(v) ? 1 : 0 };
  }
  if (Array.isArray(v)) {
    let values = 0; let keyed = false; let unmapped = 0;
    const next = v.map((x) => { const w = rewriteValue(x, map); values += w.values; keyed ||= w.keyed; unmapped += w.unmapped; return w.next; });
    return { next, values, keyed, unmapped };
  }
  if (v !== null && typeof v === 'object') {
    let values = 0; let keyed = false; let unmapped = 0;
    const next: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (map.has(k)) keyed = true;
      const w = rewriteValue(x, map);
      values += w.values; keyed ||= w.keyed; unmapped += w.unmapped;
      next[k] = w.next;
    }
    return { next, values, keyed, unmapped };
  }
  return { next: v, values: 0, keyed: false, unmapped: 0 };
}

function hasMappedId(text: string, map: ReadonlyMap<string, string>): boolean {
  for (const legacy of map.keys()) if (text.includes(legacy)) return true;
  return false;
}

/** The registered collection a key belongs to (the longest matching prefix). */
function collectionOf(key: string, prefixes: readonly string[]): string {
  let best = '';
  for (const p of prefixes) if (key.startsWith(p) && p.length > best.length) best = p;
  return best;
}

export async function runLegacyBearerIdRewrite(storage: Storage, mode: LegacyBearerRewriteMode): Promise<LegacyBearerRewriteReport> {
  const { map, configuredKeys, ambiguousPrefixes } = legacyBearerIdMap();
  const report: LegacyBearerRewriteReport = {
    mode, configuredKeys, mappedPrefixes: map.size, ambiguousPrefixes,
    rowsByCollection: {}, markers: 0, valueCount: 0, auditRowsLeft: 0, keyedRowsLeft: 0, unmappedValues: 0,
    members: 0, runs: 0, unstampedRunsLeft: 0, conflicts: 0, failures: 0,
  };
  const apply = mode === 'apply';

  // ── 1. Every registered hostext collection, and its index markers ──
  const registered = hostExtCollectionPrefixes();
  const rowPrefixes = registered.map((c) => c.prefix);
  const nameOf = (prefix: string): string => prefix.slice('hostext:'.length, -1);
  const seen = new Set<string>();
  const scans: Array<{ listPrefix: string; owner: (key: string) => string; marker: boolean }> = [];
  for (const c of registered) {
    scans.push({ listPrefix: c.prefix, owner: (k) => nameOf(collectionOf(k, rowPrefixes)), marker: false });
    if (c.indexed) {
      const idx = `hostextidx:${nameOf(c.prefix)}:`;
      const idxPrefixes = registered.filter((r) => r.indexed).map((r) => `hostextidx:${nameOf(r.prefix)}:`);
      scans.push({ listPrefix: idx, owner: (k) => collectionOf(k, idxPrefixes).slice('hostextidx:'.length, -1), marker: true });
    }
  }
  for (const scan of scans) {
    const rows = await storage.kvList(scan.listPrefix);
    for (const { key, value } of rows) {
      if (seen.has(key)) continue;
      seen.add(key);
      const collection = scan.owner(key);
      if (MEMBER_COLLECTIONS.includes(collection)) continue;
      if (!value.includes('bearer:')) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { continue; }
      const w = rewriteValue(parsed, map);
      report.unmappedValues += w.unmapped;
      if (w.keyed || hasMappedId(key, map)) report.keyedRowsLeft += 1;
      if (w.values === 0) continue;
      if (AUDIT_COLLECTIONS.includes(collection)) { report.auditRowsLeft += 1; continue; }
      if (apply) {
        const outcome = await casRewrite(storage, key, value, map);
        if (outcome === 'conflict') { report.conflicts += 1; continue; }
        if (outcome === 'failed') { report.failures += 1; continue; }
      }
      report.valueCount += w.values;
      if (scan.marker) report.markers += 1;
      else report.rowsByCollection[collection] = (report.rowsByCollection[collection] ?? 0) + 1;
    }
  }

  // ── 2. Org member subjects ──
  const memberRows = await storage.kvList('hostext:access-members:');
  const memberCounts = new Map<string, number>();
  for (const { value } of memberRows) {
    try {
      const subject = (JSON.parse(value) as { subject?: unknown }).subject;
      if (typeof subject === 'string' && map.has(subject)) memberCounts.set(subject, (memberCounts.get(subject) ?? 0) + 1);
    } catch { /* not a member row */ }
  }
  for (const [legacy, n] of memberCounts) {
    if (!apply) { report.members += n; continue; }
    try {
      report.members += await rekeyMemberSubject(legacy, map.get(legacy)!);
    } catch (err) {
      report.failures += 1;
      log.error('legacy_bearer_rewrite_member_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── 3. Run actors ──
  let before: { createdAt: string; runId: string } | undefined;
  for (;;) {
    const page: readonly RunRecord[] = await storage.listRuns({ limit: RUN_PAGE, ...(before ? { before } : {}) });
    for (const run of page) {
      const acting = run.metadata?.actingUserId;
      if (typeof acting !== 'string' || !map.has(acting)) continue;
      if (!run.metadata?.[OWNER_METADATA_KEY]) { report.unstampedRunsLeft += 1; continue; }
      if (apply) {
        try {
          await storage.mergeRunMetadata(run.runId, { actingUserId: map.get(acting)! });
        } catch (err) {
          report.failures += 1;
          log.error('legacy_bearer_rewrite_run_failed', { error: err instanceof Error ? err.message : String(err) });
          continue;
        }
      }
      report.runs += 1;
    }
    if (page.length < RUN_PAGE) break;
    const last = page[page.length - 1]!;
    before = { createdAt: last.createdAt, runId: last.runId };
  }

  log.info('legacy_bearer_rewrite', { ...report });
  return report;
}

/** Rewrite one row by compare-and-swap, re-reading on a lost swap. */
async function casRewrite(storage: Storage, key: string, firstValue: string, map: ReadonlyMap<string, string>): Promise<'ok' | 'conflict' | 'failed'> {
  let current: string | null = firstValue;
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      if (current === null) return 'ok'; // deleted meanwhile: nothing left to rewrite
      const w = rewriteValue(JSON.parse(current), map);
      if (w.values === 0) return 'ok'; // a concurrent run already rewrote it
      const r = await storage.kvCompareAndSwap(key, current, JSON.stringify(w.next));
      if (r.swapped) return 'ok';
      current = r.actual;
    }
    return 'conflict';
  } catch (err) {
    log.error('legacy_bearer_rewrite_row_failed', { error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}
