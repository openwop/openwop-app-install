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
import { fenceUntrustedBlock } from './untrustedContent.js';
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

function record(toolName: string, fenced: boolean, decision: 'trusted' | 'untrusted' | 'unknown'): void {
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

/**
 * Fence `content` iff the named builtin declared `contentTrust: 'untrusted'`.
 *
 * @param toolName the builtin's registered id
 * @param content  the text about to become a model message — pass the FINAL
 *                 text (i.e. after any compaction transform), so the fence wraps
 *                 what the model actually reads
 * @param isError  a host-authored error string is never fenced; burying a
 *                 diagnostic in a data-only wrapper helps nobody
 */
export function toModelToolResult(toolName: string, content: string, isError?: boolean): string {
  if (isError) return content;
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
  const declared = builtinAgentTool(toolName)?.contentTrust;
  const decision = declared ?? 'unknown';
  if (declared === 'trusted') {
    record(toolName, false, decision);
    return content;
  }
  record(toolName, true, decision);
  return fenceUntrustedBlock(content, `the \`${toolName}\` tool`);
}
