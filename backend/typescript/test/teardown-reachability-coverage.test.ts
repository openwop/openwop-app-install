/**
 * PROPC-ERASURE-RATCHET-BLINDSPOT — the tenant-teardown REACHABILITY coverage gate.
 *
 * A structural cure for the class PROPC-ERASURE-TEARDOWN exposed (fixed in #3524):
 * a feature `DurableCollection` whose rows are NOT reachable by the generic tenant
 * teardown (`purgeTenantHostExt` → `purgeTenantRows`) survives account deletion.
 * `purgeTenantRows` matches a row to a tenant via `this.tenantOf(row)` when a
 * `tenantOf` resolver was supplied, else it falls back to `jsonTenantId(parsed)`,
 * which probes ONLY a TOP-LEVEL `tenantId` field. `proposals` keyed
 * `${owner.tenant}::${id}` with the tenant NESTED at `owner.tenant` and NO
 * `tenantOf` → `jsonTenantId` returned undefined → every row SKIPPED → subject PII
 * survived teardown.
 *
 * The subject-erasure COVERAGE ratchet (`subject-erasure-coverage.test.ts`) only
 * enumerates `src/host/**` namespaces and TRUSTS a manual audit for
 * `src/features/**` — so this teardown-reachability class was structurally
 * INVISIBLE for every feature store. This gate closes that blindspot: it
 * enumerates EVERY `new DurableCollection` namespace under `src/features/**`
 * (a fixed, source-derived denominator — immune to the lazy-construction
 * false-green a pure-runtime registry enumeration would suffer for a PII gate)
 * and requires each to be tenant-teardown-reachable by exactly ONE of three
 * signals, or classified with a cited reason:
 *
 *   1. a `tenantOf` resolver (the 4th constructor arg), OR
 *   2. the key-fn references a top-level `<param>.tenantId` (⇒ the row carries a
 *      top-level `tenantId` field `jsonTenantId` finds), OR
 *   3. (hand-classified) the row carries a top-level `tenantId` field the key
 *      doesn't reference / a registered `registerTenantPurgeHook` (ADR 0590)
 *      sweeps it / it is host-global with no tenant dimension (EXEMPT) / it is a
 *      known un-reachable orphan gap (RECORDED_DEBT, shrink-only).
 *
 * A NEW feature store that is neither auto-reachable nor classified FAILS this
 * test the day it is written — the born-red the blindspot never had. The
 * `proposals` construction BEFORE #3524 (no `tenantOf`, nested `owner.tenant`)
 * would have been auto-pass=false AND unclassified ⇒ red.
 *
 * NOTE THE PROBE THAT BUILT THE MAP WAS FALLIBLE (it mis-read `tenantId` on
 * flat-bodied types 3× during authoring). The gate therefore does NOT ship
 * fragile static type-analysis: signals 1–2 are robust constructor-shape facts,
 * and signal 3 is a hand-audited, per-entry-cited map (the
 * `subject-erasure-coverage` precedent). The runtime witness below proves the
 * MECHANISM the map's REACHABLE_* verdicts rest on, and the detection
 * self-sabotage proves signals 1–2 are not vacuous.
 *
 * COVERAGE BOUNDARY (stated, not silently omitted): this gate enumerates DIRECT
 * `new DurableCollection('<literal-ns>', …)` constructions under `src/features/**`.
 * It does NOT reach collections created by a PARAMETRIC FACTORY whose
 * `new DurableCollection` lives in `src/host` with a computed namespace —
 * `durableQueue` (`queue:${name}`) and `obligationLedger` (`config.ns`/`runsNs`),
 * which features instantiate (commerce/affiliate, kicktodo-commerce, the
 * operations DLQ). This is the SAME boundary `subject-erasure-coverage.test.ts`
 * draws; obligation-ledger teardown/retention is reasoned separately in ADR 0464
 * §4 (money-truth), and the durable DLQ has its own subject snapshot/replay seam
 * (`operations/routes.ts` → `snapshotDurableDlqSubjects`). A new feature that
 * needs teardown coverage for a factory-created collection must extend one of
 * those seams, not this gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  DurableCollection,
  initHostExtPersistence,
  purgeTenantHostExt,
} from '../src/host/hostExtPersistence.js';

const FEATURES_ROOT = join(__dirname, '..', 'src', 'features');

type Bucket =
  | 'REACHABLE_ROW_TENANTID'
  | 'REACHABLE_PURGE_HOOK'
  | 'EXEMPT'
  | 'RECORDED_DEBT';

// ── The static parser: every `new DurableCollection<T>('ns', keyFn, …)` under
//    src/features. Paren-balanced + comment-stripped so a construction that
//    spans lines is read whole and a `new DurableCollection` inside a docblock
//    (the marketplace/erasure.ts grep-example) is not counted. ────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip `//…` line comments and `/*…*​/` block comments (string-literal-naive,
 *  which is fine here — we only need to not match `new DurableCollection` inside
 *  a docblock). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Extract the paren-balanced argument list beginning at `openIdx` (the `(`). */
function extractArgs(src: string, openIdx: number): string[] {
  let depth = 0;
  let inStr: string | null = null;
  let tpl = 0;
  const args: string[] = [];
  let cur = '';
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inStr) {
      cur += c;
      if (c === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (c === '`') {
      tpl ^= 1;
      cur += c;
      continue;
    }
    if (tpl) {
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (depth === 1 && c === '(') continue;
      cur += c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return args;
}

interface Site {
  ns: string;
  keyFn: string;
  hasTenantOf: boolean;
  file: string;
  line: number;
}

function parseSites(): Site[] {
  const sites: Site[] = [];
  for (const file of walk(FEATURES_ROOT)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const re = /new\s+DurableCollection\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const openIdx = m.index + m[0].length - 1;
      const args = extractArgs(src, openIdx);
      const ns = (args[0] ?? '').replace(/^['"`]|['"`]$/g, '');
      // A DurableCollection namespace is a lowercase-initial token; anything else
      // (e.g. a stray regex-in-a-comment the strip missed) is not a real store.
      if (!/^[a-z][A-Za-z0-9:_-]*$/.test(ns)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const hasTenantOf = args.length >= 4 && args[3] !== '' && args[3] !== 'undefined';
      sites.push({ ns, keyFn: args[1] ?? '', hasTenantOf, file, line });
    }
  }
  return sites;
}

/** The key-fn references a TOP-LEVEL `<param>.tenantId` (⇒ the row carries a
 *  top-level `tenantId` field `jsonTenantId` will find). */
function keyRefsTopLevelTenantId(keyFn: string): boolean {
  const pm = keyFn.match(/^\(?\s*(\w+)\s*\)?\s*=>/);
  if (!pm) return false;
  return new RegExp('\\b' + pm[1] + '\\.tenantId\\b').test(keyFn);
}

function isAutoReachable(site: Site): boolean {
  return site.hasTenantOf || keyRefsTopLevelTenantId(site.keyFn);
}

// One row per namespace; a namespace with ANY tenantOf'd handle is reachable.
function distinctNamespaces(sites: Site[]): Map<string, Site> {
  const byNs = new Map<string, Site>();
  for (const s of sites) {
    const prev = byNs.get(s.ns);
    if (!prev || (isAutoReachable(s) && !isAutoReachable(prev))) byNs.set(s.ns, s);
  }
  return byNs;
}

// ── The hand-audited classification for every namespace NOT auto-reachable.
//    Each entry cites its evidence. Generated from a per-type read (the probe
//    that assisted was fallible — every REACHABLE_ROW_TENANTID was confirmed by
//    reading the row type). Fixing a RECORDED_DEBT store (adding a `tenantOf`)
//    makes it auto-reachable ⇒ REMOVE its entry here (the no-dead-entries test
//    enforces that). ──────────────────────────────────────────────────────────

const RESIDUAL_CLASSIFICATION: Record<string, { bucket: Bucket; reason: string }> = {
  'analytics:identity-link': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type IdentityLink carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'analytics:visitor-salt': { bucket: 'EXEMPT', reason: 'host-global per-UTC-day visitor-hashing salt (DailySalt {day,salt}); not tenant-scoped, no subject data' },
  'assistant:commitment:by-status': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantAssistantIndexes (ADR 0590 registerTenantPurgeHook, assistant/feature.ts) — listByPrefix(`${tenantId}:`) exact-scans the ixId=`${tenantId}:${status}:${commitmentId}` index (trailing colon prevents org:foo/org:foobar collision)' },
  'assistant:commitment:by-tenant': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantAssistantIndexes (ADR 0590 registerTenantPurgeHook, assistant/feature.ts) — listByPrefix(`${tenantId}:`) exact-scans the ixId=`${tenantId}:${commitmentId}` index; primary assistant:commitment has tenantOf' },
  'billing:checkout': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type CheckoutSession & { tenantId: string } carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'billing:webhook-event': { bucket: 'EXEMPT', reason: 'Stripe webhook-event dedup marker keyed by eventId; global idempotency, tenant resolved separately, no subject data' },
  'campaign-brief:briefversion': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type BriefVersion carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'campaign-connectors:sync-state': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type SyncStateRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'campaign-intel:pacing': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type PacingMemo carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'campaign-journeys:enrollment': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type JourneyEnrollment carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'campaign-orchestration:campaignversion': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type CampaignVersion carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'capability-firewall:platform-rules': { bucket: 'EXEMPT', reason: 'host-global singleton (key ()=>\'platform\'); no tenant dimension' },
  'cdp:warehouse-load-approval': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WarehouseApprovalMapRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:anonautowrite:session': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WidgetAnonAutoWriteSession carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:anonwrite:day': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WidgetAnonWriteDay carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:config': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WidgetConfig carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:day': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WidgetDayCount carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:session': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type WidgetSession carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'chatwidget:tokenidx': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by the chat-widget tenant-purge hook (ADR 0590 registerTenantPurgeHook, chat-widget/feature.ts → purgeTenantWidgetTokens) — enumerates the tenant widgets via listByPrefix(`${tenantId}:`) and deletes each one\'s token-index entry; deleteWidget/rotateWidgetToken keep the index in step on the normal paths so only teardown-surviving widgets need it. KNOWN NARROW RESIDUE (pre-existing, not closed here): a token entry orphaned by a SWALLOWED storage error in rotate/delete (.catch(()=>undefined)) has no widget left to enumerate and no tenant on the row, so no tenant-scoped mechanism can reach it' },
  'cms:localegrant': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type CmsLocaleGrant carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:page': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type Page carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:pageexperiment': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type PageExperiment carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:pageversion': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type PageVersion carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:redirect': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type Redirect carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:scheduled': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type ScheduledMarker carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:scheduled-unpublish': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type ScheduledMarker carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'cms:sharedsection': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type SharedSection carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'commerce-connect:webhook-event': { bucket: 'EXEMPT', reason: 'Stripe Connect event dedup marker keyed by event id; global idempotency, no subject data' },
  'commerce:order-idem': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type OrderIdemRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'commerce:spend-approval': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type CommerceApprovalMapRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'connections:connection': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type Connection carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'connections:inbound': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type InboundConfig carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'connections:inbound-session': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by the connections tenant-purge hook (ADR 0590 registerTenantPurgeHook, connections/feature.ts) — enumerates the tenant connections and deletes each connectionId child; the connections-children revoke consumer deletes it on revoke so no orphan survives to teardown' },
  'connections:mcp-reach-pin': { bucket: 'EXEMPT', reason: 'host-global RFC 0199 §B.4 pin keyed by provider|resource (ADR 0753 D5): the verified (resource, issuer, authorize, token) tuple of a provider, identical for every tenant; public endpoint URLs only, no subject data' },
  'connections:oauth-client': { bucket: 'EXEMPT', reason: 'host-global OAuth client registry keyed by provider; secret is BYOK-sealed EncryptedRecord, not subject PII' },
  'connections:pairing': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by the connections tenant-purge hook (ADR 0590 registerTenantPurgeHook, connections/feature.ts) — enumerates the tenant connections and unpairs each connectionId; the connections-children revoke consumer unpairs it on revoke so no orphan survives to teardown' },
  'connections:pendingAuth': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type PendingAuth carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'crm:suppression': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type SuppressionEntry carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'documents:canvasmap': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type { key: string; tenantId?: string; documentId: string } sets tenantId on write (documentsService.ts:825) → jsonTenantId reaches it on purgeTenantRows' },
  'documents:doc': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type DocumentRecord carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'documents:template': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type DocumentTemplate carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'documents:version': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type DocumentVersion carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'email:campaign': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type Campaign carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'email:template': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type EmailTemplate carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'entity:count': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type TypeCountRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'entity:ref-idx': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type RefIndexRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'entity:term-idx': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type TermIndexRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'heartbeat-admin': { bucket: 'EXEMPT', reason: 'host-global singleton (HeartbeatAdminConfig id:\'default\'); operator fleet switch, no tenant/subject' },
  'kb:docrev': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type DocRevisionRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kb:embedusage': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type EmbedUsageRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kb:reindex': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type ReindexJob carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kb:veccache': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type VecCacheRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kicktodo-circle-index': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type { circleId: string; tenantId: string } carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kicktodo-feed-tokens': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type FeedRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kicktodo-grantee-index': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type { granteeSubject: string; circleId: string; tenantId: string } carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'kicktodo-invites': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type InviteRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'knowledge-sync:filestate': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type SyncFileState carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'navigation-settings:config': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type StoredMenuConfig carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  // notifications:prefs is AUTO-reachable — its composite key references
  // `.tenantId` (per-(tenant,user)); no map entry needed.
  'orgs:invite': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type OrgInvitation carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'orgs:invite-hashidx': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type { key: string; inviteId: string; tenantId: string; expiresAt: string } carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'portability:import-claims': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type ImportClaim carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'priority-matrix:schedule': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantPriorityMatrix (ADR 0590 registerTenantPurgeHook, feature.ts:51) — five listId::cardId[::voterId]/ev: collections resolved via the tenant priority-matrix:list rows' },
  'priority-matrix:score': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantPriorityMatrix (ADR 0590 registerTenantPurgeHook, feature.ts:51) — five listId::cardId[::voterId]/ev: collections resolved via the tenant priority-matrix:list rows' },
  'priority-matrix:vote': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantPriorityMatrix (ADR 0590 registerTenantPurgeHook, feature.ts:51) — five listId::cardId[::voterId]/ev: collections resolved via the tenant priority-matrix:list rows' },
  'priority:evidence': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantPriorityMatrix (ADR 0590 registerTenantPurgeHook, feature.ts:51) — five listId::cardId[::voterId]/ev: collections resolved via the tenant priority-matrix:list rows' },
  'priority:intake': { bucket: 'REACHABLE_PURGE_HOOK', reason: 'swept by purgeTenantPriorityMatrix (ADR 0590 registerTenantPurgeHook, feature.ts:51) — five listId::cardId[::voterId]/ev: collections resolved via the tenant priority-matrix:list rows' },
  'users:user': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type User carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
  'webinars:sync-state': { bucket: 'REACHABLE_ROW_TENANTID', reason: 'row type SyncStateRow carries a top-level tenantId field → jsonTenantId reaches it on purgeTenantRows' },
};

/** Shrink-only ratchet: the count of un-reachable orphan gaps may only DECREASE.
 *  Each is a low-severity (no raw PII content: pointers/dedup/counts/indexes)
 *  orphan-on-teardown store fixable with a trivial `tenantOf` or a purge-hook. */
const RECORDED_DEBT_BASELINE = 0;

describe('PROPC-ERASURE-RATCHET-BLINDSPOT — every feature DurableCollection is tenant-teardown-reachable or classified', () => {
  const sites = parseSites();
  const byNs = distinctNamespaces(sites);
  const namespaces = [...byNs.keys()].sort();
  const residual = namespaces.filter((ns) => !isAutoReachable(byNs.get(ns)!));

  it('found a substantial denominator (the parser is not silently empty)', () => {
    // A vacuous parser (0 namespaces) would pass every coverage assertion below.
    expect(namespaces.length).toBeGreaterThan(250);
  });

  it('every namespace is auto-reachable (tenantOf / key.tenantId) OR classified with a cited reason', () => {
    const unclassified = residual.filter((ns) => !RESIDUAL_CLASSIFICATION[ns]);
    // A NEW feature store that is neither auto-reachable nor classified fails
    // HERE — the born-red the blindspot never had (proposals-before-#3524 would
    // have landed in this list). Fix: add a `tenantOf`/top-level-tenantId, OR
    // classify it in RESIDUAL_CLASSIFICATION with a cited reason.
    expect(unclassified, `unclassified feature stores (teardown-reachability unknown):\n${unclassified.join('\n')}`).toEqual([]);
  });

  it('the classification map has no dead entries (each classified ns is really residual)', () => {
    // If a store was FIXED (given a tenantOf), it becomes auto-reachable and
    // leaves `residual` — its map entry must be removed in the same change.
    const residualSet = new Set(residual);
    const dead = Object.keys(RESIDUAL_CLASSIFICATION).filter((ns) => !residualSet.has(ns));
    expect(dead, `stale RESIDUAL_CLASSIFICATION entries (now auto-reachable or renamed — remove them):\n${dead.join('\n')}`).toEqual([]);
  });

  it('RECORDED_DEBT is shrink-only (un-reachable orphan gaps may only decrease)', () => {
    const debt = residual.filter((ns) => RESIDUAL_CLASSIFICATION[ns]?.bucket === 'RECORDED_DEBT');
    expect(debt.length, `teardown-orphan debt rose above the baseline; new gaps:\n${debt.join('\n')}`).toBeLessThanOrEqual(RECORDED_DEBT_BASELINE);
  });
});

describe('PROPC-ERASURE-RATCHET-BLINDSPOT — the mechanism the map rests on (runtime witness)', () => {
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });

  const TENANT = 'org:teardown-witness';

  it('a NO-tenantOf, nested-tenant collection SURVIVES teardown (the failure mode is real)', async () => {
    // The exact proposals-before-#3524 shape: tenant nested at owner.tenant, no
    // top-level tenantId field, no tenantOf resolver.
    interface NestedRow {
      k: string;
      owner: { tenant: string };
      pii: string;
    }
    const nested = new DurableCollection<NestedRow>(
      'test:teardown-witness-nested',
      (r) => `${r.owner.tenant}::${r.k}`,
    );
    await nested.put({ k: 'x', owner: { tenant: TENANT }, pii: 'alice@example.com' });
    expect(await nested.get(`${TENANT}::x`)).not.toBeNull();

    await purgeTenantHostExt(TENANT);

    // UNREACHABLE — jsonTenantId probes only a top-level `tenantId`, finds none,
    // so the row (and its PII) SURVIVES. This is what a missing tenantOf costs.
    expect(await nested.get(`${TENANT}::x`)).not.toBeNull();
  });

  it('a tenantOf-armed collection IS purged on teardown', async () => {
    interface FlatRow {
      k: string;
      tenantId: string;
    }
    const armed = new DurableCollection<FlatRow>(
      'test:teardown-witness-armed',
      (r) => `${r.tenantId}::${r.k}`,
      undefined,
      (r) => r.tenantId,
    );
    await armed.put({ k: 'x', tenantId: TENANT });
    expect(await armed.get(`${TENANT}::x`)).not.toBeNull();

    await purgeTenantHostExt(TENANT);

    expect(await armed.get(`${TENANT}::x`)).toBeNull();
  });
});

describe('PROPC-ERASURE-RATCHET-BLINDSPOT — the detection signals are not vacuous (self-sabotage)', () => {
  it('keyRefsTopLevelTenantId flags a top-level tenantId key and REJECTS a nested-tenant key', () => {
    expect(keyRefsTopLevelTenantId('(s) => `${s.tenantId}:${s.id}`')).toBe(true);
    expect(keyRefsTopLevelTenantId('(r) => r.tenantId')).toBe(true);
    // The proposals shape — the tenant is nested, so this MUST NOT read as reachable.
    expect(keyRefsTopLevelTenantId('(p) => `${p.owner.tenant}::${p.id}`')).toBe(false);
    expect(keyRefsTopLevelTenantId('(w) => w.widgetId')).toBe(false);
  });

  it('the tenantOf (4th-arg) parser distinguishes an armed from an unarmed construction', () => {
    const src =
      "const a = new DurableCollection<T>('x:armed', (r) => r.id, undefined, (r) => r.tenantId);\n" +
      "const b = new DurableCollection<T>('x:unarmed', (r) => r.id);\n";
    const re = /new\s+DurableCollection\s*(?:<[^>]*>)?\s*\(/g;
    const found: Record<string, boolean> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const args = extractArgs(src, m.index + m[0].length - 1);
      const ns = (args[0] ?? '').replace(/^['"`]|['"`]$/g, '');
      found[ns] = args.length >= 4 && args[3] !== '' && args[3] !== 'undefined';
    }
    expect(found['x:armed']).toBe(true);
    expect(found['x:unarmed']).toBe(false);
  });
});
