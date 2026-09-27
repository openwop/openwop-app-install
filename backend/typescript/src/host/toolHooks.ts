/**
 * RFC 0064 — tool-invocation hooks + per-tool authorization/rate-limit.
 *
 * A host advertising `capabilities.toolHooks` wraps every tool invocation
 * (MCP / HTTP / native) with a pre/post hook pair that emits the additive
 * `agent.toolCalled` / `agent.toolReturned` fields and applies per-tool
 * authorization + rate limiting. This module is the host-side evaluator;
 * it is driven both by the live MCP path and by the
 * `POST /v1/host/openwop-app/toolhooks/invoke` conformance seam.
 *
 * Contract (RFC 0064 §"Proposal"):
 *   - `agent.toolCalled` gains `{ argsHash, principal, transport }`.
 *     `argsHash` is the JCS (RFC 8785) + SHA-256 digest of the args, with
 *     SR-1 secret redaction applied to the preimage FIRST so a hashed
 *     argument can never carry a secret (the content-free-audit guarantee).
 *   - `agent.toolReturned` gains `{ status: 'ok'|'error'|'forbidden'|
 *     'rate_limited', durationMs, error? }`. `durationMs` is absent when the
 *     call never started (forbidden / rate_limited / capability-precondition).
 *     §F: a non-success return carries a populated `error` (`_errorObject`,
 *     SR-1-redacted) — `status:'error'` for a ran-and-threw failure (with
 *     `durationMs`), or a gate status. See `extractToolErrorCode` +
 *     `CAPABILITY_PRECONDITION_CODES` for the production emitter's classifier.
 *   - Authorization is fail-closed (reuses RFC 0049's `forbidden` error +
 *     `authorization-fail-closed` invariant): if `requiredScopes` are
 *     declared and the principal does not demonstrably hold all of them,
 *     refuse with `forbidden` (403) before the tool runs.
 *   - Rate limiting is a per-`(principal, tool)` token bucket; on
 *     exhaustion refuse with `rate_limited` (429) before the tool runs.
 *
 * @see RFCS/0064-tool-invocation-hooks-and-authorization.md
 * @see spec/v1/host-capabilities.md §host.toolHooks
 * @see SECURITY/invariants.yaml — authorization-fail-closed (RFC 0049)
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../providers/llmCacheKey.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { scrubSecretShaped } from './redactSecrets.js';

export type ToolHookStatus = 'ok' | 'error' | 'forbidden' | 'rate_limited';
export type ToolTransport = 'mcp' | 'http' | 'native';

export interface ToolHookRequest {
  /** RFC 0048 principal id making the call. */
  principal: string;
  toolName: string;
  /** RFC 0049 scopes the tool requires. Empty/absent ⇒ no authz gate. */
  requiredScopes?: string[];
  /** Scopes the principal demonstrably holds. Absent ⇒ unevaluable ⇒
   *  fail-closed when `requiredScopes` is non-empty. */
  grantedScopes?: string[];
  /** Tool arguments — hashed (after SR-1 redaction), never emitted raw. */
  args?: unknown;
  transport?: ToolTransport;
  /** Conformance hook: force the rate-limit branch deterministically. */
  simulateRateLimitExhausted?: boolean;
  /** RFC 0064 §F conformance hook: force a ran-and-threw tool-execution
   *  failure — the tool PASSES the gates and runs, then fails, so the return
   *  carries a populated `error` + `status:'error'` + a non-negative
   *  `durationMs` (NOT a gate status). Drives `tool-hooks-failure-honesty`. */
  simulateToolError?: boolean;
}

export interface ToolCalledFields {
  toolName: string;
  principal: string;
  transport: ToolTransport;
  argsHash: string;
}

export interface ToolReturnedFields {
  toolName: string;
  status: ToolHookStatus;
  durationMs?: number;
  /** RFC 0064 §F — the populated failure discriminator on `status:'error'`
   *  (`_errorObject`, SR-1-redacted). Absent on `ok` and on the
   *  `forbidden`/`rate_limited` gate statuses. */
  error?: { code: string; message: string };
}

export interface ToolHookResult {
  toolCalled: ToolCalledFields;
  toolReturned: ToolReturnedFields;
  /** 200 ok · 403 forbidden · 429 rate_limited. */
  httpStatus: number;
  /** Reuses RFC 0049 `forbidden` / existing `rate_limited` — no new code. */
  errorCode?: 'forbidden' | 'rate_limited';
}

/**
 * SR-1: redact secret-shaped strings in the args BEFORE canonicalizing +
 * hashing, so the hash preimage cannot contain a live secret. JCS (RFC
 * 8785) canonical bytes → SHA-256 → lowercase hex, mirroring the
 * `replay.md` §"LLM cache-key recipe" digest.
 */
export function computeArgsHash(args: unknown): string {
  const redacted = sanitizeFreeTextDeep(args ?? null);
  return createHash('sha256').update(canonicalize(redacted), 'utf8').digest('hex');
}

/**
 * RFC 0064 §E — the capability-precondition error codes. A tool that fails
 * because its owning feature is toggled OFF or not composed for this tenant
 * NEVER RAN: its `agent.toolReturned` carries a populated `error` + `status:'error'`
 * but NO `durationMs` (like the `forbidden`/`rate_limited` gate statuses). Sourced
 * from `featureSurfaces.ts` (`host_capability_disabled`) and `AiProviderError`
 * (`host_capability_missing`) — the only two thrown codes that mean "gate, not run".
 */
export const CAPABILITY_PRECONDITION_CODES: ReadonlySet<string> = new Set([
  'host_capability_disabled',
  'host_capability_missing',
]);

/**
 * RFC 0064 §E — extract a stable, wire-safe error CODE from a thrown
 * tool-execution error for `agent.toolReturned.error.code`. Honors a structured
 * `.code` (the `featureSurfaces` gate, `AiProviderError`, `OpenwopError`); falls
 * back to the generic `tool_execution_failed` for an unstructured throw. The code
 * is a discriminator, never secret-bearing — the free-text lives in `message`,
 * which the caller SR-1-redacts.
 */
export function extractToolErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'tool_execution_failed';
}

/**
 * RFC 0064 §F — derive the wire `error.code` for a FAILED tool result
 * (`isError`). The tool provider swallows a THROWN error into
 * `{ content, isError, errorCode }` (capturing the structured `.code` via
 * `extractToolErrorCode`), and stringifies a RETURNED structured failure as
 * `{ content: JSON.stringify({ code | error, message }), isError }`. This reads
 * whichever is present so the real code reaches `error.code` instead of a
 * blanket `tool_execution_failed`:
 *   1. an explicit `errorCode` (a swallowed throw's structured code) wins;
 *   2. else parse `content` as JSON and read `.code` (or `.error`);
 *   3. else the generic `tool_execution_failed`.
 * The code is a discriminator, never secret-bearing — the free text lives in the
 * `message` the caller SR-1-redacts. Pairs with `CAPABILITY_PRECONDITION_CODES`
 * to decide `durationMs` presence at the emit site.
 */
export function deriveToolErrorCode(execOut: { content: string; errorCode?: string }): string {
  if (typeof execOut.errorCode === 'string' && execOut.errorCode.length > 0) return execOut.errorCode;
  try {
    const parsed = JSON.parse(execOut.content) as { code?: unknown; error?: unknown };
    const code = typeof parsed?.code === 'string' && parsed.code.length > 0 ? parsed.code
      : typeof parsed?.error === 'string' && parsed.error.length > 0 ? parsed.error
      : undefined;
    if (code) return code;
  } catch { /* content is not structured JSON (e.g. a plain `tool_failed: …` string) — fall through */ }
  return 'tool_execution_failed';
}

/** Per-`(principal, tool)` token bucket. Module-scoped — best-effort;
 *  a production host would back this with a durable counter. */
interface Bucket {
  tokens: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
const BUCKET_CAPACITY = 5;
const BUCKET_WINDOW_MS = 60_000;

/** Reset all rate-limit buckets (test teardown). */
export function resetToolHookBuckets(): void {
  buckets.clear();
}

/** Evict expired buckets so the map can't grow unbounded across distinct
 *  (principal, tool) pairs. Cheap O(n) sweep, triggered only past a size
 *  threshold so the hot path stays O(1). */
function sweepExpired(now: number): void {
  if (buckets.size < 1024) return;
  for (const [k, v] of buckets) {
    if (now >= v.resetAt) buckets.delete(k);
  }
}

function consumeToken(key: string, now: number): boolean {
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    sweepExpired(now);
    b = { tokens: BUCKET_CAPACITY, resetAt: now + BUCKET_WINDOW_MS };
    buckets.set(key, b);
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

/**
 * Evaluate the pre/post hook pair for one tool invocation. Pure w.r.t.
 * the run event log — the caller (seam or MCP path) emits the returned
 * `toolCalled`/`toolReturned` fields. Order of gates matches RFC 0064:
 * authorization (fail-closed) before rate limit, both before the tool runs.
 */
export function evaluateToolHook(req: ToolHookRequest, now: number = Date.now()): ToolHookResult {
  const transport: ToolTransport = req.transport ?? 'native';
  const toolCalled: ToolCalledFields = {
    toolName: req.toolName,
    principal: req.principal,
    transport,
    argsHash: computeArgsHash(req.args),
  };

  // Authorization — fail closed (RFC 0049 `authorization-fail-closed`).
  const required = req.requiredScopes ?? [];
  if (required.length > 0) {
    const granted = new Set(req.grantedScopes ?? []);
    const holdsAll = req.grantedScopes !== undefined && required.every((s) => granted.has(s));
    if (!holdsAll) {
      return {
        toolCalled,
        toolReturned: { toolName: req.toolName, status: 'forbidden' },
        httpStatus: 403,
        errorCode: 'forbidden',
      };
    }
  }

  // Rate limit — per-(principal, tool) token bucket.
  const exhausted =
    req.simulateRateLimitExhausted === true || !consumeToken(`${req.principal}::${req.toolName}`, now);
  if (exhausted) {
    return {
      toolCalled,
      toolReturned: { toolName: req.toolName, status: 'rate_limited' },
      httpStatus: 429,
      errorCode: 'rate_limited',
    };
  }

  // RFC 0064 §F — a ran-and-threw tool-execution failure. The tool PASSED the
  // authz + rate-limit gates and RAN, then failed: `status:'error'` + a populated
  // `error` (`_errorObject`, SR-1-redacted) + a non-negative `durationMs` (it ran,
  // unlike the `forbidden`/`rate_limited` gate statuses). The seam call itself
  // succeeds (HTTP 200) — the failure lives in the returned tool event, not the
  // transport. Mirrors the production emitter in `agentDispatch.ts`.
  if (req.simulateToolError === true) {
    return {
      toolCalled,
      toolReturned: {
        toolName: req.toolName,
        status: 'error',
        error: { code: 'tool_execution_failed', message: scrubSecretShaped('simulated tool execution failure') },
        durationMs: 0,
      },
      httpStatus: 200,
    };
  }

  // Authorized + within budget: the tool runs. The caller measures the
  // real duration; the seam reports a measured value, defaulting to 0.
  return {
    toolCalled,
    toolReturned: { toolName: req.toolName, status: 'ok', durationMs: 0 },
    httpStatus: 200,
  };
}
