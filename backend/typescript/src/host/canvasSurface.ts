/**
 * `ctx.canvas` host surface (`host.canvas`, `spec/v1/host-capabilities.md`
 * §host.canvas) — the `vendor.myndhyve.canvas` pack's shared-canvas store.
 *
 * The sample host had no canvas store, so this adds one: a durable, versioned,
 * tenant-scoped document (`DurableCollection`). read/write/create are genuinely
 * functional — optimistic-concurrency writes (expectedVersion), shallow/deep/
 * replace merges, field projection on read, idempotent create/write.
 *
 * crossCanvasInvoke (start a child run of another canvas's workflow) needs the
 * run dispatcher, which isn't injected into host surfaces; it returns an honest
 * acknowledgement (synthetic childRunId, no fabricated terminal status) and the
 * registry note says so. The other three nodes run for real.
 */

import { runOrgScopeSubject } from './accessControlService.js';
import { hasWorkflowScope } from './workflowWriteAuthority.js';
import { canvasTypeValidator, isPrivilegedCanvasType, resolveCanvasTypeAccess } from './canvasTypeOwnership.js';
import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from './runInsert.js';
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { snapshotRunVariables } from './variablesRuntime.js';
import type { BundleScope } from './inMemorySurfaces.js';
import type { Storage } from '../storage/storage.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { RunRecord } from '../types.js';
import { OpenwopError } from '../types.js';
import { fireBeforeCanvasStateWrite, fireAfterCanvasStateWrite, fireCanvasDeleted } from './canvasLifecycle.js';
import type { Subject } from './subject.js';
import { subjectReadAllowed, subjectWriteAllowed, type SubjectCaller } from './subjectAccess.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';

const log = createLogger('host.canvas');

type Json = Record<string, unknown>;

/** Injected at boot (createApp) so crossCanvasInvoke can spawn a real child
 *  run — host surfaces don't otherwise see the run dispatcher. Mirrors
 *  `setSubWorkflowDispatcher`. */
interface CanvasInvokeDeps {
  storage: Storage;
  /** Tenant-scoped (ADR 0823): a workflow another tenant owns resolves to null. */
  getWorkflow: (tenantId: string, workflowId: string) => Promise<{ definition: WorkflowDef } | null>;
  executeRun: (storage: Storage, run: RunRecord, definition: unknown, options?: unknown) => Promise<unknown>;
}
// ADR 0474 — widened from the old `{ variables?: unknown }` segregation: the
// injected resolver is wired to the catalog funnel (host/index.ts), whose
// object IS the full definition, and the child-run revision pin must hash the
// COMPLETE definition (a partial view would mint a wrong hash).
type WorkflowDef = WorkflowDefinition;
let _invokeDeps: CanvasInvokeDeps | null = null;
export function setCanvasInvokeDispatcher(d: CanvasInvokeDeps): void {
  _invokeDeps = d;
}

/** Max canvas-invoke nesting depth (cycle/runaway guard), matching the
 *  sub-workflow dispatcher's cap. */
const MAX_INVOKE_DEPTH = 8;
const TERMINAL_RUN: readonly string[] = ['completed', 'failed', 'cancelled'];
// Per-tenant::target circuit breaker — consecutive child-run failures.
const _circuit = new Map<string, number>();

interface Canvas {
  canvasId: string;
  tenantId: string;
  canvasTypeId: string;
  name?: string;
  projectId?: string;
  /** ADR 0153 §R6 — additive owning Subject (project/user/agent). Absent ⇒ tenant-
   *  scoped as before (no migration of existing rows). Org/visibility resolves via
   *  `subjectOrgScope`/`subjectAccess` at the editor route; the field is the anchor. */
  ownerSubject?: Subject;
  state: Json;
  version: number;
  metadata?: Json;
  createdAt: string;
  updatedAt: string;
}

// Grade pass 2026-07-07 (DATA finding 9): a runtime validate guard — canvas state
// feeds the PUBLIC share viewer, so a corrupt/drifted row must not blind-cast.
const canvases = new DurableCollection<Canvas>(
  'canvas',
  (c) => c.canvasId,
  (parsed) => {
    const c = parsed as Canvas | null;
    return c && typeof c.canvasId === 'string' && typeof c.tenantId === 'string'
      && typeof c.canvasTypeId === 'string' && typeof c.version === 'number'
      && c.state !== null && typeof c.state === 'object' ? c : null;
  },
  // Grade pass DATA-CV-3: indexed tenant slice, symmetric with the version +
  // idem sibling rows (tenant purge stops relying on the JSON fallback probe).
  (c) => c.tenantId,
  // GC-CV-11: the tenant-index marker carries a light identity PROJECTION so the
  // browser/picker list (`listCanvasesForTenant`) reads it WITHOUT decoding the
  // full row incl. the potentially large `state` blob. The projection IS the
  // CanvasListRow shape.
  //
  // `ownerSubject` is ALWAYS written (null when org-owned) so a caller-filtered
  // list can decide membership from the marker. A marker WITHOUT the key predates
  // it — `listCanvasesForCaller` treats that as UNKNOWN and reads the full row,
  // never as "org-owned" (a stale marker must not become a leak).
  (c) => ({ canvasId: c.canvasId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), ownerSubject: c.ownerSubject ?? null, version: c.version, updatedAt: c.updatedAt }),
);

// ── version history (ADR 0305 Phase E — the CMS ADR 0206 PageVersion pattern) ──
// host.canvas owns snapshots (one owner for canvas persistence across canvas
// types); features expose routes over these. Snapshots capture the POST-save
// state keyed by the new canvas version; retention = distinct-version dedup +
// a 30s throttle + a per-canvas cap.

export interface CanvasVersion {
  versionId: string;
  tenantId: string;
  canvasId: string;
  /** The canvas `version` this snapshot captured. */
  version: number;
  snapshot: Json;
  capturedBy: string;
  capturedAt: string;
  /** Monotonic in-process tiebreaker for same-millisecond captures (restart-safe
   *  sort keys on capturedAt first — the CMS byNewest discipline). */
  seq: number;
}

// Grade pass 2026-07-07 (F6/DATA-4): versionIds are DETERMINISTIC and
// tenant/canvas-prefixed — `${tenantId}:${canvasId}:v<version>` — so (a) a
// same-version double capture is a natural idempotent overwrite (the dedup
// races away), and (b) every read is a bounded `listByPrefix`, never a full
// cross-tenant scan that decodes every snapshot blob. No deployed rows exist
// under the old `cver:<uuid>` scheme (the program is undeployed), so no re-key.
const canvasVersions = new DurableCollection<CanvasVersion>(
  'canvas:version', (v) => v.versionId, undefined, (v) => v.tenantId,
  // DATA-D8: a light identity PROJECTION on the tenant-index marker, so the
  // version-LIST read returns metadata WITHOUT decoding the (large) snapshot
  // blob — a 50-deep ink history stops decoding ~75MB to render 4 fields. The
  // projection is READ-only: destructive eviction stays on the authoritative
  // primary `listByPrefix` (a marker can briefly outlive its row, and driving a
  // delete off a phantom marker would evict a real snapshot).
  (v) => ({ versionId: v.versionId, canvasId: v.canvasId, version: v.version, capturedBy: v.capturedBy, capturedAt: v.capturedAt, seq: v.seq }),
);
const versionRowId = (tenantId: string, canvasId: string, version: number): string =>
  `${tenantId}:${canvasId}:v${String(version).padStart(9, '0')}`;
const MAX_CANVAS_VERSIONS = 50;
const SNAPSHOT_THROTTLE_MS = 30_000;
let canvasVersionSeq = 0;
// Architect amendment (Phase E): the rapid-save path must not pay a full
// collection scan per save — this in-process map answers the throttle without
// touching storage. A restart clears it; worst case is one extra snapshot.
const lastCaptureAt = new Map<string, number>();

function byNewestVersion(a: { capturedAt: string; seq: number }, b: { capturedAt: string; seq: number }): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

/** Capture a canvas snapshot (post-save state, keyed by the new version).
 *  Skips inside the 30s throttle window unless `force` (a restore's capture
 *  must always appear); dedups per canvas version (idempotent retries). */
export async function snapshotCanvas(c: { tenantId: string; canvasId: string; state: Json; version: number }, capturedBy: string, opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  if (!opts?.force) {
    const last = lastCaptureAt.get(c.canvasId);
    if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return;
  }
  const mine = (await canvasVersions.listByPrefix(`${c.tenantId}:${c.canvasId}:`)).sort(byNewestVersion);
  if (mine[0] && mine[0].version === c.version) return; // idempotent retry
  const v: CanvasVersion = {
    versionId: versionRowId(c.tenantId, c.canvasId, c.version),
    tenantId: c.tenantId,
    canvasId: c.canvasId,
    version: c.version,
    snapshot: JSON.parse(JSON.stringify(c.state)) as Json,
    capturedBy,
    capturedAt: new Date(now).toISOString(),
    seq: ++canvasVersionSeq,
  };
  await canvasVersions.put(v);
  lastCaptureAt.set(c.canvasId, now);
  const evicted = [v, ...mine].sort(byNewestVersion).slice(MAX_CANVAS_VERSIONS);
  for (const old of evicted) {
    await canvasVersions.delete(old.versionId);
  }
  // Grade pass DATA-CV-5: retention evictions were silent — an operator
  // debugging "where did my old version go" had no trace.
  if (evicted.length) log.info('canvas_versions_evicted', { canvasId: c.canvasId, evicted: evicted.length, cap: MAX_CANVAS_VERSIONS });
}

/** Version METADATA (no snapshot blob — DATA-D8), newest-first, tenant+canvas
 *  scoped by the marker prefix (no existence leak). Read from the tenant-index
 *  projection, so a deep history never decodes its snapshots to list them. The
 *  full snapshot is fetched on demand via `getCanvasVersion`. */
export interface CanvasVersionMeta { versionId: string; canvasId: string; version: number; capturedBy: string; capturedAt: string; seq: number }
export async function listCanvasVersions(tenantId: string, canvasId: string): Promise<CanvasVersionMeta[]> {
  const rows = await canvasVersions.listByTenantAndIdPrefixProjected(tenantId, `${tenantId}:${canvasId}:`);
  return rows
    .filter((p): p is CanvasVersionMeta & Record<string, unknown> =>
      typeof p.versionId === 'string' && p.canvasId === canvasId && typeof p.version === 'number' && typeof p.capturedAt === 'string')
    .map((p): CanvasVersionMeta => ({
      versionId: p.versionId, canvasId: p.canvasId, version: p.version,
      capturedBy: typeof p.capturedBy === 'string' ? p.capturedBy : '',
      capturedAt: p.capturedAt, seq: typeof p.seq === 'number' ? p.seq : 0,
    }))
    .sort(byNewestVersion);
}

/** One snapshot row, tenant+canvas IDOR-guarded (the cms getVersion posture). */
export async function getCanvasVersion(tenantId: string, canvasId: string, versionId: string): Promise<CanvasVersion | null> {
  const v = await canvasVersions.get(versionId);
  return v && v.tenantId === tenantId && v.canvasId === canvasId ? v : null;
}

/** ADR 0865 B12 — the captured snapshot of one canvas version, if the history
 *  still holds it (a binding reads its undo back before it writes). */
export async function getCanvasVersionAt(tenantId: string, canvasId: string, version: number): Promise<CanvasVersion | null> {
  return getCanvasVersion(tenantId, canvasId, versionRowId(tenantId, canvasId, version));
}

/** A type-schema validator (the same shape the save route holds as `cfg.validate`). */
export interface CanvasStateValidator { (state: Record<string, unknown>): { errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] } }

/** NON-DESTRUCTIVE restore: write the snapshot's state as a NEW canvas version
 *  (never rewinds), then force-capture so the restore point itself is in the
 *  history. Returns the new head, or null when canvas/version is absent.
 *  DATA-D6: an optional `validate` (the type's schema validator) runs against the
 *  exact snapshot BEFORE any mutation — a drifted/old snapshot must not
 *  blind-restore into the PUBLIC share viewer. `errors` reject as a 422 with
 *  NOTHING mutated (mirrors the save path); `warnings` restore anyway and ride
 *  back in the result (a mid-edit/cross-facet state stays restorable). */
export async function restoreCanvasVersion(
  tenantId: string, canvasId: string, versionId: string, actor: string,
  opts?: { validate?: CanvasStateValidator },
): Promise<{ canvasId: string; newVersion: number; warnings?: { path: string; message: string }[] } | null> {
  const v = await getCanvasVersion(tenantId, canvasId, versionId);
  if (!v) return null;
  // DATA-D6: validate FIRST, before the F7 head capture below — a rejected
  // restore must mutate zero rows (else it would burn a forced snapshot slot,
  // possibly evicting a real old version, for a restore that never happened).
  let warnings: { path: string; message: string }[] = [];
  if (opts?.validate) {
    const snap = v.snapshot;
    if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) {
      throw new OpenwopError('validation_error', `snapshot ${versionId} is not a canvas object`, 422, { errors: [{ path: 'snapshot', message: 'snapshot must be a canvas state object' }] });
    }
    const result = opts.validate(snap as Record<string, unknown>);
    if (result.errors.length) {
      log.warn('canvas restore rejected by validator', { canvasId, versionId, errorCount: result.errors.length, first: result.errors[0]!.message });
      throw new OpenwopError('validation_error', `restored snapshot violates the schema: ${result.errors[0]!.message}`, 422, { errors: result.errors });
    }
    warnings = result.warnings;
  }
  // Grade pass 2026-07-07 (F7): capture the CURRENT head first — inside the 30s
  // throttle window it may never have been snapshotted, and a restore that
  // overwrites it would lose up to 30s of work from history. Best-effort, like
  // the save-path capture: a failed capture never blocks the restore.
  const head = await getCanvasForTenant(tenantId, canvasId);
  if (head) {
    try { await snapshotCanvas({ tenantId, canvasId, state: head.state, version: head.version }, actor, { force: true }); }
    catch (err) { log.warn('canvas_prerestore_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
  }
  const result = await updateCanvasForTenant(tenantId, canvasId, v.snapshot, { merge: 'replace' });
  if (!result) return null;
  try { await snapshotCanvas({ tenantId, canvasId, state: v.snapshot, version: result.newVersion }, actor, { force: true }); }
  catch (err) { log.warn('canvas_restore_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

/** Tenant-scoped read of a canvas for non-run code (ADR 0056 — document
 *  materialization). Returns null if absent or cross-tenant (no existence leak). */
export interface CanvasRecordView { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; state: Json; version: number; metadata?: Json }
export async function getCanvasForTenant(tenantId: string, canvasId: string): Promise<CanvasRecordView | null> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return null;
  // `metadata` passes through additively (grade pass XCH-DATA-1): provenance
  // stamped at create (e.g. the app-builder agent tool's `producedBy`) must be
  // READABLE, not write-only.
  return { canvasId: c.canvasId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.ownerSubject ? { ownerSubject: c.ownerSubject } : {}), state: c.state, version: c.version, ...(c.metadata !== undefined ? { metadata: c.metadata } : {}) };
}

/**
 * THE canvas read predicate (ADR 0610 D3′ / CPC-15): a project- or user-owned
 * canvas is membership-scoped — the org gate is not sufficient. ONE definition,
 * used by the editor HTTP route AND every agent tool, so the chat lane can never
 * read what the HTTP door refuses (CLAUDE.md: a chat tool SHARES its route's
 * access predicate). Before this existed, `cad`, `drawings`, `slides`,
 * `campaign-studio` and `app-builder` agent tools loaded canvases by tenant
 * alone, so any workspace member could have the agent read — or overwrite — a
 * private project's canvas by id.
 *
 * Delegates to `subjectReadAllowed`, which REFUSES a caller with no subject (a
 * system run has no membership; the resolver would otherwise answer "owner").
 * An org-owned canvas (no `ownerSubject`) keeps the org gate as the whole rule.
 */
export async function canvasReadAllowed(
  tenantId: string,
  canvas: Pick<CanvasRecordView, 'ownerSubject'>,
  caller: SubjectCaller,
): Promise<boolean> {
  if (!canvas.ownerSubject) return true;
  return subjectReadAllowed(tenantId, canvas.ownerSubject, caller);
}

/**
 * ADR 0886 D1 — THE canvas WRITE predicate, the twin of {@link canvasReadAllowed}
 * and shared by every write lane (the editor factory, `ctx.canvas`, the agent
 * tools, the ui-plugin RPC, share-link mint, the collab doors). An org-owned
 * canvas keeps the caller's org/tenant write gate as the whole rule; an owned
 * one needs WRITE on its owner subject, decided in that subject's org.
 * `test/adr0886-canvas-write-gate-ratchet.test.ts` pins every writer to a gate.
 */
export async function canvasWriteAllowed(
  tenantId: string,
  canvas: Pick<CanvasRecordView, 'ownerSubject'>,
  caller: SubjectCaller,
): Promise<boolean> {
  if (!canvas.ownerSubject) return true;
  return subjectWriteAllowed(tenantId, canvas.ownerSubject, caller);
}

/** `getCanvasForTenant` + {@link canvasWriteAllowed}: `null` for missing AND for
 *  refused (a lane that must tell "readable but not writable" apart uses the two
 *  predicates directly, as the editor factory does). */
export async function getCanvasForWriter(tenantId: string, canvasId: string, caller: SubjectCaller): Promise<CanvasRecordView | null> {
  const canvas = await getCanvasForTenant(tenantId, canvasId);
  if (!canvas) return null;
  return (await canvasWriteAllowed(tenantId, canvas, caller)) ? canvas : null;
}

/** `getCanvasForTenant` + {@link canvasReadAllowed}: `null` for missing AND for
 *  refused, so callers answer both with the same uniform not-found (no
 *  existence leak). The caller-facing way to load a canvas. */
export async function getCanvasForCaller(tenantId: string, canvasId: string, caller: SubjectCaller): Promise<CanvasRecordView | null> {
  const canvas = await getCanvasForTenant(tenantId, canvasId);
  if (!canvas) return null;
  return (await canvasReadAllowed(tenantId, canvas, caller)) ? canvas : null;
}

/** Light tenant listing for pickers (ADR 0314 — the documents "From a canvas"
 *  picker; ADR 0316 — the canvases browser). Projects each canvas to identity
 *  rows (never `state`), newest first. Callers gate access; the result is
 *  read from the tenant-index MARKER PROJECTION (GC-CV-11) — the full row (incl.
 *  the large `state` blob) is never decoded, so the scan is O(tenant canvas
 *  count) in small identity rows, not O(count × row size). A canvas written
 *  before the projection existed self-heals its marker on first read. */
export interface CanvasListRow { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; version: number; updatedAt: string }
function isCanvasListRow(p: Record<string, unknown>): p is CanvasListRow & Record<string, unknown> {
  return typeof p.canvasId === 'string' && typeof p.canvasTypeId === 'string' && typeof p.version === 'number' && typeof p.updatedAt === 'string';
}
export async function listCanvasesForTenant(tenantId: string): Promise<CanvasListRow[]> {
  const projections = await canvases.listForTenantProjected(tenantId);
  return projections
    .filter(isCanvasListRow)
    .map((p): CanvasListRow => ({ canvasId: p.canvasId, canvasTypeId: p.canvasTypeId, ...(typeof p.name === 'string' ? { name: p.name } : {}), ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}), version: p.version, updatedAt: p.updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.canvasId < b.canvasId ? -1 : 1));
}

/** ADR 0839 D2 — the canvases `owner` OWNS in this tenant (its `ownerSubject`, not a
 *  mere `projectId` tag). Tenant-scoped through the index; a marker that predates the
 *  `ownerSubject` key is UNKNOWN, so the full row decides (same rule as the caller list). */
export async function listCanvasIdsOwnedBy(tenantId: string, owner: Subject): Promise<string[]> {
  const same = (s: unknown): boolean => {
    const o = s as Subject | null | undefined;
    return !!o && o.kind === owner.kind && o.id === owner.id;
  };
  const out: string[] = [];
  for (const p of (await canvases.listForTenantProjected(tenantId)).filter(isCanvasListRow)) {
    if ('ownerSubject' in p) { if (same(p.ownerSubject)) out.push(p.canvasId); continue; }
    const row = await canvases.get(p.canvasId);
    if (row && row.tenantId === tenantId && same(row.ownerSubject)) out.push(p.canvasId);
  }
  return out;
}

/** {@link listCanvasesForTenant} filtered through THE canvas predicate for a
 *  caller — the list a human (or an MCP principal) is shown. Membership is
 *  resolved once per distinct owner. */
export async function listCanvasesForCaller(tenantId: string, caller: SubjectCaller): Promise<CanvasListRow[]> {
  const projections = (await canvases.listForTenantProjected(tenantId)).filter(isCanvasListRow);
  const memo = new Map<string, Promise<boolean>>();
  // Memoized per distinct owner, but ALWAYS through canvasReadAllowed — one
  // predicate; a second copy here is exactly how lanes drift apart.
  const allowed = (owner: Subject): Promise<boolean> => {
    const k = `${owner.kind}:${owner.id}`;
    let v = memo.get(k);
    if (!v) { v = canvasReadAllowed(tenantId, { ownerSubject: owner }, caller); memo.set(k, v); }
    return v;
  };
  const kept = await Promise.all(projections.map(async (p) => {
    let owner: Subject | null;
    if ('ownerSubject' in p) owner = (p.ownerSubject as Subject | null) ?? null;
    else owner = (await canvases.get(p.canvasId))?.ownerSubject ?? null; // stale marker: never assume org-owned
    if (owner && !(await allowed(owner))) return null;
    return p;
  }));
  return kept
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p): CanvasListRow => ({ canvasId: p.canvasId, canvasTypeId: p.canvasTypeId, ...(typeof p.name === 'string' ? { name: p.name } : {}), ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}), version: p.version, updatedAt: p.updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.canvasId < b.canvasId ? -1 : 1));
}

/** Tenant-scoped, idempotent canvas create for non-run code — the editor "open"
 *  / seed-from-artifact path (ADR 0153 §R1). Reuses the same store + `_idem` cache
 *  as the run-scoped `create`, so the same `idempotencyKey` (e.g. an artifact key)
 *  yields ONE working copy, not duplicates. Additive `ownerSubject` (§R6). */
export async function createCanvasForTenant(tenantId: string, args: {
  canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; initialState?: Json; metadata?: Json; idempotencyKey?: string;
}): Promise<CanvasRecordView> {
  const now = new Date().toISOString();
  const canvas: Canvas = {
    canvasId: `canvas-${randomUUID()}`,
    tenantId,
    canvasTypeId: args.canvasTypeId,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    ...(args.ownerSubject !== undefined ? { ownerSubject: args.ownerSubject } : {}),
    state: args.initialState ?? {},
    version: 1,
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const view: CanvasRecordView = { canvasId: canvas.canvasId, canvasTypeId: canvas.canvasTypeId, ...(canvas.name ? { name: canvas.name } : {}), ...(canvas.projectId ? { projectId: canvas.projectId } : {}), ...(canvas.ownerSubject ? { ownerSubject: canvas.ownerSubject } : {}), state: canvas.state, version: canvas.version, ...(canvas.metadata !== undefined ? { metadata: canvas.metadata } : {}) };
  // CANVAS-IDEM-ORPHAN-1: claim the key, THEN write the row (see idemCreate).
  if (args.idempotencyKey) return idemCreate(`${tenantId}::ct:${args.idempotencyKey}`, args.idempotencyKey, canvas, view);
  await canvases.put(canvas);
  return view;
}

/** Tenant-scoped, idempotent create-with-a-FIXED-id (no `canvas-<uuid>` generation).
 *  For host seams that address a canvas by a well-known stable id (e.g. the RFC 0238
 *  ui-plugin fixture artifact) — returns the existing record if present, else
 *  creates it at version 1. Distinct from `createCanvasForTenant`, which mints a random id. */
export async function ensureCanvasForTenant(
  tenantId: string, canvasId: string, args: { canvasTypeId: string; initialState?: Json },
): Promise<CanvasRecordView> {
  const raw = await canvases.get(canvasId);
  if (raw && raw.tenantId === tenantId) return (await getCanvasForTenant(tenantId, canvasId))!;
  // Canvas ids are GLOBAL keys. A row another tenant owns is not "absent": a put
  // would move it into this tenant. Refuse before writing anything (putIfAbsent
  // writes this tenant's index marker first, which would list a phantom canvas).
  if (raw) throw new OpenwopError('conflict', `canvas id '${canvasId}' is not available in this tenant`, 409);
  const now = new Date().toISOString();
  const canvas: Canvas = { canvasId, tenantId, canvasTypeId: args.canvasTypeId, state: args.initialState ?? {}, version: 1, createdAt: now, updatedAt: now };
  if (!(await canvases.putIfAbsent(canvas))) {
    const raced = await getCanvasForTenant(tenantId, canvasId);
    if (raced) return raced;
    throw new OpenwopError('conflict', `canvas id '${canvasId}' is not available in this tenant`, 409);
  }
  return { canvasId, canvasTypeId: canvas.canvasTypeId, state: canvas.state, version: canvas.version };
}

/** Tenant-scoped optimistic write for the editor save path (ADR 0153 Phase 2b) — the
 *  non-run mirror of the surface `write`. `expectedVersion` (if given) must match or it
 *  throws `canvas_version_conflict` (last-writer protection for the live editor); merge
 *  defaults to `replace` (the editor sends the whole canvas state). Returns null when the
 *  canvas is absent or cross-tenant (no existence leak). */
export async function updateCanvasForTenant(
  tenantId: string, canvasId: string, mutation: Json,
  opts?: { expectedVersion?: number; merge?: 'shallow' | 'deep' | 'replace'; snapshot?: { capturedBy: string; force?: boolean }; source?: 'collab'; validate?: boolean },
): Promise<{ canvasId: string; newVersion: number } | null> {
  // Grade pass 2026-07-07 (F1 + F5/DATA-2): the write is a compareAndSwap retry
  // loop (get→check→put allowed a cross-instance lost update), and a stale
  // `expectedVersion` is a TYPED 409 (`OpenwopError`) — the previous plain
  // Error fell through the envelope mapper as a 500, so the editor's conflict
  // UX never fired.
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = await canvases.get(canvasId);
    if (!c || c.tenantId !== tenantId) return null;
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== c.version) {
      throw new OpenwopError('canvas_version_conflict', `canvas ${canvasId} version conflict: expected ${opts.expectedVersion}, have ${c.version}`, 409, { currentVersion: c.version });
    }
    const merge = opts?.merge ?? 'replace';
    const m = (mutation ?? {}) as Json;
    const next: Canvas = {
      ...c,
      state: merge === 'replace' ? { ...m } : merge === 'deep' ? deepMerge(c.state, m) : { ...c.state, ...m },
      version: c.version + 1,
      updatedAt: new Date().toISOString(),
    };
    // ADR 0865 B19 — the type's registered catalog validator, on the RESULTING
    // state (a merge can make a valid mutation into an invalid canvas). Opt-in:
    // the editor PATCH validates before calling, the run lane asks for it here.
    if (opts?.validate) assertCanvasStateValid(c.canvasTypeId, next.state);
    // ADR 0359 Phase 6 — the EXTERNAL-write veto seam (may throw a typed 409:
    // a live `canvas.document` room has no generic apply path). Collab's own
    // derive writes bypass (`source: 'collab'`) — they ARE the CRDT authority.
    // ADR 0865 B18 — it sees the resulting state, not a partial mutation (the
    // editor sends a whole state with `replace`, so for it the two are equal).
    if (attempt === 0 && opts?.source !== 'collab') {
      await fireBeforeCanvasStateWrite({ tenantId, canvasId, canvasTypeId: c.canvasTypeId, state: next.state as Record<string, unknown> });
    }
    if (!(await canvases.compareAndSwap(c, next))) {
      // Lost the race. With an expectedVersion the caller's basis is now stale
      // (the re-read above will 409 on the next pass); without one, retry.
      continue;
    }
    // ADR 0305 Phase E — opt-in per-save capture (the editor PATCH passes it;
    // the run-path surface `write` does not: runs create canvases, they don't
    // iterate them). Best-effort: a snapshot failure never fails the save.
    if (opts?.snapshot) {
      try { await snapshotCanvas({ tenantId, canvasId, state: next.state, version: next.version }, opts.snapshot.capturedBy, opts.snapshot.force ? { force: true } : undefined); }
      catch (err) { log.warn('canvas_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
    }
    // ADR 0359 Phase 6 — post-commit fan-out (best-effort): apply-into-room for
    // element types with a live room; CRDT-store invalidation when no room is
    // live (host.canvas becomes the authority again; the next session re-seeds).
    if (opts?.source !== 'collab') {
      await fireAfterCanvasStateWrite({ tenantId, canvasId, canvasTypeId: next.canvasTypeId, state: next.state as Record<string, unknown> });
    }
    return { canvasId, newVersion: next.version };
  }
  throw new OpenwopError('canvas_version_conflict', `canvas ${canvasId} write contention — retry`, 409, { contended: true });
}

/** Delete a canvas + CASCADE its owned rows (grade-pass DATA-3): version
 *  snapshots (prefix-scoped) and the seed-from-artifact idempotency row (else a
 *  re-open would return a pointer to the dead canvas). Share links are the
 *  sharing feature's rows — the caller purges those (feature layer; host must
 *  not import features). Returns false when absent/cross-tenant (no leak). */
/** ADR 0359 grade pass (DATA-I5): collapse CONSECUTIVE collab auto-derive
 *  versions — after a new `capturedBy: 'collab'` capture, delete the
 *  immediately PRECEDING version row iff it too was a 'collab' capture, so a
 *  multi-hour live session keeps ONE trailing auto-version between user/AI
 *  captures instead of evicting them out of the retention cap. */
export async function pruneConsecutiveCollabVersions(tenantId: string, canvasId: string, newVersion: number): Promise<void> {
  const metas = await listCanvasVersions(tenantId, canvasId);
  const prior = metas
    .filter((v) => v.version < newVersion)
    .sort((a, b) => b.version - a.version)[0];
  if (prior && prior.capturedBy === 'collab') {
    await canvasVersions.delete(prior.versionId);
  }
}

export async function deleteCanvasForTenant(tenantId: string, canvasId: string): Promise<boolean> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return false;
  for (const v of await canvasVersions.listByPrefix(`${tenantId}:${canvasId}:`)) {
    await canvasVersions.delete(v.versionId);
  }
  const seededKey = (c.metadata as Json | undefined)?.seededFromArtifactKey;
  if (typeof seededKey === 'string' && seededKey) {
    await _idemRows.delete(`${tenantId}::ct:from-artifact:${seededKey}`);
  }
  await canvases.delete(canvasId);
  lastCaptureAt.delete(canvasId);
  // ADR 0359 grade pass (DATA-B2): fire the lifecycle seam HERE — the single
  // delete owner — so no caller (the per-type editor route, the Documents
  // browser, demo-clear seeders) can skip the sidecar cascade (collab
  // snapshots/seed claims, comments). Fired AFTER the row is gone, best-effort
  // by contract; handlers are idempotent, so a caller that also fires is safe.
  await fireCanvasDeleted({ tenantId, canvasId, canvasTypeId: c.canvasTypeId });
  return true;
}

/** Test-only: seed a canvas record directly (route tests have no run to create one). */
export async function __putCanvasForTest(c: { canvasId: string; tenantId: string; canvasTypeId: string; name?: string; projectId?: string; state: Json; version?: number; updatedAt?: string }): Promise<void> {
  const now = new Date().toISOString();
  await canvases.put({ canvasId: c.canvasId, tenantId: c.tenantId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), state: c.state, version: c.version ?? 1, createdAt: c.updatedAt ?? now, updatedAt: c.updatedAt ?? now });
}
// Idempotency for create/write keyed by tenant::idempotencyKey — DURABLE
// (CODEBASE-ASSESSMENT CAS-adoption pass, 2026-07-03): the old in-process Map
// lost idempotency across instances and restarts, so a retried same-key
// create on another instance minted a duplicate canvas. Rows are CAS-inserted
// (the PR #1181 reserveSend pattern): the loser of a concurrent same-key race
// discards its own result and returns the WINNER's, so every caller converges
// on one canvas/version. Cache-after-success semantics are preserved (a
// failed operation stores nothing and retries clean).
// Grade pass 2026-07-07 (DATA finding 1): rows carry a top-level `tenantId` and the
// collection declares `tenantOf`, so ADR 0284 tenant deletion purges them — the
// cached create results hold full canvas STATE, which previously survived erasure.
interface IdemRow { key: string; tenantId: string; result: Json; createdAt: string }
const _idemRows = new DurableCollection<IdemRow>(
  'canvas:idem',
  (r) => r.key,
  (parsed) => {
    const r = parsed as IdemRow | null;
    return r && typeof r.key === 'string' && typeof r.result === 'object' && r.result !== null ? r : null;
  },
  (r) => r.tenantId ?? r.key.split('::')[0] ?? '',
);
async function idemGet<T>(key: string): Promise<T | undefined> {
  const row = await _idemRows.get(key);
  return row ? (row.result as T) : undefined;
}
/** Store `result` under `key`; on a concurrent-writer loss, return the winner's. */
async function idemPut<T>(key: string, result: T): Promise<T> {
  // The tenant is the key's `::`-prefix by construction (both call sites).
  const tenantId = key.split('::')[0] ?? '';
  const won = await _idemRows.compareAndSwap(null, { key, tenantId, result: result as Json, createdAt: new Date().toISOString() });
  if (won) return result;
  const winner = await _idemRows.get(key);
  return winner ? (winner.result as T) : result;
}

// CANVAS-IDEM-ORPHAN-1 — an idempotent CREATE claims its key BEFORE it writes the
// canvas row. It used to write the row first and settle the key after (`idemPut`),
// so the loser of a same-key race returned the winner's canvas and left its OWN row
// behind: listed in the tenant, referenced by nothing. Now only the claim's winner
// writes a row, and a failed write releases the claim, so a failed create still
// caches nothing ("cache-after-success" above).
//
// The id stays a random uuid on purpose. An id derived from the key would be REUSED
// after a delete, and everything keyed by canvasId (share links, comments, collab,
// versions) is cleaned only by best-effort `onCanvasDeleted` hooks — a lagging hook
// would attach stale data to the new canvas.
//
// The claim lands before the row, so a caller that finds a FRESH claim (younger than
// IDEM_INFLIGHT_GRACE_MS) whose row is not there yet is looking at an in-flight
// winner: it waits briefly for the row, and answers `idempotency_in_flight` (409 +
// Retry-After, `idempotency.md` §"Concurrent duplicates") if the row never lands. A claim OLDER than the grace with no row is ABANDONED — its winner died
// between claim and write (a revision retiring mid-request does this on every
// deploy), or the canvas was deleted within the idem TTL. The next caller takes it
// over with a CAS on the stale claim's exact value (so exactly one taker) and writes
// its own row. So a same-key retry after a delete makes a NEW canvas with a new id,
// where it used to replay the dead id. A same-key create with a different body still
// replays the first result while that canvas exists.
const IDEM_INFLIGHT_GRACE_MS = 30_000;
const IDEM_INFLIGHT_WAIT_MS = 2_000;
async function awaitCanvasRow(canvasId: string): Promise<boolean> {
  const deadline = Date.now() + IDEM_INFLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    if (await canvases.get(canvasId)) return true;
  }
  return false;
}
async function idemCreate<T extends { canvasId: string }>(key: string, idempotencyKey: string, canvas: Canvas, result: T): Promise<T> {
  const tenantId = key.split('::')[0] ?? '';
  const claim = (): IdemRow => ({ key, tenantId, result: result as unknown as Json, createdAt: new Date().toISOString() });
  const writeOwnRow = async (claimRow: IdemRow): Promise<T> => {
    try {
      await canvases.put(canvas);
    } catch (err) {
      // Release only OUR claim: a CAS back to absent is not available, so check it is
      // still ours before deleting.
      const current = await _idemRows.get(key).catch(() => null);
      if (current && current.createdAt === claimRow.createdAt && (current.result as { canvasId?: unknown }).canvasId === canvas.canvasId) {
        await _idemRows.delete(key).catch(() => false);
      }
      throw err;
    }
    return result;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await _idemRows.get(key);
    if (!existing) {
      const row = claim();
      if (await _idemRows.compareAndSwap(null, row)) return writeOwnRow(row);
      continue; // lost the claim: read the winner's on the next pass
    }
    const view = existing.result as unknown as T;
    if (await canvases.get(view.canvasId)) return view;
    if (Date.now() - Date.parse(existing.createdAt) <= IDEM_INFLIGHT_GRACE_MS) {
      if (await awaitCanvasRow(view.canvasId)) return view;
      if (!(await _idemRows.get(key))) continue; // the winner's write failed and released the claim
      throw new OpenwopError('idempotency_in_flight', 'A request with this idempotency key is still creating the canvas; retry after it completes.', 409, { idempotencyKey, retryAfter: 1 });
    }
    const row = claim();
    if (await _idemRows.compareAndSwap(existing, row)) return writeOwnRow(row);
    // another caller took the abandoned claim over first: read theirs on the next pass
  }
  throw new OpenwopError('idempotency_in_flight', 'The canvas create did not settle; retry.', 409, { idempotencyKey, retryAfter: 1 });
}

const IDEM_DAY_MS = 24 * 60 * 60 * 1000;
const IDEM_TTL_MS_DEFAULT = 14 * IDEM_DAY_MS;
const IDEM_SWEEP_DELETE_CAP = 500;
function idemTtlMs(): number {
  const days = Number(process.env.OPENWOP_CANVAS_IDEM_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * IDEM_DAY_MS : IDEM_TTL_MS_DEFAULT;
}

/** DATA-D7 — retention sweep for the EPHEMERAL create/write idempotency rows
 *  (`::c:`, `::w:`, and non-from-artifact `::ct:`). These are keyed by
 *  idempotencyKey, so they can't be reverse-cascaded when a canvas is deleted —
 *  after a delete they're orphan pointers to a dead canvas (and they cache the
 *  full CanvasRecordView incl. `state`, so they're not tiny). They're retry-window
 *  keys (seconds-to-minutes), so a multi-day TTL sits far beyond any real retry.
 *  The `ct:from-artifact:` reopen-dedup rows are EXEMPT — a legitimate reopen of
 *  the same artifact months later must still dedup, and the delete cascade already
 *  lifecycles them (deleteCanvasForTenant). Bounded (`SWEEP_DELETE_CAP`) and
 *  fail-contained (a bad row can't wedge the worker tick); an unparseable
 *  `createdAt` is KEPT. Piggybacks the webhook-delivery worker tick. */
export async function sweepExpiredCanvasIdem(now: number = Date.now()): Promise<number> {
  const cutoff = now - idemTtlMs();
  let all: IdemRow[];
  try { all = await _idemRows.list(); }
  catch (err) { log.warn('canvas idem sweep list failed', { error: err instanceof Error ? err.message : String(err) }); return 0; }
  let deleted = 0;
  for (const row of all) {
    if (deleted >= IDEM_SWEEP_DELETE_CAP) break;
    const op = row.key.split('::')[1] ?? ''; // the namespaced op after `${tenantId}::`
    if (op.startsWith('ct:from-artifact:')) continue; // exempt: reopen-dedup, cascade-lifecycled
    const stamped = Date.parse(row.createdAt);
    if (!Number.isFinite(stamped) || stamped >= cutoff) continue; // keep fresh / unparseable
    try { if (await _idemRows.delete(row.key)) deleted++; }
    catch (err) { log.warn('canvas idem sweep delete failed', { key: row.key, error: err instanceof Error ? err.message : String(err) }); }
  }
  if (deleted > 0) log.info('canvas idem sweep', { deleted });
  return deleted;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// Canvas version snapshots and canvas ownership are structurally-needed rows
// (version history + the ownership anchor must survive; deleting them would
// destroy other editors' history and drop the canvas), so a DSAR ANONYMIZES the
// subject's identifiers in place: `capturedBy` on EVERY version snapshot the
// subject captured (the ADR 0464 named fix — `canvasEditorRoutes` stamps a
// userId there for every canvas type app-wide), and a canvas's user-kind
// `ownerSubject`. The snapshot BYTES (canvas content) are untouched — they are
// other people's work; only the actor id is redacted. Written via the raw
// collections (no version bump, no lifecycle fan-out). Idempotent; tenant-scoped
// (versions by key prefix, canvases by their tenant field); fail-closed on
// falsy input.

/** DSAR eraser — anonymize `capturedBy` on the subject's version snapshots,
 *  their user-kind canvas `ownerSubject` and `metadata.producedBy`, tenant-wide. */
export async function eraseSubjectCanvas(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // Version snapshots — tenant-bounded by the `${tenantId}:` key prefix.
  for (const v of await canvasVersions.listByPrefix(`${tenantId}:`)) {
    if (forms.has(v.capturedBy)) await canvasVersions.put({ ...v, capturedBy: ERASED });
  }
  // Canvas ownership — the tenant's canvases whose owner IS the erased subject —
  // and (ADR 0886 D4) the agent tools' provenance stamp `metadata.producedBy`
  // (slides / drawings / cad / campaign-studio / app-builder write
  // `{kind:'user', id}` when no agent profile drove the turn). One put per row.
  for (const c of await canvases.list()) {
    if (c.tenantId !== tenantId) continue;
    const ownerHit = Boolean(c.ownerSubject && c.ownerSubject.kind === 'user' && forms.has(c.ownerSubject.id));
    const meta = c.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata) ? (c.metadata as Record<string, unknown>) : null;
    const pb = meta?.producedBy as { kind?: unknown; id?: unknown } | undefined;
    const producedHit = Boolean(pb && typeof pb === 'object' && pb.kind === 'user' && typeof pb.id === 'string' && forms.has(pb.id));
    if (!ownerHit && !producedHit) continue;
    await canvases.put({
      ...c,
      ...(ownerHit ? { ownerSubject: { kind: 'user' as const, id: ERASED } } : {}),
      ...(producedHit && meta ? { metadata: { ...meta, producedBy: { kind: 'user', id: ERASED } } as Json } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
}

/** Register the canvas DSAR eraser (idempotent — the seam dedupes by reference).
 *  Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerCanvasErasure(): void {
  registerSubjectEraser(eraseSubjectCanvas);
}

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
      ? deepMerge(cur as Json, v as Json)
      : v;
  }
  return out;
}

function project(state: Json, fields: unknown): Json {
  if (!Array.isArray(fields) || fields.length === 0) return state;
  const out: Json = {};
  for (const f of fields) if (typeof f === 'string' && f in state) out[f] = state[f];
  return out;
}

/** ADR 0865 B19 — the type's registered catalog validator (the SAME function the
 *  editor PATCH runs) over a whole state. Errors refuse with `validation_error`;
 *  warnings pass, as in the editor. A type with no validator passes. */
export function assertCanvasStateValid(canvasTypeId: string, state: Json): void {
  const validate = canvasTypeValidator(canvasTypeId);
  if (!validate) return;
  const { errors } = validate(state as Record<string, unknown>);
  if (errors.length) {
    throw new OpenwopError('validation_error', `canvas state violates the component catalog: ${errors[0]!.message}`, 422, { errors: [...errors] });
  }
}

const runCanvasRefusal = (code: string, message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { code, ...extra });

/**
 * ADR 0865 B17 — THE run-lane canvas gate. `ctx.canvas` read/write/create and
 * `ctx.dataIntegration.applyBinding` call it, and nothing in the run lane reaches
 * a canvas around it. The editor's own gate takes a `Request`, so what is shared
 * with it is every part that is not request-shaped, read from the one type
 * registration `registerCanvasEditorRoutes` writes:
 *
 *   1. tenant (the caller loaded the row; a foreign row never reaches here);
 *   2. the type's owning feature (toggle + plan), `host_capability_disabled`;
 *   3. a PRIVILEGED type (its routes add an `authorize(req)` gate) is refused —
 *      no run can satisfy a request predicate, so the lane fails closed;
 *   4. the role floor: the run's person (actor, else causing member) holds
 *      `workspace:read|write` in the tenant (ADR 0837's floor; no person ⇒ no
 *      check, as for every feature surface), `forbidden_scope`. It is ADR
 *      0822's `hasWorkflowScope`, the in-run twin of the HTTP door, so a
 *      configured operator key's run is the tenant's own principal here too;
 *   5. a subject-owned canvas needs a person who may read it
 *      (`canvasReadAllowed`, shared with the editor + chat tools) — refused as
 *      the SAME `canvas_not_found` a missing id answers;
 *   6. ADR 0886 D1 — a WRITE additionally needs `canvasWriteAllowed` (write on
 *      the owner subject, in its own org), `forbidden_scope`.
 */
export async function assertCanvasRunAccess(
  scope: BundleScope,
  canvas: { canvasId: string; canvasTypeId: string; ownerSubject?: Subject },
  need: 'read' | 'write',
): Promise<void> {
  const access = await resolveCanvasTypeAccess(canvas.canvasTypeId, { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) });
  if (!access.allowed) {
    throw runCanvasRefusal('host_capability_disabled', `feature '${access.toggleId}' is not enabled for this tenant — ctx.canvas cannot use '${canvas.canvasTypeId}' canvases`,
      { capability: 'host.canvas', canvasTypeId: canvas.canvasTypeId, feature: access.toggleId, blockedBy: access.blockedBy });
  }
  if (isPrivilegedCanvasType(canvas.canvasTypeId)) {
    throw runCanvasRefusal('host_capability_disabled', `'${canvas.canvasTypeId}' canvases are privileged and cannot be used from a workflow run`,
      { capability: 'host.canvas', canvasTypeId: canvas.canvasTypeId, blockedBy: 'privileged' });
  }
  const person = runOrgScopeSubject(scope);
  if (person) {
    const needed = need === 'write' ? 'workspace:write' : 'workspace:read';
    if (!(await hasWorkflowScope({ tenantId: scope.tenantId, actingUserId: person, ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) }, needed))) {
      throw new OpenwopError('forbidden_scope', `Missing required scope: ${needed}`, 403, { requiredScope: needed });
    }
  }
  if (!(await canvasReadAllowed(scope.tenantId, canvas, { subject: person }))) {
    throw runCanvasRefusal('canvas_not_found', `canvas ${canvas.canvasId} not found`);
  }
  // ADR 0886 D1 — a write needs WRITE on the owner subject (its own org), not
  // the run person's tenant-wide write plus read.
  if (need === 'write' && !(await canvasWriteAllowed(scope.tenantId, canvas, { subject: person }))) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write on the canvas owner', 403, { requiredScope: 'workspace:write' });
  }
}

export interface CanvasSurface {
  read(canvasId: string, opts?: { fields?: unknown; consistency?: unknown }): Promise<{ canvasId: string; state: Json; canvasTypeId: string; version: number }>;
  write(canvasId: string, mutation: Json, opts?: { expectedVersion?: number; merge?: 'shallow' | 'deep' | 'replace'; idempotencyKey?: string }): Promise<{ canvasId: string; newVersion: number }>;
  create(args: { canvasTypeId: string; projectId?: string; name?: string; initialState?: Json; metadata?: Json; idempotencyKey?: string }): Promise<{ canvasId: string; canvasTypeId: string; name?: string; projectId?: string; createdAt: string }>;
  invoke(targetCanvasId: string, workflowId: string, args: Json, opts?: { awaitTerminal?: boolean; timeoutMs?: number; circuitBreaker?: unknown; idempotencyKey?: string }): Promise<{ childRunId: string; result?: unknown; circuitOpen?: boolean; terminalStatus?: string; error?: unknown }>;
}

export function createCanvasSurface(scope: BundleScope): CanvasSurface {
  const tenantId = scope.tenantId;
  const idem = (key: string): string => `${tenantId}::${key}`;

  async function load(canvasId: string): Promise<Canvas> {
    const c = await canvases.get(canvasId);
    if (!c || c.tenantId !== tenantId) {
      throw Object.assign(new Error(`canvas ${canvasId} not found`), { code: 'canvas_not_found' });
    }
    return c;
  }

  return {
    async read(canvasId, opts) {
      const c = await load(canvasId);
      // ADR 0865 B17 — the one run-lane gate (ADR 0820 G3's type gate is step 2).
      await assertCanvasRunAccess(scope, c, 'read');
      return { canvasId, state: project(c.state, opts?.fields), canvasTypeId: c.canvasTypeId, version: c.version };
    },

    async write(canvasId, mutation, opts) {
      // B17 — the gate runs before the idempotency cache, so a cached result is
      // not a way around a refusal.
      await assertCanvasRunAccess(scope, await load(canvasId), 'write');
      if (opts?.idempotencyKey) {
        const cached = await idemGet<{ canvasId: string; newVersion: number }>(idem(`w:${opts.idempotencyKey}`));
        if (cached) return cached;
      }
      // ADR 0865 B18/B19 — the editor's write path: CAS retry, the live-room
      // veto and the after-write fan-out, plus the type's validator on the
      // resulting state. The run lane keeps its `shallow` default and takes no
      // snapshot (runs create canvases; they don't iterate them).
      const out = await updateCanvasForTenant(tenantId, canvasId, (mutation ?? {}) as Json, {
        merge: opts?.merge ?? 'shallow',
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        validate: true,
      });
      if (!out) throw Object.assign(new Error(`canvas ${canvasId} not found`), { code: 'canvas_not_found' });
      if (opts?.idempotencyKey) return idemPut(idem(`w:${opts.idempotencyKey}`), out);
      return out;
    },

    async create({ canvasTypeId, projectId, name, initialState, metadata, idempotencyKey }) {
      // B17 on a canvas that does not exist yet: tenant-owned, so steps 2–4 apply.
      await assertCanvasRunAccess(scope, { canvasId: '(new)', canvasTypeId }, 'write');
      assertCanvasStateValid(canvasTypeId, ((initialState as Json) ?? {}));
      const now = new Date().toISOString();
      const canvas: Canvas = {
        canvasId: `canvas-${randomUUID()}`,
        tenantId,
        canvasTypeId,
        ...(name !== undefined ? { name } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        state: (initialState as Json) ?? {},
        version: 1,
        ...(metadata !== undefined ? { metadata: metadata as Json } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const out = { canvasId: canvas.canvasId, canvasTypeId, ...(name ? { name } : {}), ...(projectId ? { projectId } : {}), createdAt: now };
      // CANVAS-IDEM-ORPHAN-1: claim the key, THEN write the row (see idemCreate).
      if (idempotencyKey) return idemCreate(idem(`c:${idempotencyKey}`), idempotencyKey, canvas, out);
      await canvases.put(canvas);
      return out;
    },

    async invoke(targetCanvasId, workflowId, args, opts) {
      // Surface-direct callers (no app boot) have no dispatcher — stay honest.
      if (!_invokeDeps) {
        log.info('canvas invoke: dispatcher not initialized (surface-direct)', { targetCanvasId, workflowId });
        return { childRunId: `canvas-invoke-${randomUUID()}`, result: { demo: 'run dispatcher not initialized' } };
      }
      const { storage, getWorkflow, executeRun } = _invokeDeps;

      // Circuit breaker: after N consecutive child-run failures for this
      // target, open the circuit (configurable threshold; default 5).
      const cbKey = `${tenantId}::${targetCanvasId}`;
      const threshold = Number((opts?.circuitBreaker as { threshold?: number } | undefined)?.threshold ?? 5);
      if ((_circuit.get(cbKey) ?? 0) >= threshold) {
        log.warn('canvas invoke: circuit open', { targetCanvasId, failures: _circuit.get(cbKey) });
        return { childRunId: '', circuitOpen: true };
      }

      // Recursion/depth guard — walk the parentRunId ancestor chain.
      const ancestors: string[] = [];
      let cursor = scope.runId;
      while (cursor && ancestors.length < MAX_INVOKE_DEPTH) {
        const a = await storage.getRun(cursor);
        if (!a) break;
        ancestors.push(a.workflowId);
        cursor = a.parentRunId;
      }
      if (ancestors.length >= MAX_INVOKE_DEPTH) {
        throw Object.assign(new Error(`canvas invoke depth ${ancestors.length} exceeds ${MAX_INVOKE_DEPTH}`), { code: 'canvas_invoke_depth_exceeded' });
      }
      if (ancestors.includes(workflowId)) {
        throw Object.assign(new Error(`canvas invoke cycle: '${workflowId}' already in ancestor chain`), { code: 'canvas_invoke_cycle_detected' });
      }

      const wf = await getWorkflow(tenantId, workflowId);
      if (!wf) {
        throw Object.assign(new Error(`canvas invoke: workflow '${workflowId}' not found`), { code: 'canvas_invoke_workflow_not_found' });
      }

      const childRunId = randomUUID();
      const now = new Date().toISOString();
      const childRun: RunRecord = {
        runId: childRunId,
        workflowId,
        tenantId,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        status: 'pending',
        inputs: (args as Json) ?? {},
        // ADR 0832 D3 — the invoking run's person bounds the child's orgs (it
        // narrows; the child still acts for nobody, as before).
        metadata: { causationCanvasId: targetCanvasId, ...(runOrgScopeSubject(scope) ? { orgScopeSubject: runOrgScopeSubject(scope) } : {}) },
        configurable: {},
        ...(scope.runId ? { parentRunId: scope.runId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(storage, childRun, { definition: wf.definition });

      // awaitTerminal:false → fire-and-forget; return the id immediately.
      if (opts?.awaitTerminal === false) {
        void executeRun(storage, childRun, wf.definition, {}).catch((err) => log.warn('canvas child run (async) failed', { childRunId, error: err instanceof Error ? err.message : String(err) }));
        return { childRunId };
      }

      // Await terminal (executeRun resolves at terminal/suspend). Optional
      // timeout: stop waiting but let the run continue in the background.
      const runP = executeRun(storage, childRun, wf.definition, {}).catch(() => undefined);
      let timedOut = false;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        await Promise.race([runP, new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, opts.timeoutMs))]);
        if (timedOut) return { childRunId, result: { timedOut: true } };
      } else {
        await runP;
      }

      const finalChild = await storage.getRun(childRunId);
      const status = finalChild?.status ?? 'failed';
      // Circuit-breaker bookkeeping: count failures, reset on success.
      _circuit.set(cbKey, status === 'failed' ? (_circuit.get(cbKey) ?? 0) + 1 : 0);

      const result = snapshotRunVariables(childRunId) ?? {};
      const out: { childRunId: string; result?: unknown; circuitOpen?: boolean; terminalStatus?: string; error?: unknown } = {
        childRunId,
        ...(TERMINAL_RUN.includes(status) ? { terminalStatus: status } : {}),
        result,
        ...(finalChild?.error ? { error: finalChild.error } : {}),
      };
      return out;
    },
  };
}
