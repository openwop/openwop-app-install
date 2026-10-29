/**
 * ADR 1002 D4 — agent tool results are recorded to the invocation log, and a
 * replay fork is SERVED them instead of executing the tool.
 *
 * Without this, a replay fork re-ran every tool its (served) model rounds asked
 * for. Guarded effects were refused (ADR 0531), but `kanban.add-todo`,
 * `documents.draft`, `email.draft`, `tasks.schedule-*` and
 * `walkthroughs.register-draft` write durable rows through no guarded seam, and
 * each keys its idempotency on `runId`, which a fork changes. So a replay filed a
 * second card, a second draft, a second standing schedule. And any tool whose
 * replayed result differed from the source's (a refused effect, a read of changed
 * state) changed the next model round's digest, which then called the model live.
 *
 * The identity is the same RFC 0150 §B `logicalInvocationId` the model rounds
 * use, with an ordinal from the same per-node allocator. The loop runs round,
 * its tool calls, next round, so source and replay allocate identical ordinals
 * as long as the rounds are served.
 *
 * The read is replay-only, like the model rounds (ADR 1002 D2): a live run
 * executes every call. On a replay a miss DOES NOT EXECUTE, and it FAILS THE
 * NODE with `replay_source_missing` (the code ADR 0341 uses for a side-effecting
 * node the source never reached). It must not reach the model as a tool error:
 * a model shown a different result than the source's continues live. The loop
 * (`runChatToolLoop`) turns any `executeTool` throw into a tool result, so the
 * guard records the miss instead, refuses every later call, and throws from
 * `guardModelRound` before the next model round. The node reads `miss()` after
 * the loop, which also covers a miss in the loop's last round. Reads are not
 * exempted: the only read/write signal (`BuiltinTool.effect`) is display-only
 * by contract, MCP tools carry none, and a miss means the replay has already
 * diverged.
 */

import { createHash } from 'node:crypto';
import type { ExecuteAgentTool } from './agentDispatch.js';
import { canonicalize } from './canonicalJson.js';
import { logicalInvocationId, nextLogicalInvocationOrdinal } from './effectIdentity.js';
import { currentEffectContext } from './runEffectContext.js';
import { getInvocationLog, type InvocationRecordKey } from '../executor/invocationLog.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.replayToolResults');

/** Results whose serialized record is larger are not recorded; replaying such a
 *  call fails closed (`replay_source_missing`). */
export const MAX_RECORDED_TOOL_RESULT_BYTES = 1024 * 1024;

const TOOL_CALL_RECIPE = 'openwop-app.tool-call.v1';
const RECORD_KIND = 'openwop-app.tool-result';

type ToolResult = Awaited<ReturnType<ExecuteAgentTool>>;

/** What one executed call records. `tenantId` is checked on every replay read. */
interface ToolResultRecord {
  kind: typeof RECORD_KIND;
  tenantId: string;
  outcome: 'returned' | 'threw';
  result?: ToolResult;
  error?: { name: string; message: string; code?: string };
}

export const REPLAY_SOURCE_MISSING = 'replay_source_missing';
export const REPLAY_TENANT_MISMATCH = 'replay_tenant_mismatch';

/** The `providerKey` of a tool call: name + input. The provider-minted call id is
 *  excluded; a served round carries the source's ids anyway. */
export function toolCallKey(name: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize({ recipe: TOOL_CALL_RECIPE, name, input }), 'utf8').digest('hex');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Decode a stored record, field by field; never a cast. `'not-a-record'` when
 *  nothing (or something else) is stored there, `'invalid'` for a tool-result
 *  record whose shape this host did not write. Both are served as a miss. */
function decodeToolResultRecord(v: unknown): ToolResultRecord | 'not-a-record' | 'invalid' {
  if (!isObject(v) || v.kind !== RECORD_KIND) return 'not-a-record';
  if (typeof v.tenantId !== 'string') return 'invalid';
  if (v.outcome === 'returned') {
    const r = v.result;
    if (!isObject(r) || typeof r.content !== 'string') return 'invalid';
    const result: ToolResult = { content: r.content };
    if (typeof r.isError === 'boolean') result.isError = r.isError;
    if (typeof r.errorCode === 'string') result.errorCode = r.errorCode;
    if (typeof r.continueTurn === 'string' || r.continueTurn === null) result.continueTurn = r.continueTurn;
    return { kind: RECORD_KIND, tenantId: v.tenantId, outcome: 'returned', result };
  }
  if (v.outcome === 'threw') {
    const e = v.error;
    if (!isObject(e) || typeof e.name !== 'string' || typeof e.message !== 'string') return 'invalid';
    return { kind: RECORD_KIND, tenantId: v.tenantId, outcome: 'threw', error: { name: e.name, message: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) } };
  }
  return 'invalid';
}

/** Re-throw a recorded throw with its name, message and code restored, so the
 *  loop's `extractToolErrorCode` derives the same code as it did live. */
function rethrow(recorded: NonNullable<ToolResultRecord['error']>): never {
  const err = Object.assign(new Error(recorded.message), recorded.code ? { code: recorded.code } : {});
  err.name = recorded.name;
  throw err;
}

/** A replay miss: the first tool call this replay could not serve. */
export interface ReplayToolMiss { code: typeof REPLAY_SOURCE_MISSING | typeof REPLAY_TENANT_MISMATCH; tool: string; message: string }

/** Thrown by `guardModelRound` once a miss is recorded, so no model round runs after it. */
export class ReplayToolMissError extends Error {
  readonly code: ReplayToolMiss['code'];
  constructor(miss: ReplayToolMiss) {
    super(miss.message);
    this.name = 'ReplayToolMissError';
    this.code = miss.code;
  }
}

/** The node outcome for a replay miss: a typed, non-retryable failure. A retry
 *  would replay the same missing record. */
export function replayMissFailure(miss: ReplayToolMiss): { status: 'failure'; retryable: false; error: { code: string; message: string } } {
  return { status: 'failure', retryable: false, error: { code: miss.code, message: `replay of tool "${miss.tool}": ${miss.message}` } };
}

export interface ReplayToolGuard {
  /** The agent-runner's `executeTool`, recording live and serving on replay. */
  executeTool: ExecuteAgentTool;
  /** Wrap the node's tools-round call so no model round runs after a miss. */
  guardModelRound<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  /** The first miss, or null. The node fails with its code when set. */
  miss(): ReplayToolMiss | null;
}

/**
 * Guard the agent-runner's tool execution for one node execution. Outside a node
 * execution (no run effect context) or with no installed invocation backend,
 * `executeTool` is `execute` unchanged and nothing can miss.
 */
export function createReplayToolGuard(execute: ExecuteAgentTool): ReplayToolGuard {
  let missed: ReplayToolMiss | null = null;
  const refuse = (m: ReplayToolMiss): ToolResult => {
    missed ??= m;
    return { content: `${missed.code}: ${missed.message}`, isError: true, errorCode: missed.code };
  };
  const executeTool: ExecuteAgentTool = async (call) => {
    if (missed) return refuse(missed);
    const ctx = currentEffectContext();
    if (!ctx?.nodeId || !ctx.tenantId) return execute(call);
    let invocationLog: ReturnType<typeof getInvocationLog>;
    try { invocationLog = getInvocationLog(); } catch { return execute(call); }

    const { runId, nodeId, tenantId } = ctx;
    const attempt = ctx.attempt ?? 1;
    const providerKey = toolCallKey(call.name, call.input);
    const ordinal = nextLogicalInvocationOrdinal(runId, nodeId, attempt);
    const identityFor = (rid: string): string =>
      logicalInvocationId({ tenantId, runId: rid, nodeId, logicalInvocationOrdinal: ordinal, providerKey });
    const cacheKey: InvocationRecordKey = { runId, nodeId, attempt, invocationId: identityFor(runId) };

    const sourceRunId = ctx.replaySourceRunId;
    if (sourceRunId) {
      let recorded = decodeToolResultRecord(await invocationLog.get(cacheKey));
      if (recorded === 'not-a-record') {
        recorded = decodeToolResultRecord(await invocationLog.get({ ...cacheKey, runId: sourceRunId, invocationId: identityFor(sourceRunId) }));
        // The tenant is in the identity preimage, so another tenant's record
        // cannot be addressed. The check is the explicit second guard: a record
        // never crosses a tenant, and never lands under this run's key.
        if (typeof recorded === 'object' && recorded.tenantId === tenantId) {
          await invocationLog.put(cacheKey, recorded).catch(() => undefined);
        }
      }
      if (recorded === 'invalid') {
        log.error('replay tool record has an unexpected shape; refused', { runId, nodeId, tool: call.name });
      } else if (recorded !== 'not-a-record') {
        if (recorded.tenantId !== tenantId) {
          log.error('replay tool record belongs to another tenant; refused', { runId, nodeId, tool: call.name });
          return refuse({ code: REPLAY_TENANT_MISMATCH, tool: call.name, message: `the recorded result of "${call.name}" is not this tenant's.` });
        }
        if (recorded.outcome === 'threw' && recorded.error) rethrow(recorded.error);
        if (recorded.result) return recorded.result;
      }
      return refuse({ code: REPLAY_SOURCE_MISSING, tool: call.name, message: `"${call.name}" has no usable recorded result in the source run, so this replay did not execute it.` });
    }

    const persist = async (record: ToolResultRecord): Promise<void> => {
      // Same scrub as the model failure envelopes (SR-1). Best-effort: the call
      // already ran, so a lost write must not fail it.
      const scrubbed = stripSecretsFromPersisted(record);
      const bytes = Buffer.byteLength(JSON.stringify(scrubbed), 'utf8');
      if (bytes <= MAX_RECORDED_TOOL_RESULT_BYTES) {
        await invocationLog.put(cacheKey, scrubbed).catch((err: unknown) => {
          log.warn('tool result record failed', { runId, nodeId, tool: call.name, err: err instanceof Error ? err.message : String(err) });
        });
      } else {
        log.info('tool result over the record cap; a replay of this call fails closed', { runId, nodeId, tool: call.name, bytes });
      }
    };
    let out: ToolResult;
    try {
      out = await execute(call);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Control-flow signals are never outcomes (the model-record rule).
      if (!(e.name === 'SuspendSignal' || e.name === 'AbortError' || e.name === 'LeaseLostError')) {
        const code = 'code' in e && typeof e.code === 'string' ? e.code : undefined;
        await persist({ kind: RECORD_KIND, tenantId, outcome: 'threw', error: { name: e.name, message: e.message, ...(code ? { code } : {}) } });
      }
      throw err;
    }
    await persist({ kind: RECORD_KIND, tenantId, outcome: 'returned', result: out });
    return out;
  };
  return {
    executeTool,
    // Off the replay lane nothing can miss, so the model call is passed through
    // as-is (the same function the executor bound).
    guardModelRound: (fn) => (!currentEffectContext()?.replaySourceRunId ? fn : async (...args) => {
      if (missed) throw new ReplayToolMissError(missed);
      return fn(...args);
    }),
    miss: () => missed,
  };
}
