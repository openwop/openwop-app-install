/**
 * ADR 0785 P5 / D8 — the app-dispatched lane: a chain step runs ONE stateless
 * task on the run owner's own Claude Code, and the heartbeat stays the only loop.
 *
 *   node `claude-code.task`  →  claim the task row (CAS, BEFORE anything is sent)
 *                            →  send ONE task frame to the owner's online device
 *                            →  ctx.suspend (external-event, keyed on the task id)
 *   companion                →  headless `claude -p` (its permission prompts go to
 *                               the P4 tool) → POST the typed result
 *   result route             →  CAS dispatched → completed|failed, then resume the
 *                               node through `resolveAndResume` (the one choke)
 *   deadline sweep           →  a task past its deadline resumes as `expired`
 *
 * The invariants the architect review demanded (ADR 0785 D8 corrections):
 *   - AT-MOST-ONCE: the row is claimed (`putIfAbsent`) before the frame is sent.
 *     A node re-executed for any reason (crash recovery, a redelivered resume)
 *     finds the claim and does NOT send again — it waits on the same task.
 *   - NO AUTO-RETRY after a send: an expired task surfaces as `maybe_executed`, a
 *     typed failure a human resolves; its effects on the machine may be real.
 *   - RUNNER-UNAVAILABLE is decided BEFORE the claim (nothing sent ⇒ retriable).
 *   - SUBJECT-FIRST: only a device paired by the run's own acting user is ever
 *     chosen; there is no fallback to anyone else's device.
 *   - Output is UNTRUSTED transport (RFC 0122 `runner-output-untrusted-transport`):
 *     the summary comes back fenced.
 *
 * Transport honesty: the frames reuse RFC 0122's dispatch/result SHAPES, but they
 * travel over the P2 device socket, not RFC 0122's SSE/POST runner channel. So
 * this host does NOT advertise `selfHostedRunner` — that would claim a transport
 * it does not serve (ADR 0785 P5 correction).
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import type { NodeContext, NodeOutcome } from '../../executor/types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveAndResume } from '../../routes/interrupts.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { CLAUDE_CODE_BASE, CLAUDE_CODE_TOGGLE, claudeCodeOperatorEnabled } from './constants.js';
import { deviceForKey, type DeviceRecord } from './pairingService.js';
import { isDeviceOnline } from './terminalStore.js';
import { getRelay } from './terminalSockets.js';

const log = createLogger('claude-code.tasks');

export const TASK_NODE_TYPE = 'claude-code.task';
const DEFAULT_DEADLINE_MIN = 30;
const MAX_DEADLINE_MIN = 120;
const DEFAULT_MAX_TURNS = 30;
const MAX_MAX_TURNS = 100;
const SUMMARY_MAX = 8000;
const SWEEP_MS = 30_000;

export type TaskStatus = 'dispatched' | 'completed' | 'failed' | 'expired';

export interface TaskRecord {
  taskId: string;
  tenantId: string;
  subject: string;
  deviceId: string;
  runId: string;
  nodeId: string;
  status: TaskStatus;
  createdAt: string;
  deadlineAt: string;
  result?: { isError: boolean; summary: string; numTurns?: number; costUsd?: number };
}

const tasks = new DurableCollection<TaskRecord>('claude-code:task', (t) => t.taskId, undefined, (t) => t.tenantId);

/** One task per (run, node): a fork is a new run, so a new task; a re-execution is not. */
export const taskIdFor = (runId: string, nodeId: string): string =>
  `cctask_${createHash('sha256').update(`${runId}\u0000${nodeId}`).digest('hex').slice(0, 32)}`;

const fail = (code: string, message: string): NodeOutcome => ({ status: 'failure', error: { code, message } });

/** The resume value a task delivers to its suspended node. */
export type TaskResume =
  | { status: 'completed'; isError: boolean; summary: string; numTurns?: number; costUsd?: number }
  | { status: 'failed'; message: string }
  | { status: 'expired' };

function outcomeFrom(taskId: string, v: unknown): NodeOutcome {
  const r = (v ?? {}) as Partial<TaskResume> & Record<string, unknown>;
  if (r.status === 'completed') {
    const summary = typeof r.summary === 'string' ? r.summary : '';
    return {
      status: r.isError ? 'failure' : 'success',
      ...(r.isError ? { error: { code: 'task_error', message: 'Claude Code reported the task did not succeed.' } } : {}),
      outputs: {
        taskId,
        // RFC 0122 runner-output-untrusted-transport: fenced before it re-enters a run.
        summary: `<UNTRUSTED source="claude-code">\n${summary}\n</UNTRUSTED>`,
        ...(typeof r.numTurns === 'number' ? { numTurns: r.numTurns } : {}),
        ...(typeof r.costUsd === 'number' ? { costUsd: r.costUsd } : {}),
      },
    } as NodeOutcome;
  }
  if (r.status === 'failed') return fail('task_failed', typeof r.message === 'string' ? r.message.slice(0, 500) : 'The task failed on the device.');
  // Expired AFTER a send: it may have run. Never retried automatically.
  return fail('maybe_executed', 'The task did not report back before its deadline. It may have run on the device; check there before retrying.');
}

/**
 * Who the task is FOR. A human-started run carries `actingUserId`. A run the
 * heartbeat or an approval started carries none (MEASURED: `heartbeatService` and
 * `approvalDecision` stamp only their provenance block), so the card's board
 * decides — and only a PERSONAL board, whose owner is unambiguous. An agent's
 * board has no human owner: that run gets `runner_unavailable`, never a guess.
 */
async function actingHuman(ctx: NodeContext): Promise<string | null> {
  if (ctx.actingUserId) return ctx.actingUserId.startsWith('apikey:') ? null : ctx.actingUserId;
  if (!sweepDeps) return null;
  const run = await sweepDeps.storage.getRun(ctx.runId).catch(() => null);
  const meta = (run?.metadata ?? {}) as { heartbeat?: { boardId?: string }; approval?: { boardId?: string } };
  const boardId = meta.heartbeat?.boardId ?? meta.approval?.boardId;
  if (!boardId) return null;
  const { getBoard } = await import('../../host/kanbanService.js');
  const board = await getBoard(boardId).catch(() => null);
  return board && board.ownerUserId ? board.ownerUserId : null;
}

/** Which device runs the task, or why none can. ADR 0785 D7: only a device whose owner
 *  turned on workflow tasks is ever chosen — pairing alone never authorises unattended
 *  work (the consent text promises it is "a separate choice I make per device"). */
async function chooseDevice(ctx: NodeContext, wanted: string | undefined): Promise<DeviceRecord | 'consent_required' | null> {
  const acting = await actingHuman(ctx);
  if (!acting) return null; // a person's run, never a key's, never a guess
  const { listDeviceRecordsForSubject, listDeviceRecordsForOwnerUser } = await import('./pairingService.js');
  const byId = new Map<string, DeviceRecord>();
  for (const d of [...await listDeviceRecordsForSubject(ctx.tenantId, acting), ...await listDeviceRecordsForOwnerUser(ctx.tenantId, acting)]) byId.set(d.deviceId, d);
  const mine = [...byId.values()].filter((d) => !d.revokedAt && (!wanted || d.deviceId === wanted));
  const allowed = mine.filter((d) => d.workflowTasks);
  if (mine.length > 0 && allowed.length === 0) return 'consent_required';
  for (const d of allowed) if (await isDeviceOnline(d.deviceId)) return d;
  return null;
}

let nodeRegistered = false;

export function registerClaudeCodeTaskNode(): void {
  if (nodeRegistered) return;
  nodeRegistered = true;
  getNodeRegistry().register({
    typeId: TASK_NODE_TYPE,
    version: '1.0.0',
    sideEffecting: true, // a replay-mode fork reproduces the recorded outcome; it never re-dispatches
    execute: async (ctx: NodeContext): Promise<NodeOutcome> => {
      if (!claudeCodeOperatorEnabled()) return fail('capability_not_provided', 'Claude Code is not available on this host.');
      const toggle = await resolveOne(CLAUDE_CODE_TOGGLE, { tenantId: ctx.tenantId, ...(ctx.actingUserId ? { userId: ctx.actingUserId } : {}) }).catch(() => null);
      if (!toggle?.enabled) return fail('feature_disabled', 'Claude Code is not enabled for this workspace.');
      if (!ctx.suspend) return fail('capability_not_provided', 'This run cannot wait for an external result.');
      // The builder's form edits a node's CONFIG; an upstream edge feeds its INPUTS.
      // Inputs win (the `{ ...config, ...inputs }` convention every pack node follows).
      const inputs = { ...(ctx.config ?? {}), ...((ctx.inputs ?? {}) as Record<string, unknown>) };
      const prompt = typeof inputs.prompt === 'string' ? inputs.prompt.trim() : '';
      if (!prompt) return fail('validation_error', '`prompt` is required.');
      const deadlineMin = Math.min(MAX_DEADLINE_MIN, Math.max(1, Number(inputs.deadlineMinutes) || DEFAULT_DEADLINE_MIN));
      const maxTurns = Math.min(MAX_MAX_TURNS, Math.max(1, Number(inputs.maxTurns) || DEFAULT_MAX_TURNS));
      const taskId = taskIdFor(ctx.runId, ctx.nodeId);

      const existing = await tasks.get(taskId);
      if (!existing) {
        // Decided BEFORE the claim: nothing has been sent, so this is retriable.
        const device = await chooseDevice(ctx, typeof inputs.device === 'string' ? inputs.device : undefined);
        if (device === 'consent_required') return fail('consent_required', 'No Claude Code device of yours accepts workflow tasks. Turn on "Workflow tasks" for a device on the Claude Code page, then retry.');
        if (!device) return fail('runner_unavailable', 'None of your Claude Code devices that accept workflow tasks is online. Start `openwop-agent-host run` on one, then retry.');
        const now = Date.now();
        const rec: TaskRecord = {
          taskId, tenantId: ctx.tenantId, subject: device.subject, deviceId: device.deviceId,
          runId: ctx.runId, nodeId: ctx.nodeId, status: 'dispatched',
          createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + deadlineMin * 60_000).toISOString(),
        };
        // CLAIM BEFORE SEND. Losing the race means another execution already sent it.
        if (await tasks.putIfAbsent(rec)) {
          ensureSweep();
          await getRelay().sendToDevice(device.deviceId, {
            type: 'task', taskId, runId: ctx.runId, stepId: ctx.nodeId, seq: 1, kind: 'tool', tool: 'claude-code.task',
            inputs: { prompt, maxTurns },
          });
          log.info('task_dispatched', { taskId, runId: ctx.runId, deviceId: device.deviceId });
        }
      }
      // Suspend until the device reports (or the sweep expires it). On re-entry the
      // executor hands back the resume value; a re-execution that finds the claim
      // lands here too and waits on the SAME task — it never sends again.
      const resumed = await ctx.suspend({ kind: 'external-event', key: taskId, correlation: taskId, data: { taskId, tool: 'claude-code.task' } });
      return outcomeFrom(taskId, resumed);
    },
  });
}

// ── Completion: device result + deadline sweep ──────────────────────────────

async function finish(deps: Pick<RouteDeps, 'storage' | 'hostSuite'>, task: TaskRecord, next: TaskStatus, resume: TaskResume, result?: TaskRecord['result']): Promise<boolean> {
  const updated: TaskRecord = { ...task, status: next, ...(result ? { result } : {}) };
  if (!(await tasks.compareAndSwap(task, updated))) return false; // someone else finished it
  const interrupt = await deps.storage.getInterruptByNode(task.runId, task.nodeId);
  if (interrupt && !interrupt.resolvedAt) {
    await resolveAndResume(deps.storage, deps.hostSuite, interrupt.interruptId, resume).catch((err: unknown) =>
      log.warn('task_resume_failed', { taskId: task.taskId, error: err instanceof Error ? err.message : String(err) }));
  }
  return true;
}

let sweepDeps: Pick<RouteDeps, 'storage' | 'hostSuite'> | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweep(): void {
  if (sweepTimer || !sweepDeps) return;
  // ADR 0650 — a storage-touching worker enters the event seat under the named contract.
  sweepTimer = setInterval(() => { void runUnderWorkerContract(() => sweepExpiredTasks()); }, SWEEP_MS);
  sweepTimer.unref();
}

/** Expire overdue dispatched tasks (the deadline an external-event suspend lacks). */
export async function sweepExpiredTasks(now = Date.now()): Promise<number> {
  if (!sweepDeps) return 0;
  let n = 0;
  for (const t of await tasks.list()) {
    if (t.status !== 'dispatched' || Date.parse(t.deadlineAt) > now) continue;
    if (await finish(sweepDeps, t, 'expired', { status: 'expired' })) n += 1;
  }
  return n;
}

/** The device posts its result. Only the device the task was sent to may. */
export function registerClaudeCodeTaskRoutes(deps: RouteDeps): void {
  sweepDeps = { storage: deps.storage, hostSuite: deps.hostSuite };
  // Start the deadline sweep at boot, not only after a local dispatch: a task
  // that expires across a restart must still be expired (review finding).
  if (claudeCodeOperatorEnabled()) ensureSweep();
  deps.app.post(`${CLAUDE_CODE_BASE}/tasks/:taskId/result`, (req, res, next) => {
    void (async () => {
      if (!claudeCodeOperatorEnabled()) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const device = await deviceOf(req);
      const task = await tasks.get(req.params.taskId ?? '');
      // Uniform 404: unknown, or not this device's task.
      if (!device || !task || task.deviceId !== device.deviceId) throw new OpenwopError('not_found', 'Task not found.', 404, {});
      if (task.status !== 'dispatched') { res.status(200).json({ status: task.status, alreadyFinished: true }); return; }
      const b = (req.body ?? {}) as { status?: unknown; isError?: unknown; summary?: unknown; numTurns?: unknown; costUsd?: unknown; message?: unknown };
      if (b.status === 'failed') {
        const message = typeof b.message === 'string' ? b.message.slice(0, 500) : 'The task failed on the device.';
        await finish(deps, task, 'failed', { status: 'failed', message });
      } else {
        const result = {
          isError: b.isError === true,
          summary: typeof b.summary === 'string' ? b.summary.slice(0, SUMMARY_MAX) : '',
          ...(Number.isFinite(Number(b.numTurns)) ? { numTurns: Number(b.numTurns) } : {}),
          ...(Number.isFinite(Number(b.costUsd)) ? { costUsd: Number(b.costUsd) } : {}),
        };
        await finish(deps, task, 'completed', { status: 'completed', ...result }, result);
      }
      res.status(200).json({ status: 'accepted' });
    })().catch(next);
  });
}

async function deviceOf(req: Request): Promise<DeviceRecord | null> {
  const auth = (req.principal as { principalId?: string; auth?: { kind?: string } } | undefined);
  if (auth?.auth?.kind !== 'api-key' || !auth.principalId?.startsWith('apikey:')) return null;
  return deviceForKey(auth.principalId.slice('apikey:'.length), req.tenantId ?? '');
}

/** DSAR: the subject's task rows in this tenant. */
export async function eraseTaskRows(tenantId: string, forms: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (const t of await tasks.listForTenantIndexed(tenantId)) if (forms.has(t.subject)) { await tasks.delete(t.taskId); n += 1; }
  return n;
}

/** Test-only. */
export async function __getTaskForTest(taskId: string): Promise<TaskRecord | null> { return tasks.get(taskId); }
