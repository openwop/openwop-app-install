/**
 * ADR 0657 D8 (`CNWF-10` / `CNWF-11`) — the DESTRUCTIVE-LANE CENSUS, enumerated
 * from source.
 *
 * `legal-hold-gates-erasure.test.ts` proves BEHAVIOURALLY that seven lanes
 * honour the tenant legal hold. It cannot see a lane it was not told about: a
 * new sweeper, a new teardown door, a new registration seam — each is a
 * destructive lane that ships ungated until someone remembers to add a case.
 * ADR 0586 D2 said "every destructive lane" while two whole-tenant lanes were
 * in neither its table nor its tests. This file makes "every" a DERIVED set.
 *
 * THE POPULATION is computed from the TypeScript AST of `src/**` (storage
 * adapters excluded — they IMPLEMENT the primitives, they are not lanes), as
 * the union of:
 *   P1  the runner of every REGISTRATION SEAM (`registerSubjectEraser` →
 *       `eraseSubject`, …) — a seam fans out to N registrants, so the runner
 *       is the one place the hold can gate all of them;
 *   P2  every top-level ASYNC function whose NAME says it destroys
 *       (`sweepExpired*`, `__run*Once`, `purgeTenant*`);
 *   P3  the enclosing lane of every CALL of a terminal-destruction PRIMITIVE
 *       (`deleteAllTenantData`, `pruneTerminalRuns`, `pruneOnceByPrefix`, …,
 *       and the seam runners themselves) — this is what derives the ROUTE
 *       doors (`DELETE …/account`, `DELETE …/users/:id`) and the daemon tick.
 *
 * THE MAP (`HOLD_CONSULT`) is hand-kept and says HOW each lane consults the
 * hold. It is non-vacuous in every direction (the ADR's review record):
 *   (a) map keys EQUAL the derived set both ways — an extra row is stale, a
 *       missing row is an uncensused destructive lane;
 *   (b) an `asserts` row is PROVED by scanning that lane's own text (comments
 *       stripped) for a hold consult (`assertNoRetentionHold` /
 *       `getRetentionHold` / `listHeldTenantsFrom` — the three exports of
 *       `host/retentionHold.ts`, pinned);
 *   (c) `inherits-from:<lane>` names an `asserts` row whose text CALLS this
 *       lane, AND every other reference to this lane in `src` sits inside a
 *       gated lane — a gate on the creation lane is not a gate on the use lane;
 *       `registrant-of:<runner>` is the same rule for a seam registrant;
 *       `delegates-to:<lane>` is the reverse edge (this lane's only destruction
 *       is a CALL to an `asserts` lane, and its own text carries no delete);
 *   (d) an `exempt` row carries a PIN the test checks structurally (a table
 *       with no tenant column, a store with no declared PII fields, a
 *       host-global age-out registration, a body with no delete token); a row
 *       that cannot be pinned is `exempt-unpinned`, its reason says which
 *       invariant could not be pinned, and a hard floor bounds how many exist;
 *   (e) a floor on the population and the named lanes the ADR enumerates.
 *
 * Every predicate here is a SPELLING check over stripped source, so the
 * sabotage that proves each one load-bearing is recorded in the PR: removing
 * the `assertNoRetentionHold` call from `eraseSubject` turns (b) red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const SQLITE_SCHEMA = join(SRC, 'storage', 'sqlite', 'schema.ts');
const SQLITE_ADAPTER = join(SRC, 'storage', 'sqlite', 'index.ts');
const RETENTION_HOLD = join(SRC, 'host', 'retentionHold.ts');

// ─────────────────────────────────────────────────────────────────────────────
// The hand-kept map. Lane ids are `<file relative to src>#<anchor>`; an anchor
// is a top-level function name or `<VERB> <route path>` for a route handler.
// ─────────────────────────────────────────────────────────────────────────────

type Pin =
  | { kind: 'no-tenant-column'; table: string; via: string }
  | { kind: 'no-pii-declared'; namespaces: readonly string[] }
  | { kind: 'host-global-ageout'; id: string }
  | { kind: 'no-delete-token' };

type Consult =
  | { mode: 'asserts' }
  | { mode: `inherits-from:${string}` }
  | { mode: `registrant-of:${string}` }
  | { mode: `delegates-to:${string}` }
  | { mode: 'exempt'; reason: string; pin: Pin }
  | { mode: 'exempt-unpinned'; reason: string }; // MUST start with 'GAP: ' — asserted in (d)

const ACCOUNT_TEARDOWN = 'routes/account.ts#DELETE /v1/host/openwop-app/account';
const USERS_ERASE = 'features/users/routes.ts#DELETE /v1/host/openwop-app/users/users/:id';
const HOSTEXT_PURGE = 'host/hostExtPersistence.ts#purgeTenantHostExt';
const RETENTION_PURGE = 'host/retentionPurger.ts#purgeRetained';

const IDEMPOTENCY_TABLE: Pin = { kind: 'no-tenant-column', table: 'idempotency', via: 'pruneOnceByPrefix' };

const HOLD_CONSULT: Record<string, Consult> = {
  // ── the registration-seam runners (P1) — the vector seam's runner sits under teardown below ──
  'host/subjectErasure.ts#eraseSubject': { mode: 'asserts' },
  [RETENTION_PURGE]: { mode: 'asserts' },
  'host/kvAgeOut.ts#__runKvAgeOutOnce': { mode: 'asserts' }, // `listHeldTenantsFrom` — an explicit-storage read, see its docblock
  // The SPOLIATION lane: the hostext walk deletes the `retention-hold` row
  // itself, so it must never run except under a lane that already asserted.
  [HOSTEXT_PURGE]: { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },

  // ── the DSAR doors ───────────────────────────────────────────────────────
  'features/consent/consentService.ts#deleteSubject': { mode: 'asserts' },
  [USERS_ERASE]: { mode: 'asserts' },

  // ── whole-tenant teardown ────────────────────────────────────────────────
  [ACCOUNT_TEARDOWN]: { mode: 'asserts' },
  'host/retentionSweepDaemon.ts#pruneAbandonedAnonTenants': { mode: 'asserts' },
  'host/kanbanService.ts#purgeTenantKanban': { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },
  'host/workflowOwnership.ts#purgeTenantOwnedWorkflowDefs': { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },
  'host/durable/durableQueue.ts#purgeTenantDurableSurfaces': { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },
  'host/vector/vectorTenantPurge.ts#purgeTenantVectors': { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },
  // ADR 0664 D1 — reached from `deleteRosterMemberCascade` (`routes/roster.ts:288`).
  //
  // NOT `inherits-from:` anything: that mode requires the named lane to be an `asserts` row,
  // and MEASURED — neither `rosterCascade.ts` nor its route reads the retention hold. The
  // census surfaced this the moment D1 added the seam, which is what it is for. Recorded as
  // the GAP it is rather than given a justification it does not have.
  // ADR 0664 D1 — the cascade became derivable the moment it called a seam runner, and the
  // census immediately demanded a row for it. It did not have one before because nothing it
  // called was an enumerated primitive — so a lane that deletes boards, schedules, approvals,
  // profiles and notes had been invisible to this census all along. That is the census
  // earning its keep on a lane its author did not anticipate.
  'host/rosterCascade.ts#deleteRosterMemberCascade': {
    mode: 'exempt-unpinned',
    reason: 'GAP: asserts NO retention hold, and neither does its route (`routes/roster.ts:281-289`). Deleting one agent '
      + 'under a legal hold destroys its board, schedules, approvals, profile and notes. PRE-EXISTING — ADR 0664 D1 adds '
      + 'the vector namespace to that list without widening the gap in kind. Filed as `AGKM-11`; not fixed inside a '
      + 'deletion-completeness change because a hold gate here is its own decision with its own callers (three seeders '
      + 'call this cascade, and whether a hold should block demo cleanup is a separate question).',
  },
  // ADR 0666 D2 — `eraseSubjectMemory` became a DERIVED lane the moment it called the namespace
  // purger, and the census immediately demanded a row. This is the same mechanism ADR 0664 D1
  // hit one feature earlier and wrote down 60 lines above; I added the second caller without
  // adding the row, and this census is what caught it.
  //
  // `registrant-of` is the honest mode: the function is reachable ONLY through
  // `registerSubjectEraser` (`host/subjectMemory.ts` registers it and nothing else calls it),
  // and that runner asserts the hold. So unlike its agent-lane sibling below, this lane is
  // hold-gated — which is exactly the asymmetry D2 set out to preserve rather than copy.
  // `PRJWF-1`/`PRJWF-2` — `deleteProject` became census-DERIVABLE the moment it called the
  // namespace purger, which is the same trap ADR 0664 D1 and ADR 0666 D2 each hit in turn. The
  // difference this time is that the lane was ALREADY destructive and simply invisible: it
  // destroys nine kinds of durable state and a `DurableCollection.delete()` is neither a
  // storage-level delete nor a seam runner, so nothing derived it. It now consults the hold in
  // its own text, so it is `asserts` rather than another exemption — the unpinned budget does
  // not move.
  // `DOCWF-2` — NO ROW for `features/documents/documentsService.ts#deleteDocument`, and the
  // absence is deliberate. I added one and case (a) went red, correctly: that check requires the
  // map keys to EQUAL the derived set BOTH ways, and this lane is not derivable. It calls no
  // primitive and no seam runner — only `DurableCollection.delete()` — so a hand-added row is
  // stale by this census's own definition, even though the lane destroys versions (PII-declared
  // content), publicly-served rendered assets and share links.
  //
  // The projects row below IS accepted only because that lane calls the namespace purger, a
  // seam runner. That is the asymmetry worth naming: whether a destructive lane is VISIBLE here
  // depends on which primitive it happens to call, not on how much it destroys. Two lanes in
  // two iterations have been found this way, and both were found by reading, not by the census.
  // Widening the derivation to collection-level deletes is a real change with its own blast
  // radius (it would pull in a large population at once) and is filed as `DOCWF-5` rather than
  // smuggled into a feature fix.
  'features/projects/projectsService.ts#deleteProject': { mode: 'asserts' },
  'host/subjectMemory.ts#eraseSubjectMemory': { mode: `registrant-of:${'host/subjectErasure.ts#eraseSubject'}` },
  'host/vector/vectorTenantPurge.ts#purgeNamespaceVectors': {
    mode: 'exempt-unpinned',
    reason: 'GAP: on the AGENT lane — reached from `deleteRosterMemberCascade`, which asserts NO retention hold, and '
      + 'neither does its route (`routes/roster.ts:281-289`). '
      + 'CORRECTED 2026-09-12 (ADR 0666 D2): this reason used to say "reached ONLY from `deleteRosterMemberCascade`" and '
      + 'that is no longer true — `host/subjectMemory.ts#eraseSubjectMemory` is a second caller. The gap is unchanged in '
      + 'kind because the NEW caller IS hold-gated (through the `eraseSubject` fan-out, see its row above), so the '
      + 'exemption still describes only the agent cascade. Recorded rather than silently left, because nothing asserts '
      + 'this prose and the same branch carries a commit about a tracker row that lied three ways. '
      + 'Deleting one agent under a legal hold already destroyed its board, schedules, '
      + 'approvals, profile and notes; ADR 0664 D1 adds its vector memory to that list without widening the gap in kind. '
      + 'Filed as `AGKM-11`: the cascade should consult the hold like the erasure fan-out does. Deliberately not fixed '
      + 'inside a deletion-completeness change — a hold gate on agent deletion is its own decision with its own callers '
      + '(three seeders call this cascade too, and a seeder blocked by a hold is a different conversation).',
  },
  'host/featureToggles/service.ts#purgeTenantOverrides': { mode: `inherits-from:${ACCOUNT_TEARDOWN}` },
  // The five `registerTenantPurgeHook` registrants run INSIDE `purgeTenantHostExt`.
  'features/assistant/assistantService.ts#purgeTenantAssistantIndexes': { mode: `registrant-of:${HOSTEXT_PURGE}` },
  'features/knowledge-sync/knowledgeSyncService.ts#purgeTenantSyncCursors': { mode: `registrant-of:${HOSTEXT_PURGE}` },
  'features/connections/tenantTeardown.ts#purgeTenantConnectionChildren': { mode: `registrant-of:${HOSTEXT_PURGE}` },
  'features/chat-widget/widgetService.ts#purgeTenantWidgetTokens': { mode: `registrant-of:${HOSTEXT_PURGE}` },
  'features/priority-matrix/priorityMatrixService.ts#purgeTenantPriorityMatrix': { mode: `registrant-of:${HOSTEXT_PURGE}` },

  // ── the retention daemon and the lanes it ticks ──────────────────────────
  'host/runRetentionSweeper.ts#__runRetentionSweepOnce': { mode: 'asserts' },
  'host/runRetentionSweeper.ts#__runTransientDefGcOnce': { mode: 'asserts' },
  'host/workflowComposeTool.ts#sweepExpiredWorkflowProposals': { mode: 'asserts' },
  'host/retentionSweepDaemon.ts#processRetentionSweep': { mode: `delegates-to:${RETENTION_PURGE}` },
  'host/retentionSweepDaemon.ts#pruneEngineTables': {
    mode: 'exempt-unpinned',
    reason: 'GAP: the ADR records this lane exempt because "engine rows carry no subject data", but `pruneTerminalRuns` deletes RUNS, '
      + 'and `runs.tenant_id` exists — the run-retention lane (`__runRetentionSweepOnce`) skips a held tenant\'s runs per row while this '
      + 'lane prunes them by age with no hold read. The invariant "engine rows are not hold-relevant" cannot be pinned; it is contradicted '
      + 'by the sibling lane. Recorded as OPEN `CNWF-16` (WORKFLOWS-ASSESSMENT); this census only names it.',
  },
  'host/retentionSweepDaemon.ts#startRetentionSweepDaemon': {
    mode: 'exempt-unpinned',
    reason: 'GAP: the tick itself prunes two dedupe caches directly. `pruneOnceByPrefix` targets the `idempotency` table (no tenant '
      + 'column — pinnable), but `pruneIdempotentResponses` targets `idempotent_response`, which HAS `tenant_id` and stores served '
      + 'response bodies — so the ADR\'s "host-global cache" reason is false for that half and cannot be pinned. Every other deletion '
      + 'in the tick is a call to a censused lane. Recorded as OPEN `CNWF-17`; needs a per-tenant hold skip in the adapter prune.',
  },

  // ── fire-once claim-slot prunes (the `idempotency` table: `key`, `response_*`, `created_at`; no tenant column) ──
  'host/heartbeatService.ts#pruneStaleHeartbeatClaims': { mode: 'exempt', reason: 'stale scheduler claim slots in a table with no tenant column', pin: IDEMPOTENCY_TABLE },
  'host/scheduleDaemon.ts#pruneStaleScheduleClaims': { mode: 'exempt', reason: 'stale scheduler claim slots in a table with no tenant column', pin: IDEMPOTENCY_TABLE },
  'features/knowledge-sync/knowledgeSyncService.ts#pruneStaleKnowledgeSyncClaims': { mode: 'exempt', reason: 'stale sync claim slots in a table with no tenant column', pin: IDEMPOTENCY_TABLE },
  'features/connections/refreshDaemon.ts#startConnectionsRefreshDaemon': {
    mode: 'exempt',
    reason: 'the tick prunes stale refresh claim slots (no tenant column); its other sweep is a CALL to the censused `sweepExpiredPendingAuth` lane',
    pin: IDEMPOTENCY_TABLE,
  },

  // ── size-hygiene TTL sweeps of caches / ledgers with no declared PII ──────
  'host/egressSentLedger.ts#sweepExpiredEgressSent': { mode: 'exempt', reason: 'accepted-send dedupe ledger (hashed recipient); no PII fields declared', pin: { kind: 'no-pii-declared', namespaces: ['egress:sent'] } },
  'host/emailSentLedger.ts#sweepExpiredEmailSent': { mode: 'exempt', reason: 'accepted-send dedupe ledger; no PII fields declared', pin: { kind: 'no-pii-declared', namespaces: ['email:sent'] } },
  'host/canvasSurface.ts#sweepExpiredCanvasIdem': { mode: 'exempt', reason: 'retry-window idempotency rows; no PII fields declared (subject rows go through `eraseSubjectCanvas`)', pin: { kind: 'no-pii-declared', namespaces: ['canvas:idem'] } },
  'host/kanbanService.ts#sweepExpiredKanbanOperationReceipts': { mode: 'asserts' },
  'host/inMemorySurfaces.ts#sweepExpiredMediaAssets': { mode: 'exempt', reason: '1h TTL of model-facing media bytes; no PII fields declared on `media:bytes`', pin: { kind: 'no-pii-declared', namespaces: ['media:bytes'] } },
  'features/connections/oauthFlow.ts#sweepExpiredPendingAuth': { mode: 'exempt', reason: 'abandoned OAuth state rows (PKCE material); no PII fields declared', pin: { kind: 'no-pii-declared', namespaces: ['connections:pendingAuth'] } },
  'features/analytics/visitorIdentity.ts#sweepExpiredSalts': { mode: 'exempt', reason: 'host-global daily salt rotation — no tenant to hold', pin: { kind: 'host-global-ageout', id: 'analytics:visitor-salt' } },

  // ── state transitions that DELETE nothing ────────────────────────────────
  'executor/approvalGateTimeout.ts#sweepExpiredApprovalGates': { mode: 'exempt', reason: 'times out due approval gates (writes an interrupt resolution); deletes no row', pin: { kind: 'no-delete-token' } },
  'features/commerce/commerceService.ts#sweepExpiredReservations': { mode: 'exempt', reason: 'pending→canceled order transition; the due-index row is derived state cleared via `clearReservationDue`', pin: { kind: 'no-delete-token' } },
  'host/collab/collabRoom.ts#__runCollabHeartbeatOnce': { mode: 'exempt', reason: 'lease refresh + flush retry for in-process rooms; durable state is PUT, never deleted', pin: { kind: 'no-delete-token' } },
};

/** (d) hard floor on rows the census could not pin. Each is a reported GAP.
 *
 *  RAISED 2 -> 4, 2026-09-12 (ADR 0664 D1), DELIBERATELY and with both new rows named:
 *  `deleteRosterMemberCascade` and the `purgeNamespaceVectors` it now calls. Neither asserts
 *  a retention hold; the cascade never did, and the census could not see it until D1 gave it
 *  a seam runner to call. Both are filed as `AGKM-11`.
 *
 *  This ceiling exists so GAPs cannot accumulate silently, so raising it is an act someone
 *  has to justify in writing — this is that justification. It is NOT a licence: the next
 *  addition should close `AGKM-11` and lower it to 2, not raise it to 5. */
const MAX_UNPINNED = 4;

/** (e) the population floor, and the named lanes the ADR enumerates. */
const MIN_LANES = 13;
const NAMED_LANES = [
  HOSTEXT_PURGE,                                              // purgeTenantHostExt / tenant purge hooks — the spoliation lane
  'host/retentionSweepDaemon.ts#processRetentionSweep',       // the retention sweep daemon (governance fan-out)
  'host/runRetentionSweeper.ts#__runRetentionSweepOnce',      // the run sweeper
  'host/runRetentionSweeper.ts#__runTransientDefGcOnce',      // the transient GC
  'host/retentionSweepDaemon.ts#pruneEngineTables',           // pruneEngineTables
  'host/retentionSweepDaemon.ts#startRetentionSweepDaemon',   // the idempotency prune (in the tick)
  'host/retentionSweepDaemon.ts#pruneAbandonedAnonTenants',   // anon-tenant teardown
  ACCOUNT_TEARDOWN,                                           // account teardown
  USERS_ERASE,                                                // the second DSAR door
  'host/subjectErasure.ts#eraseSubject',
];

// ─────────────────────────────────────────────────────────────────────────────
// Derivation inputs.
// ─────────────────────────────────────────────────────────────────────────────

/** P1 — seam → the runner that fans out to its registrants. */
const SEAMS: Record<string, string> = {
  registerSubjectEraser: 'host/subjectErasure.ts#eraseSubject',
  registerRetentionPurger: RETENTION_PURGE,
  registerKvAgeOut: 'host/kvAgeOut.ts#__runKvAgeOutOnce',
  registerTenantPurgeHook: HOSTEXT_PURGE,
  registerVectorTenantPurger: 'host/vector/vectorTenantPurge.ts#purgeTenantVectors',
  // ADR 0664 D1 — the namespace-scoped sibling. The census DERIVES this set from source and
  // refused to let the new seam go uncensused, which is what it is for.
  registerVectorNamespacePurger: 'host/vector/vectorTenantPurge.ts#purgeNamespaceVectors',
};
const SEAM_NAME_RE = /^register\w*(Eraser|Purger|AgeOut|PurgeHook)$/;

/** P2 — a top-level async function whose name says it destroys. */
const DESTRUCTIVE_NAME_RE = /^(sweepExpired\w*|__run\w+Once|purgeTenant\w*)$/;

/** P3 — terminal-destruction primitives: storage-level deletes + the seam runners. */
const PRIMITIVES = new Set([
  'deleteAllTenantData', 'pruneTerminalRuns', 'pruneWebhookDeliveries', 'pruneIdempotentResponses', 'pruneOnceByPrefix',
  ...Object.values(SEAMS).map((id) => id.split('#')[1]!),
]);

/** (b) the hold consults — every export of `host/retentionHold.ts` that reads a hold. */
const HOLD_CONSULT_NAMES = ['assertNoRetentionHold', 'getRetentionHold', 'listHeldTenantsFrom'] as const;
const HOLD_CONSULT_RE = new RegExp(`\\b(${HOLD_CONSULT_NAMES.join('|')})\\s*\\(`);

/** A deletion in a lane's OWN text (for `delegates-to` and the `no-delete-token` pin). */
const DELETE_TOKEN_RE = /\b(kvDelete|deleteAllTenantData|deleteRun|pruneTerminalRuns|pruneWebhookDeliveries|pruneIdempotentResponses|pruneOnceByPrefix|purgeTenant\w*|deleteById)\s*\(|\.delete\s*\(/;

// ─────────────────────────────────────────────────────────────────────────────
// Source walking + AST helpers.
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!p.includes('__tests__')) out.push(...walk(p)); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Comments are not code (the KB-3 lesson): a commented-out consult must not
 *  count. Stripped from the AST's trivia rather than by regex — the regex form
 *  other gates use swallows a template literal whose preceding line comment
 *  happens to contain a backtick (the sqlite schema file is one). */
function stripCommentsOf(sf: ts.SourceFile, src: string): string {
  const ranges = new Map<number, number>();
  const collect = (pos: number): void => {
    for (const r of [...(ts.getLeadingCommentRanges(src, pos) ?? []), ...(ts.getTrailingCommentRanges(src, pos) ?? [])]) ranges.set(r.pos, r.end);
  };
  forEachNode(sf, (n) => { collect(n.getFullStart()); collect(n.getEnd()); });
  let out = src;
  for (const [pos, end] of ranges) out = out.slice(0, pos) + ' '.repeat(end - pos) + out.slice(end);
  return out;
}
function stripComments(src: string): string {
  return stripCommentsOf(ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), src);
}

const rel = (file: string): string => relative(SRC, file).split(sep).join('/');

interface Container {
  id: string;
  file: string;
  anchor: string;
  kind: 'fn' | 'route';
  isAsync: boolean;
  start: number;
  end: number;
  text: string;
}

interface Parsed {
  file: string;
  sf: ts.SourceFile;
  src: string;
  /** `src` with every comment blanked (positions preserved). */
  stripped: string;
  containers: Container[];
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function isFunctionLike(n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression {
  return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

function hasAsync(n: ts.Node): boolean {
  return (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Iterative pre-order walk — a generated file's string-concatenation chain
 *  is deep enough to overflow a recursive `forEachChild` visitor. */
function forEachNode(root: ts.Node, fn: (n: ts.Node) => void): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    fn(n);
    const children: ts.Node[] = [];
    n.forEachChild((c) => { children.push(c); });
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
}

function parseFile(file: string): Parsed {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stripped = stripCommentsOf(sf, src);
  const containers: Container[] = [];
  const add = (anchor: string, kind: Container['kind'], node: ts.Node, isAsync: boolean): void => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    containers.push({ id: `${rel(file)}#${anchor}`, file, anchor, kind, isAsync, start, end, text: stripped.slice(start, end) });
  };
  // Top-level function containers.
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, 'fn', stmt, hasAsync(stmt));
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isFunctionLike(d.initializer)) add(d.name.text, 'fn', stmt, hasAsync(d.initializer));
      }
    }
  }
  // Route-handler containers, anywhere: `<obj>.<verb>('<path>', …, handler)`.
  forEachNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HTTP_VERBS.has(n.expression.name.text)
      && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]!) && n.arguments.slice(1).some(isFunctionLike)) {
      add(`${n.expression.name.text.toUpperCase()} ${n.arguments[0]!.text}`, 'route', n, true);
    }
  });
  return { file, sf, src, stripped, containers };
}

/** Innermost container covering `pos` (a route handler nests inside its registrar). */
function enclosing(p: Parsed, pos: number): Container | undefined {
  let best: Container | undefined;
  for (const c of p.containers) {
    if (pos < c.start || pos >= c.end) continue;
    if (!best || c.end - c.start < best.end - best.start) best = c;
  }
  return best;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Every `Identifier` node reading `name` that is NOT its declaration, an import/export specifier, or a property name. */
function referencesOf(p: Parsed, name: string): Array<{ pos: number; asSeamArgOf?: string }> {
  const out: Array<{ pos: number; asSeamArgOf?: string }> = [];
  forEachNode(p.sf, (n) => {
    if (ts.isIdentifier(n) && n.text === name) {
      const parent = n.parent;
      const isDeclName = (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === n;
      const isImportExport = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent);
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === n)
        || (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isDeclName && !isImportExport && !isPropertyName) {
        const asSeamArgOf = ts.isCallExpression(parent) && parent.arguments.includes(n as ts.Expression) ? calleeName(parent) : undefined;
        out.push({ pos: n.getStart(p.sf), ...(asSeamArgOf ? { asSeamArgOf } : {}) });
      }
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

const FILES = walk(SRC).filter((f) => !rel(f).startsWith('storage/'));
const PARSED = FILES.map(parseFile);
const BY_ID = new Map<string, Container>();
for (const p of PARSED) for (const c of p.containers) BY_ID.set(c.id, c);
const containerOf = (id: string): Container => {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`no container for lane ${id} — the file or function was renamed; update the census`);
  return c;
};

interface Derived {
  lanes: Set<string>;
  seamsInSource: Set<string>;
  primitiveCallsOutsideAnyLane: string[];
}

function derive(): Derived {
  const lanes = new Set<string>();
  const seamsInSource = new Set<string>();
  const primitiveCallsOutsideAnyLane: string[] = [];
  for (const p of PARSED) {
    // P1 — seams declared in source.
    for (const c of p.containers) if (c.kind === 'fn' && SEAM_NAME_RE.test(c.anchor)) seamsInSource.add(c.anchor);
    // P2 — destructive-by-name async functions.
    for (const c of p.containers) if (c.kind === 'fn' && c.isAsync && DESTRUCTIVE_NAME_RE.test(c.anchor)) lanes.add(c.id);
    // P3 — enclosing lane of every primitive call.
    forEachNode(p.sf, (n) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name && PRIMITIVES.has(name)) {
          const c = enclosing(p, n.getStart(p.sf));
          if (c) lanes.add(c.id);
          else primitiveCallsOutsideAnyLane.push(`${rel(p.file)}:${p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf)).line + 1} ${name}(`);
        }
      }
    });
  }
  for (const seam of seamsInSource) { const runner = SEAMS[seam]; if (runner) lanes.add(runner); }
  return { lanes, seamsInSource, primitiveCallsOutsideAnyLane };
}

const DERIVED = derive();

const gatedModes = (id: string): boolean => {
  const row = HOLD_CONSULT[id];
  return !!row && (row.mode === 'asserts' || row.mode.startsWith('inherits-from:') || row.mode.startsWith('registrant-of:'));
};

/** Every reference to a lane's identifier across src, with the lane it sits in. */
function callersOf(laneId: string): Array<{ where: string; lane?: string; asSeamArgOf?: string }> {
  const c = containerOf(laneId);
  if (c.kind !== 'fn') throw new Error(`${laneId} is a route — routes have no identifier to reference`);
  const out: Array<{ where: string; lane?: string; asSeamArgOf?: string }> = [];
  for (const p of PARSED) {
    for (const ref of referencesOf(p, c.anchor)) {
      if (p.file === c.file && ref.pos >= c.start && ref.pos < c.end) continue; // self (recursion / its own docblock)
      const lane = enclosing(p, ref.pos);
      const { line } = p.sf.getLineAndCharacterOfPosition(ref.pos);
      out.push({ where: `${rel(p.file)}:${line + 1}`, ...(lane ? { lane: lane.id } : {}), ...(ref.asSeamArgOf ? { asSeamArgOf: ref.asSeamArgOf } : {}) });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pins.
// ─────────────────────────────────────────────────────────────────────────────

const SQLITE_SCHEMA_SRC = stripComments(readFileSync(SQLITE_SCHEMA, 'utf8'));
const SQLITE_ADAPTER_SRC = stripComments(readFileSync(SQLITE_ADAPTER, 'utf8'));

function createTableColumns(table: string): string[] {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\);`).exec(SQLITE_SCHEMA_SRC);
  if (!m) throw new Error(`no CREATE TABLE for ${table} in the sqlite schema`);
  return m[1]!.split('\n').map((l) => l.trim()).filter((l) => l && !/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)/i.test(l)).map((l) => l.split(/\s+/)[0]!);
}

/** All `declarePiiFields('<ns>'` namespaces in src — the PII SSoT. */
const PII_DECLARED = new Set<string>();
/** All `new DurableCollection(…'<ns>'` declarations in src, by file — multi-line aware. */
const STORES_BY_FILE = new Map<string, Set<string>>();
{
  const STORE_RE = /new DurableCollection(?:<[\s\S]*?>)?\s*\(\s*['"]([^'"]+)['"]/g;
  const PII_RE = /declarePiiFields\(\s*['"]([^'"]+)['"]/g;
  for (const p of PARSED) {
    for (const m of p.stripped.matchAll(PII_RE)) PII_DECLARED.add(m[1]!);
    const set = new Set<string>();
    for (const m of p.stripped.matchAll(STORE_RE)) set.add(m[1]!);
    STORES_BY_FILE.set(p.file, set);
  }
}

function checkPin(laneId: string, pin: Pin): void {
  const c = containerOf(laneId);
  switch (pin.kind) {
    case 'no-tenant-column': {
      const cols = createTableColumns(pin.table);
      expect(cols.length, `${pin.table} must have columns`).toBeGreaterThan(0);
      expect(cols.filter((col) => /tenant/i.test(col)), `${laneId}: ${pin.table} must have NO tenant column for the exemption to hold`).toEqual([]);
      // The primitive the lane calls must actually target that table, and the lane must call it.
      const method = new RegExp(`async ${pin.via}\\([\\s\\S]*?FROM ${pin.table}\\b`).test(SQLITE_ADAPTER_SRC);
      expect(method, `${laneId}: sqlite ${pin.via}() must delete FROM ${pin.table}`).toBe(true);
      expect(new RegExp(`\\b${pin.via}\\s*\\(`).test(c.text), `${laneId}: the lane must call ${pin.via}(`).toBe(true);
      return;
    }
    case 'no-pii-declared': {
      const declaredHere = STORES_BY_FILE.get(c.file) ?? new Set<string>();
      for (const ns of pin.namespaces) {
        expect(declaredHere.has(ns), `${laneId}: '${ns}' must be a DurableCollection declared in ${rel(c.file)} (or the reason names a store that is not there)`).toBe(true);
        expect(PII_DECLARED.has(ns), `${laneId}: '${ns}' now declares PII fields — the exemption no longer holds; classify it`).toBe(false);
      }
      return;
    }
    case 'host-global-ageout': {
      const re = new RegExp(`registerKvAgeOut\\(\\s*\\{[^}]*\\bid:\\s*'${pin.id}'[^}]*\\bhostGlobal:\\s*true`);
      const found = PARSED.some((p) => re.test(p.stripped));
      expect(found, `${laneId}: a hostGlobal:true registerKvAgeOut registration for '${pin.id}' must exist`).toBe(true);
      return;
    }
    case 'no-delete-token': {
      const m = DELETE_TOKEN_RE.exec(c.text);
      expect(m?.[0], `${laneId}: exempt as "deletes nothing", but its text carries a delete token`).toBeUndefined();
      return;
    }
    default: {
      const never: never = pin;
      throw new Error(`unknown pin ${JSON.stringify(never)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The census.
// ─────────────────────────────────────────────────────────────────────────────

// This file's cost is a module-level parse of the ENTIRE backend source tree
// with the TypeScript compiler API (`FILES` / `PARSED` / `DERIVED` above), so
// its budget is the size of the tree, not a per-assertion cost. Vitest's 15 s
// default was never a considered budget for that: measured 2026-09-11, case
// (c) alone took 21.5 s on a pristine `origin/main` in a ONE-FILE run and
// 24.8 s inside the suite, so this file was red for everyone running
// `npm run ci`, at any load. 60 s is deliberate headroom that still fails a
// genuine hang instead of waiting for the lane timeout.
const CENSUS_BUDGET_MS = 60_000;

describe('ADR 0657 D8 — the destructive-lane census is derived from source', () => {
  it('non-vacuity: the walker, the parser and the primitives all found the real population', () => {
    expect(FILES.length, 'the source walk must find the tree').toBeGreaterThan(500);
    expect(DERIVED.seamsInSource, 'every seam in the map is declared in source').toEqual(new Set(Object.keys(SEAMS)));
    expect(DERIVED.primitiveCallsOutsideAnyLane, 'a primitive call outside any top-level function or route handler cannot be censused — move it into one').toEqual([]);
    expect(DERIVED.lanes.size).toBeGreaterThanOrEqual(MIN_LANES);
    for (const id of NAMED_LANES) expect(DERIVED.lanes.has(id), `${id} must be derived — it is a named lane of the ADR`).toBe(true);
  }, CENSUS_BUDGET_MS);

  it('(a) the map keys EQUAL the derived set, both ways', () => {
    const mapped = new Set(Object.keys(HOLD_CONSULT));
    const uncensused = [...DERIVED.lanes].filter((id) => !mapped.has(id)).sort();
    const stale = [...mapped].filter((id) => !DERIVED.lanes.has(id)).sort();
    expect(uncensused, 'a destructive lane with NO census row — say how it consults the legal hold').toEqual([]);
    expect(stale, 'a census row whose lane no longer exists in source (renamed? deleted?) — remove or repoint it').toEqual([]);
  }, CENSUS_BUDGET_MS);

  it('(b) the hold consults are the exports of host/retentionHold.ts, and every `asserts` lane calls one in its OWN text', () => {
    const holdSrc = stripComments(readFileSync(RETENTION_HOLD, 'utf8'));
    for (const name of HOLD_CONSULT_NAMES) {
      expect(new RegExp(`export async function ${name}\\(`).test(holdSrc), `${name} must be exported by retentionHold.ts`).toBe(true);
    }
    const asserting = Object.entries(HOLD_CONSULT).filter(([, r]) => r.mode === 'asserts').map(([id]) => id);
    expect(asserting.length).toBeGreaterThanOrEqual(7); // at least the seven `legal-hold-gates-erasure.test.ts` pins by hand
    for (const id of asserting) {
      const c = containerOf(id);
      expect(HOLD_CONSULT_RE.test(c.text), `${id} is recorded as asserting the legal hold but its text calls none of ${HOLD_CONSULT_NAMES.join('/')}`).toBe(true);
    }
  }, CENSUS_BUDGET_MS);

  it('(c) `inherits-from` / `registrant-of` lanes are reachable ONLY through gated lanes; `delegates-to` lanes delete only via their delegate', () => {
    for (const [id, row] of Object.entries(HOLD_CONSULT)) {
      const c = containerOf(id);
      if (row.mode.startsWith('inherits-from:')) {
        const parentId = row.mode.slice('inherits-from:'.length);
        expect(HOLD_CONSULT[parentId]?.mode, `${id} inherits from ${parentId}, which must be an \`asserts\` row`).toBe('asserts');
        const parent = containerOf(parentId);
        expect(new RegExp(`\\b${c.anchor}\\b`).test(parent.text), `${parentId} must reference ${c.anchor} — else the inheritance is a claim, not a call`).toBe(true);
        const ungated = callersOf(id).filter((r) => !r.lane || !gatedModes(r.lane));
        expect(ungated, `${id}: every reference must sit inside a gated lane — an ungated caller is a new door onto the same destruction`).toEqual([]);
      } else if (row.mode.startsWith('registrant-of:')) {
        const runnerId = row.mode.slice('registrant-of:'.length);
        expect(gatedModes(runnerId), `${id} registers into ${runnerId}, which must itself be gated`).toBe(true);
        const seam = Object.entries(SEAMS).find(([, runner]) => runner === runnerId)?.[0];
        expect(seam, `${runnerId} must be a seam runner`).toBeTruthy();
        const refs = callersOf(id);
        expect(refs.some((r) => r.asSeamArgOf === seam), `${id} must be passed to ${seam}( somewhere — else it is not a registrant`).toBe(true);
        const other = refs.filter((r) => r.asSeamArgOf !== seam && (!r.lane || !gatedModes(r.lane)));
        expect(other, `${id}: a reference that is neither the registration nor inside a gated lane`).toEqual([]);
      } else if (row.mode.startsWith('delegates-to:')) {
        const delegateId = row.mode.slice('delegates-to:'.length);
        expect(HOLD_CONSULT[delegateId]?.mode, `${id} delegates to ${delegateId}, which must be an \`asserts\` row`).toBe('asserts');
        const delegate = containerOf(delegateId);
        expect(new RegExp(`\\b${delegate.anchor}\\s*\\(`).test(c.text), `${id} must CALL ${delegate.anchor}(`).toBe(true);
        const stray = DELETE_TOKEN_RE.exec(c.text);
        expect(stray?.[0], `${id} deletes directly (${stray?.[0]}) — a delegate cannot gate that`).toBeUndefined();
      }
    }
  }, CENSUS_BUDGET_MS);

  it('(d) every `exempt` row is PINNED structurally; `exempt-unpinned` rows are GAPs under a hard floor', () => {
    const unpinned: string[] = [];
    for (const [id, row] of Object.entries(HOLD_CONSULT)) {
      if (row.mode === 'exempt') {
        expect(row.reason.length, `${id} needs a reason`).toBeGreaterThan(10);
        checkPin(id, row.pin);
      } else if (row.mode === 'exempt-unpinned') {
        expect(row.reason.startsWith('GAP: '), `${id}: an unpinned exemption must be recorded as a GAP`).toBe(true);
        unpinned.push(id);
      }
    }
    expect(unpinned.length, `unpinned exemptions: ${unpinned.join(', ')}`).toBeLessThanOrEqual(MAX_UNPINNED);
  }, CENSUS_BUDGET_MS);

  it('(e) the pins themselves are not vacuous: a tenant-bearing table FAILS the no-tenant-column pin, and the PII SSoT is populated', () => {
    // Guard the guard — `idempotent_response` carries `tenant_id`, so the same
    // pin that clears `idempotency` must refuse it (this is exactly why the
    // daemon tick is `exempt-unpinned` and not `exempt`).
    expect(createTableColumns('idempotent_response').some((col) => /tenant/i.test(col))).toBe(true);
    expect(createTableColumns('idempotency').some((col) => /tenant/i.test(col))).toBe(false);
    expect(PII_DECLARED.size, 'declarePiiFields declarations must be found, or no-pii-declared is a scan over nothing').toBeGreaterThanOrEqual(40);
    expect(PII_DECLARED.has('crm:booking')).toBe(true);
    // …and a body that DOES delete fails the no-delete-token pin.
    expect(DELETE_TOKEN_RE.test(containerOf('host/egressSentLedger.ts#sweepExpiredEgressSent').text)).toBe(true);
  }, CENSUS_BUDGET_MS);
});
