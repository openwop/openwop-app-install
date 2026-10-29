/**
 * RFC 0137 §F1 — the ONE place a builtin tool's output is fenced before it
 * becomes MODEL input.
 *
 * THE THREAT MODEL (RFC 0021 prompt-injection boundary; this docstring is its
 * sole owner — the text moved here from `agentDispatch.ts` when the duplicate
 * unconditional fence there was removed). A tool result is untrusted, model- and
 * (for web-search/HTTP tools) attacker-influenceable content. It must be fenced
 * as data-only before it re-enters the context, so embedded instructions
 * ("ignore previous…", a spoofed task) cannot hijack the agent loop — the same
 * posture KB/memory results get via `fenceUntrustedItems`. Structure is
 * preserved so JSON and multi-result bodies stay parseable, and — on the
 * `agentDispatch` path — compaction runs BEFORE fencing so the fence wraps
 * exactly what the model sees.
 *
 * CORRECTED 2026-08-23 (TOCC-6 / ADR 0604): that last clause used to be
 * unqualified, and it was false on ONE OF THE TWO PATHS THIS FILE ITSELF
 * ENUMERATES below. `features/voice/realtime/toolBridge.ts` fences and never
 * compacts — it has no run and therefore no run-start-frozen decision. The
 * asymmetry is now recorded as an explicit exemption in
 * `test/tool-result-compaction-callers.test.ts` rather than contradicted here.
 *
 * Why this is a per-tool decision and not a blanket wrap: a blanket fence makes
 * `contentTrust` decorative, and it wraps host-authored CLOSED catalogs
 * (`schema.lookup`, `slides.catalog`, `app-builder.catalog`) in a warning to
 * distrust the very vocabulary the model must author against — working against
 * the same intent `SCHEMA_READ_EXEMPT_TOOLS` encodes. The trusted set is
 * therefore small, individually justified inline, and pinned BY NAME in
 * `test/tool-content-trust-required.test.ts`: joining it is an explicit,
 * reviewable act, which is what replaced the former blanket backstop.
 *
 * Why this module exists rather than a fence inside `executeTool`: that result
 * is a STRUCTURED contract. Programmatic callers `JSON.parse` it, and wrapping
 * it in prose there corrupts them — it broke
 * `cfp1-small-packs-agent-tools.test.ts` with `SyntaxError: Unexpected token
 * 'B', "BEGIN UNTR"`. The fence is a prompt-composition concern, so it belongs
 * where tool output becomes a model message, and nowhere else.
 *
 * Why a shared helper rather than inlining at each site: there are TWO
 * model-facing paths, not one —
 *   1. `agentDispatch.runChatToolLoop` (serves chat, live dispatch, the anon
 *      lane, the agent-runner node, and `routes/agents`), and
 *   2. `features/voice/realtime/toolBridge`, which calls `executeTool` DIRECTLY
 *      and returns the result to a realtime voice model, bypassing the loop.
 * The voice path is the proof that inlining drifts: it was added later, reused
 * `executeTool` deliberately ("the SAME executeTool the chat path uses"), and
 * would have silently skipped a fence placed only in the loop.
 * `test/tool-result-fence-callers.test.ts` enumerates the caller set so a THIRD
 * path fails loudly instead of shipping unfenced.
 *
 * Deliberately NOT folded into `applyToolResultTransform`: that is a COMPACTION
 * seam which returns early when compaction is off (`toolResultTransform.ts` `applyToolResultTransform`, first line — the line number this sentence used to carry had drifted),
 * so fencing inside it would fail OPEN whenever a host disables compaction. Its
 * `SCHEMA_READ_EXEMPT_TOOLS` / per-tool exempt lists are savings exemptions, and
 * a savings exemption must never become a trust exemption.
 */

import { builtinAgentTool } from './agentToolProvider.js';
import { fenceUntrustedBlock, fenceThrownToolError, TOOL_FAILED_PREFIX, ERROR_CODE_TOKEN } from './untrustedContent.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.toModelToolResult');

/**
 * XCH-F1-2 — per-tool fence tally, so over- and under-fencing are OBSERVABLE.
 *
 * The classification is hand-audited: a second pass over my own work found 7
 * errors (5 wrong-`trusted`, 2 over-fenced). The residual rate is therefore
 * non-zero, and nothing in production reported which way a given tool resolved —
 * a wrong `trusted` looked exactly like a correct one. This is the cheap
 * instrument that FINDS the next error instead of reasoning about its
 * likelihood: `decision:'unknown'` in particular flags a tool reaching a model
 * without a registered classification at all, which is the fail-closed path and
 * the one most likely to be a wiring mistake.
 */
const tally = new Map<string, { fenced: number; passed: number }>();

/** Snapshot of fence decisions by tool id. Read-only; for diagnostics + tests. */
export function fenceTally(): Record<string, { fenced: number; passed: number }> {
  return Object.fromEntries([...tally].map(([k, v]) => [k, { ...v }]));
}

/** Test seam — the tally is process-global, so a suite must be able to reset it. */
export function __resetFenceTally(): void { tally.clear(); }

function record(toolName: string, fenced: boolean, decision: 'trusted' | 'untrusted' | 'unknown' | 'thrown' | 'returned-error'): void {
  const row = tally.get(toolName) ?? { fenced: 0, passed: 0 };
  if (fenced) row.fenced += 1; else row.passed += 1;
  tally.set(toolName, row);
  // Logged at DEBUG: this is on the per-tool-call hot path, and the tally is the
  // durable signal. `unknown` is warned ONCE per tool — it means a tool reached a
  // model with no registered classification, which is worth an operator's
  // attention but must not become a per-call log storm.
  if (decision === 'unknown' && row.fenced === 1) {
    log.warn('tool result fenced by the fail-closed default — no registered classification', { toolName });
  }
  log.debug('tool_result_fence_decision', { toolName, decision, fenced });
}

export { TOOL_FAILED_PREFIX } from './untrustedContent.js';

/** The error CODE of a tool's error content, when it carries one as a safe token. */
function errorToken(content: string): string | undefined {
  try {
    const v = JSON.parse(content) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const r = v as Record<string, unknown>;
    const code = typeof r.error === 'string' ? r.error : typeof r.code === 'string' ? r.code : undefined;
    return code && ERROR_CODE_TOKEN.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the model-facing text of a tool result. A SUCCESS is fenced iff the tool's
 * declared `contentTrust` is not `trusted` (fail closed). An ERROR:
 *
 *  - from a caught THROW (`fromThrow`) is ALWAYS fenced (TOC2CD-14, the import-free
 *    leaf `fenceThrownToolError`), whatever the tool's trust.
 *  - returned by the tool itself (`{ content, isError: true }`) — see
 *    `returnedErrorText`: fenced unless the tool is trusted, or its `toolError`
 *    helper vouched for an exact `{ error, message }` host sentence.
 *
 * Every fenced error is preceded by `TOOL_FAILED_PREFIX` OUTSIDE the fence, so the
 * model still knows the call failed (the `isError` flag is unchanged too).
 *
 * @param toolName the builtin's registered id
 * @param content  the text about to become a model message — pass the FINAL
 *                 text (i.e. after any compaction transform), so the fence wraps
 *                 what the model actually reads
 * @param isError  the result is an error
 * @param opts.fromThrow the error content is a CAUGHT THROW's message (TOC2CD-14):
 *                 arbitrary text no tool author wrote (an upstream body, a URL),
 *                 so it is ALWAYS fenced. The model still reads it as a failure:
 *                 `Tool failed (<code>):` (or `Tool failed:` with no usable code)
 *                 sits OUTSIDE the fence as host text, and the caller keeps
 *                 `isError` (14's condition, 2026-10-28).
 * @param opts.code the error's code, when the host knows one (`errorCode`). Printed
 *                 only when it is a safe token, so it can never carry the payload.
 * @param opts.hostVouched the result carried `hostMessage` — a `toolError` helper vouched for its `message`
 */
export function toModelToolResult(toolName: string, content: string, isError?: boolean, opts?: { fromThrow?: boolean; code?: string; hostVouched?: boolean }): string {
  const declared = builtinAgentTool(toolName)?.contentTrust;
  if (isError) {
    if (opts?.fromThrow) {
      record(toolName, true, 'thrown');
      return fenceThrownToolError(toolName, content, opts.code);
    }
    return returnedErrorText(toolName, content, declared, opts?.hostVouched === true);
  }
  // FAIL CLOSED. Only an EXPLICIT `trusted` skips the fence; `untrusted` and
  // "not a registered builtin" both fence.
  //
  // The unknown case is the load-bearing one. Not every tool reaching a model is
  // a registered builtin — MCP tools, pack-provided tools and node-as-tool
  // projections resolve to `undefined` here. An earlier revision read
  // `!== 'untrusted'`, which let every one of those through UNFENCED once the
  // blanket fence was removed; `agent-dispatch-tool-loop.test.ts` ("WSRCH-1")
  // caught it by calling a synthetic tool with an injection payload. Inverting
  // the test makes the registry's silence mean "fence it", not "trust it".
  const decision = declared ?? 'unknown';
  if (declared === 'trusted') {
    record(toolName, false, decision);
    return content;
  }
  record(toolName, true, decision);
  return fenceUntrustedBlock(content, `the \`${toolName}\` tool`);
}

/**
 * ADR 0999 D2 (TOC2CD-2) — the fence for the WORKFLOW-AS-TOOL lane: a chat node
 * with workflow tool bindings (`bootstrap/nodes.ts` `onToolUse`) returns a child
 * RUN's output to the provider dispatcher, which puts it in the model's context
 * verbatim. That output is whatever the child's nodes produced — an `http.fetch`
 * body, a web search, a form submission — so it is never host-authored
 * vocabulary, and there is no per-tool `contentTrust` to consult: a binding name
 * is author-chosen (`^[a-zA-Z0-9_-]{1,64}$`, so it can never name a builtin).
 * It therefore ALWAYS fences.
 *
 * Unlike `toModelToolResult`, a FAILED child is fenced too: a builtin's error is
 * host-authored text, but a child run's `error` is whatever its failing node said,
 * which can echo fetched content. Callers leave a `pending` result (a run id and a
 * fixed host sentence) unfenced, so its instruction is not wrapped in a distrust
 * warning.
 *
 * Kept in THIS module so the fence decision has one owner; recorded in the tally
 * under `workflow:<name>` so it is observable beside the builtin decisions.
 */
export function toModelWorkflowToolResult(bindingName: string, content: string): string {
  record(`workflow:${bindingName}`, true, 'untrusted');
  return fenceUntrustedBlock(content, `the \`${bindingName}\` workflow tool`);
}

/**
 * A RETURNED error — fenced by PROVENANCE, not by tool trust (TOC2CD-11, ADR 1000).
 *
 *  - A `trusted` tool's error is unchanged: its whole result is host vocabulary.
 *  - A result a `toolError` / `untrustedToolError` helper vouched for (`hostMessage`;
 *    the AST ratchet proves every such `message` is a host sentence):
 *      - exactly `{ error, message }` → unchanged. These are the recovery
 *        instructions agents act on ("pass `orgId` (ask the user which)");
 *      - `{ error, message, …anything else }` (a `detail`, or a validator's extra
 *        keys such as `errors` / `defects`) → `Tool failed (<code>): <message>` as
 *        host text, then the rest INSIDE the fence. The instruction stays
 *        followable; only what came with it is fenced.
 *  - Anything else — no flag (a raw upstream body that merely looks like
 *    `{error, message}`, an inline error) — is fenced whole after `Tool failed:`. The code is printed outside the fence ONLY for a vouched
 *    result (review M1): an un-vouched payload's `error` field is not host text.
 */
function returnedErrorText(toolName: string, content: string, declared: 'trusted' | 'untrusted' | undefined, hostVouched: boolean): string {
  if (declared === 'trusted') {
    record(toolName, false, 'returned-error');
    return content;
  }
  const shape = hostVouched ? vouchedShape(content) : undefined;
  if (shape && shape.rest === undefined) {
    record(toolName, false, 'returned-error');
    return content;
  }
  record(toolName, true, 'returned-error');
  if (shape) {
    // The host sentence stays host text; only what came with it is fenced — a string
    // `detail` as itself, anything else (extra keys, a non-string detail) as JSON.
    return `${TOOL_FAILED_PREFIX} (${shape.error}): ${shape.message}\n${fenceUntrustedBlock(shape.rest!, `the ${toolName} tool's error detail`)}`;
  }
  const code = hostVouched ? errorToken(content) : undefined;
  return `${TOOL_FAILED_PREFIX}${code ? ` (${code})` : ''}: ${fenceUntrustedBlock(content, `the ${toolName} tool's error`)}`;
}

/**
 * A vouched error's parts: `{ error: <safe token>, message: <string>, …rest }`.
 * `rest` is undefined when there is nothing but `error` + `message`; the string
 * itself when it is only a string `detail`; else the remaining keys as JSON (14's
 * decision, 2026-10-28: a `toolError(code, message, { extra })` keeps its host
 * sentence OUTSIDE the fence and fences only the extras — fencing it whole buried
 * the repair instruction of every validator that also returns its error list).
 */
function vouchedShape(content: string): { error: string; message: string; rest?: string } | undefined {
  try {
    const v = JSON.parse(content) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const { error, message, ...rest } = v as Record<string, unknown>;
    if (typeof error !== 'string' || !ERROR_CODE_TOKEN.test(error) || typeof message !== 'string') return undefined;
    const keys = Object.keys(rest);
    if (keys.length === 0) return { error, message };
    if (keys.length === 1 && keys[0] === 'detail' && typeof rest.detail === 'string') return { error, message, rest: rest.detail };
    return { error, message, rest: JSON.stringify(rest) };
  } catch {
    return undefined;
  }
}
