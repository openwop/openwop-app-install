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

import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from './runInsert.js';
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { snapshotRunVariables } from './variablesRuntime.js';
import type { BundleScope } from './inMemorySurfaces.js';
import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import type { Subject } from './subject.js';

const log = createLogger('host.canvas');

type Json = Record<string, unknown>;

/** Injected at boot (createApp) so crossCanvasInvoke can spawn a real child
 *  run — host surfaces don't otherwise see the run dispatcher. Mirrors
 *  `setSubWorkflowDispatcher`. */
interface CanvasInvokeDeps {
  storage: Storage;
  getWorkflow: (workflowId: string) => Promise<{ definition: WorkflowDef } | null>;
  executeRun: (storage: Storage, run: RunRecord, definition: unknown, options?: unknown) => Promise<unknown>;
}
interface WorkflowDef { variables?: unknown }
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

const canvases = new DurableCollection<Canvas>('canvas', (c) => c.canvasId);

/** Tenant-scoped read of a canvas for non-run code (ADR 0056 — document
 *  materialization). Returns null if absent or cross-tenant (no existence leak). */
export interface CanvasRecordView { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; state: Json; version: number }
export async function getCanvasForTenant(tenantId: string, canvasId: string): Promise<CanvasRecordView | null> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return null;
  return { canvasId: c.canvasId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.ownerSubject ? { ownerSubject: c.ownerSubject } : {}), state: c.state, version: c.version };
}

/** Tenant-scoped, idempotent canvas create for non-run code — the editor "open"
 *  / seed-from-artifact path (ADR 0153 §R1). Reuses the same store + `_idem` cache
 *  as the run-scoped `create`, so the same `idempotencyKey` (e.g. an artifact key)
 *  yields ONE working copy, not duplicates. Additive `ownerSubject` (§R6). */
export async function createCanvasForTenant(tenantId: string, args: {
  canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; initialState?: Json; metadata?: Json; idempotencyKey?: string;
}): Promise<CanvasRecordView> {
  if (args.idempotencyKey) {
    const cached = _idem.get(`${tenantId}::ct:${args.idempotencyKey}`) as CanvasRecordView | undefined;
    if (cached) return cached;
  }
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
  await canvases.put(canvas);
  const view: CanvasRecordView = { canvasId: canvas.canvasId, canvasTypeId: canvas.canvasTypeId, ...(canvas.name ? { name: canvas.name } : {}), ...(canvas.projectId ? { projectId: canvas.projectId } : {}), ...(canvas.ownerSubject ? { ownerSubject: canvas.ownerSubject } : {}), state: canvas.state, version: canvas.version };
  if (args.idempotencyKey) _idem.set(`${tenantId}::ct:${args.idempotencyKey}`, view);
  return view;
}

/** Tenant-scoped, idempotent create-with-a-FIXED-id (no `canvas-<uuid>` generation).
 *  For host seams that address a canvas by a well-known stable id (e.g. the RFC 0117
 *  ui-plugin `conformance-canary` artifact) — returns the existing record if present, else
 *  creates it at version 1. Distinct from `createCanvasForTenant`, which mints a random id. */
export async function ensureCanvasForTenant(
  tenantId: string, canvasId: string, args: { canvasTypeId: string; initialState?: Json },
): Promise<CanvasRecordView> {
  const existing = await getCanvasForTenant(tenantId, canvasId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const canvas: Canvas = { canvasId, tenantId, canvasTypeId: args.canvasTypeId, state: args.initialState ?? {}, version: 1, createdAt: now, updatedAt: now };
  await canvases.put(canvas);
  return { canvasId, canvasTypeId: canvas.canvasTypeId, state: canvas.state, version: canvas.version };
}

/** Tenant-scoped optimistic write for the editor save path (ADR 0153 Phase 2b) — the
 *  non-run mirror of the surface `write`. `expectedVersion` (if given) must match or it
 *  throws `canvas_version_conflict` (last-writer protection for the live editor); merge
 *  defaults to `replace` (the editor sends the whole canvas state). Returns null when the
 *  canvas is absent or cross-tenant (no existence leak). */
export async function updateCanvasForTenant(
  tenantId: string, canvasId: string, mutation: Json,
  opts?: { expectedVersion?: number; merge?: 'shallow' | 'deep' | 'replace' },
): Promise<{ canvasId: string; newVersion: number } | null> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return null;
  if (opts?.expectedVersion !== undefined && opts.expectedVersion !== c.version) {
    throw Object.assign(new Error(`canvas ${canvasId} version conflict: expected ${opts.expectedVersion}, have ${c.version}`), { code: 'canvas_version_conflict' });
  }
  const merge = opts?.merge ?? 'replace';
  const m = (mutation ?? {}) as Json;
  c.state = merge === 'replace' ? { ...m } : merge === 'deep' ? deepMerge(c.state, m) : { ...c.state, ...m };
  c.version += 1;
  c.updatedAt = new Date().toISOString();
  await canvases.put(c);
  return { canvasId, newVersion: c.version };
}

/** Test-only: seed a canvas record directly (route tests have no run to create one). */
export async function __putCanvasForTest(c: { canvasId: string; tenantId: string; canvasTypeId: string; name?: string; projectId?: string; state: Json; version?: number }): Promise<void> {
  const now = new Date().toISOString();
  await canvases.put({ canvasId: c.canvasId, tenantId: c.tenantId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), state: c.state, version: c.version ?? 1, createdAt: now, updatedAt: now });
}
// Idempotency cache for create/write keyed by tenant::idempotencyKey.
const _idem = new Map<string, unknown>();

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
      return { canvasId, state: project(c.state, opts?.fields), canvasTypeId: c.canvasTypeId, version: c.version };
    },

    async write(canvasId, mutation, opts) {
      if (opts?.idempotencyKey) {
        const cached = _idem.get(idem(`w:${opts.idempotencyKey}`)) as { canvasId: string; newVersion: number } | undefined;
        if (cached) return cached;
      }
      const c = await load(canvasId);
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== c.version) {
        throw Object.assign(new Error(`canvas ${canvasId} version conflict: expected ${opts.expectedVersion}, have ${c.version}`), { code: 'canvas_version_conflict' });
      }
      const merge = opts?.merge ?? 'shallow';
      const m = (mutation ?? {}) as Json;
      c.state = merge === 'replace' ? { ...m } : merge === 'deep' ? deepMerge(c.state, m) : { ...c.state, ...m };
      c.version += 1;
      c.updatedAt = new Date().toISOString();
      await canvases.put(c);
      const out = { canvasId, newVersion: c.version };
      if (opts?.idempotencyKey) _idem.set(idem(`w:${opts.idempotencyKey}`), out);
      return out;
    },

    async create({ canvasTypeId, projectId, name, initialState, metadata, idempotencyKey }) {
      if (idempotencyKey) {
        const cached = _idem.get(idem(`c:${idempotencyKey}`)) as { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; createdAt: string } | undefined;
        if (cached) return cached;
      }
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
      await canvases.put(canvas);
      const out = { canvasId: canvas.canvasId, canvasTypeId, ...(name ? { name } : {}), ...(projectId ? { projectId } : {}), createdAt: now };
      if (idempotencyKey) _idem.set(idem(`c:${idempotencyKey}`), out);
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

      const wf = await getWorkflow(workflowId);
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
        metadata: { causationCanvasId: targetCanvasId },
        configurable: {},
        ...(scope.runId ? { parentRunId: scope.runId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(storage, childRun);

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
