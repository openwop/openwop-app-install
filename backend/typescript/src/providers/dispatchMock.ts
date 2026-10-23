/**
 * Conformance-only mock AI provider.
 *
 * Deterministic — every behavior is read from a pre-programmed in-memory
 * queue keyed by `(runId, nodeId)`. The conformance suite POSTs a
 * `MockProgram` (one `MockBehavior` per expected provider call) via the
 * test seam `POST /v1/host/openwop-app/test/mock-ai/program` before starting
 * a run; `dispatchMock` consumes one entry per call.
 *
 * Used to drive the RFC 0032 envelope-reliability event family
 * (`envelope.retry.attempted` / `retry.exhausted` / `truncated` /
 * `refusal` / `recovery.applied` / `nlToFormat.engaged`) without any
 * real provider traffic. Production deployments MUST NOT route real
 * tenants through this — the provider is conformance-gated.
 *
 * @see aiProvidersHost.ts dispatchStructured()
 * @see RFC 0032 §B + RFC 0033 §B
 */

import type { DispatchRequest, DispatchResult } from './dispatch.js';
import type { ToolsRoundResult } from './dispatchAnthropicTools.js';

export interface MockBehavior {
  /** Provider-stop-reason string (raw — normalized downstream).
   *  - `end_turn` → stop (normal completion)
   *  - `max_tokens` / `length` → truncation
   *  - `stop_sequence` → stop
   *  - `safety` → refusal-class
   */
  stopReason?: 'end_turn' | 'max_tokens' | 'length' | 'stop_sequence' | 'safety';
  /** Text response. May be invalid JSON, markdown-fenced JSON, natural
   *  language, etc. — the dispatchStructured layer makes the
   *  retry-classification decision. */
  content?: string;
  /** Provider-side refusal text. When set, the result carries it and
   *  the structured-output layer routes as `envelope.refusal`. */
  refusalText?: string;
  /** Reported output token count. */
  outputTokens?: number;
  /** Reported input token count. */
  inputTokens?: number;
  /** ADR 0326 P3a — throw a provider-failure for this call instead of
   *  returning a completion (the deterministic stand-in for a transient
   *  upstream error; `mapDispatchErrors` classifies it). Exercises the
   *  node-retry + invocation-log failure-recording paths. */
  errorCode?: string;
  /** ADR 0889 D6 — a TOOL ROUND: the tool calls the model "makes" this round.
   *  Consumed only by `dispatchMockToolsRound` (the tool-calling path); an
   *  entry with `toolCalls` answers the round with `finishReason: 'tool_use'`,
   *  and an entry without it ends the loop with `content`. This is what lets a
   *  chat tool loop or a live agent dispatch run real tool rounds in CI with no
   *  provider key. */
  toolCalls?: ReadonlyArray<{ name: string; input?: Record<string, unknown> }>;
  /** RFC 0248 — this reply reports NO usage (a provider that omitted it). */
  noUsage?: boolean;
  /** RFC 0248 §A.3 — the structured-output mode this reply claims, for a
   *  `jsonSchema` request only (`native` reads as a JSON-schema format). */
  structuredMode?: 'native' | 'prompt';
  /** RFC 0248 §B.2 — report `min(outputTokens, the maxTokens this request
   *  carried)`, as a real provider cannot exceed its budget, and serve an entry
   *  whose `outputTokens` exceed that budget as TRUNCATED (`max_tokens`, a
   *  partial reply), as the fixture contract requires. Opt-in, so the scenarios
   *  that program fixed counts are unchanged. */
  clampOutputToMaxTokens?: boolean;
}

export type MockProgram = readonly MockBehavior[];

interface ProgramState {
  program: MockProgram;
  cursor: number;
  /** ADR 0967 — scripted by a fixture node for its OWN run (`programMockForRun`),
   *  not staged by a harness as a divergence injection. Replay must not treat
   *  it as one. */
  runScoped?: boolean;
  /** Records the maxTokens value the most recent call received — read
   *  by the conformance suite via `GET /v1/host/openwop-app/test/mock-ai/
   *  last-dispatch-budget` to verify RFC 0033 §B truncation-budget
   *  multiplication landed. */
  lastReceivedMaxTokens: number | null;
  /** Records the messages array the most recent call received, so a test can
   *  assert what reached the prompt (e.g. a board's injected strategy context or
   *  owner-subject knowledge). In-memory + conformance-gated like the rest. */
  lastReceivedMessages: ReadonlyArray<{ role: string; content: string }> | null;
  /** The `maxTokens` EVERY call received since the program was seeded, in
   *  call order — read via `GET …/test/mock-ai/dispatch-budgets`
   *  (host-sample-test-seams.md §28). Per attempt: the value the provider
   *  request carried, never a running total. `lastReceivedMaxTokens` loses the
   *  earlier calls, so it cannot show that a schema-violation retry kept its
   *  budget (RFC 0033 §C). */
  receivedMaxTokens: Array<number | null>;
}

const programs = new Map<string, ProgramState>();

/** Seed a program BEFORE a run starts. Keyed by `nodeId` so the
 *  conformance test can program without knowing the runId in advance.
 *  Conformance scenarios run with `--no-file-parallelism` so each
 *  fixture's unique nodeId is sufficient to avoid cross-test
 *  collisions WITHIN a scenario. Each new program seed REPLACES the
 *  previous queue for that nodeId.
 *
 *  It does NOT protect across scenarios: an UNDRAINED program on any nodeId
 *  outlives the scenario that seeded it, because the store is module-level and
 *  the host process spans the whole suite. That is what `resetMockPrograms`
 *  (and the seam route that now exposes it) is for — see its header. */
export function programMock(nodeId: string, program: MockProgram): void {
  programs.set(nodeId, { program, cursor: 0, lastReceivedMaxTokens: null, lastReceivedMessages: null, receivedMaxTokens: [] });
}

/** ADR 0967 — the run-scoped key. NUL cannot occur in a run id or node id. */
const runKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`;
/** ADR 0967 — run-scoped programs kept at once. They exist on a production host
 *  (the callAI fixture opt-in), so the store is bounded: the oldest is dropped. */
export const RUN_SCOPED_PROGRAM_CAP = 64;

/**
 * ADR 0967 — seed a program for ONE run's node. A fixture node calls this for
 * its own run, so two concurrent runs of the same fixture (whose node ids are
 * equal, possibly in different tenants) never read each other's script. A
 * dispatch carrying `runId` reads this key before the node-only one.
 */
export function programMockForRun(runId: string, nodeId: string, program: MockProgram): void {
  const key = runKey(runId, nodeId);
  programs.delete(key);
  programs.set(key, { program, cursor: 0, runScoped: true, lastReceivedMaxTokens: null, lastReceivedMessages: null, receivedMaxTokens: [] });
  let scoped = 0;
  for (const st of programs.values()) if (st.runScoped) scoped += 1;
  for (const [k, st] of programs) {
    if (scoped <= RUN_SCOPED_PROGRAM_CAP) break;
    if (st.runScoped) { programs.delete(k); scoped -= 1; }
  }
}

function stateFor(nodeId: string, runId?: string): ProgramState | undefined {
  return (runId !== undefined ? programs.get(runKey(runId, nodeId)) : undefined) ?? programs.get(nodeId);
}

/**
 * Wipe all programs.
 *
 * CORRECTED 2026-09-16 — this comment used to read "Called between conformance
 * scenarios." **IT WAS NOT, AND HAD NEVER BEEN.** Every caller in the repo was a
 * backend unit test; the conformance seam exposed `programMock` (SEED) and no
 * route at all for the reset, so the out-of-process conformance suite had no way
 * to wipe this store and never tried.
 *
 * THAT IS NOT A TIDINESS GAP — it leaked state ACROSS SCENARIOS. The store is
 * module-level and keyed by `nodeId` with a cursor, and several scenarios
 * (`envelope-truncation-cap-exhaustion`, `envelope-truncated`,
 * `envelope-retry-exhausted`, …) deliberately seed programs that return
 * `finishReason: 'length'`. A program not fully drained stays PENDING for the
 * rest of the host process. A later scenario dispatching on a colliding nodeId
 * consumes those leftovers, `aiProvidersHost` classifies them as truncation,
 * the retry budget exhausts, and the run fails
 * `envelope_truncation_unrecoverable` — with nothing in its own diff to explain
 * it.
 *
 * MEASURED: `replay-observable-sequence-determinism` red in-suite and green
 * alone across five runs on unchanged bases, including one red at load1 3.4 on
 * an empty box. It cost a peer session two full gate cycles before the cause was
 * found, because the symptom points at the victim scenario and the cause is in
 * whichever scenario ran earlier.
 *
 * The keying comment on `programMock` rests on TWO premises stated as fact:
 * `--no-file-parallelism` (true — `test:strict` passes it) and "reset between
 * scenarios" (false). Because both were asserted, nobody checked the second.
 */
/** How many nodeIds currently hold a program, drained or not. Exists so the
 *  reset seam can REPORT what it cleared: a reset that returns nothing is
 *  indistinguishable from a reset that did not run, which is the failure mode
 *  this whole change is about. */
export function mockProgramCount(): number {
  return programs.size;
}

export function resetMockPrograms(): void {
  programs.clear();
}

/** True when `nodeId` has a staged program entry not yet consumed. A pending
 *  program is a DELIBERATE divergence injection (host-sample-test-seams.md §5:
 *  the mock "MUST honor the program deterministically by attempt index"), so
 *  the invocation-log replay fallback must NOT short-circuit the dispatch —
 *  that is how the RFC 0041 §B refusal-divergence witness reaches the mock. */
export function hasPendingMockProgram(nodeId: string, runId?: string): boolean {
  const state = stateFor(nodeId, runId);
  return state !== undefined && state.cursor < state.program.length;
}

/** ADR 0967 — a pending program that IS a divergence injection: a run-scoped
 *  fixture script is the run's own input, so replay reads the recorded
 *  invocation instead of re-dispatching it. */
export function hasPendingDivergenceProgram(nodeId: string, runId?: string): boolean {
  const state = stateFor(nodeId, runId);
  return state !== undefined && !state.runScoped && state.cursor < state.program.length;
}

/** Return the most-recent `maxTokens` passed to a mock dispatch for
 *  `nodeId`. Returns `null` when no call has fired or the program
 *  isn't seeded. */
export function lastReceivedMaxTokens(nodeId: string): number | null {
  return programs.get(nodeId)?.lastReceivedMaxTokens ?? null;
}

/** Return the messages the most-recent mock dispatch for `nodeId` received (the
 *  composed system prompt + prior turns). `null` when no call has fired. */
/** Every `maxTokens` a mock dispatch for `nodeId` received since its program
 *  was seeded, in call order. Empty when unseeded or no call has fired. */
export function receivedMaxTokens(nodeId: string, runId?: string): ReadonlyArray<number | null> {
  return stateFor(nodeId, runId)?.receivedMaxTokens ?? [];
}

export function lastReceivedMessages(nodeId: string): ReadonlyArray<{ role: string; content: string }> | null {
  return programs.get(nodeId)?.lastReceivedMessages ?? null;
}

/** `dispatchStructured()` appends this exact directive + the JSON schema to the
 *  system prompt (aiProvidersHost.ts). The unprogrammed mock keys off it below. */
const SCHEMA_HINT_MARKER = 'matches this schema, with no preamble or trailing text: ';

/** Deterministic minimal instance of a JSON schema — the unprogrammed mock's
 *  answer to a STRUCTURED call. Without this, an unprogrammed structured
 *  dispatch returns `''`, which can never parse, so any conformance fixture
 *  that routes `core.ai.structuredOutput` through the default mock (e.g.
 *  `conformance-phase4-nondet-tool`) dies in the retry loop. Synthesis is
 *  pure + input-deterministic, so replay/fork byte-stability holds. */
export function minimalInstance(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return null;
  const s = schema as { type?: unknown; enum?: unknown[]; const?: unknown; required?: unknown; properties?: Record<string, unknown> };
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  switch (s.type) {
    case 'boolean': return true;
    case 'string': return 'mock';
    case 'number':
    case 'integer': return 0;
    case 'array': return [];
    case 'null': return null;
    case 'object': {
      const out: Record<string, unknown> = {};
      const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [];
      for (const key of required) out[key] = minimalInstance(s.properties?.[key]);
      return out;
    }
    default: return {};
  }
}

/** When the (unprogrammed) request carries `dispatchStructured`'s schema hint,
 *  emit a minimal schema-valid JSON object; otherwise keep the historical
 *  empty-stop completion (a misaligned CHAT test still surfaces as "expected
 *  N calls, got N+1" rather than a hang). */
function defaultStructuredCompletion(messages: DispatchRequest['messages']): string {
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    const at = content.indexOf(SCHEMA_HINT_MARKER);
    if (at < 0) continue;
    const raw = content.slice(at + SCHEMA_HINT_MARKER.length);
    // The schema is the trailing JSON of the directive line; further directives
    // (e.g. the RFC 0030 reasoning directive) are appended after a blank line.
    const jsonText = raw.split('\n\n')[0]?.trim() ?? '';
    try {
      return JSON.stringify(minimalInstance(JSON.parse(jsonText)));
    } catch {
      return '';
    }
  }
  return '';
}

/** Dispatch entry point. Returns a `DispatchResult`-shaped value built
 *  from the next program entry. When the program is exhausted, returns
 *  an empty-stop completion (so a misaligned test surfaces as "expected
 *  N calls, got N+1" rather than a hang). */
export async function dispatchMock(req: DispatchRequest & { nodeId?: string; runId?: string }): Promise<DispatchResult> {
  // The nodeId is not on the canonical DispatchRequest shape today —
  // `aiProvidersHost.ts` carries it on the AdapterScope and we extend
  // the dispatch request with it inline at the call site when the
  // provider is 'mock'. A real-provider adapter wouldn't see this.
  const nodeId = req.nodeId ?? '';
  const state = stateFor(nodeId, req.runId);
  // Record the maxTokens for the §B truncation-budget assertion.
  if (state) {
    state.lastReceivedMaxTokens = req.maxTokens ?? null;
    state.receivedMaxTokens.push(req.maxTokens ?? null);
    state.lastReceivedMessages = req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  }
  const behavior: MockBehavior =
    state !== undefined && state.cursor < state.program.length
      ? state.program[state.cursor++]!
      : {};

  // ADR 0326 P3a — a programmed failure throws (a plain coded error; the
  // adapter's mapDispatchErrors classifies it into an AiProviderError).
  if (behavior.errorCode) {
    throw Object.assign(new Error(`mock programmed failure (${behavior.errorCode})`), { code: behavior.errorCode });
  }
  // RFC 0248 fixture contract: a reply that would overrun this request's budget
  // is cut off there, whatever the entry said it was.
  const overBudget = behavior.clampOutputToMaxTokens === true && typeof req.maxTokens === 'number'
    && (behavior.outputTokens ?? 50) > req.maxTokens;
  const completion = overBudget ? '{"partial":' : (behavior.refusalText ?? behavior.content ?? defaultStructuredCompletion(req.messages));
  // ADR 0079 — stream the canned reply so the mock/test/demo path exercises the
  // streaming UI. Deterministic word-chunks; best-effort (a callback throw must
  // not fail the dispatch).
  if (req.onDelta && completion.length > 0) {
    for (const chunk of completion.match(/\S+\s*|\s+/g) ?? []) {
      try { await req.onDelta(chunk); } catch { /* best-effort delta */ }
    }
  }

  const scriptedOut = behavior.outputTokens ?? 50;
  const outputTokens = behavior.clampOutputToMaxTokens && typeof req.maxTokens === 'number'
    ? Math.min(scriptedOut, req.maxTokens)
    : scriptedOut;
  return {
    provider: 'mock',
    model: req.model || 'mock-mini',
    completion,
    ...(behavior.noUsage ? {} : {
      usage: {
        inputTokens: behavior.inputTokens ?? 100,
        outputTokens,
      },
    }),
    ...(overBudget ? { finishReason: 'max_tokens' as const } : behavior.stopReason ? { finishReason: behavior.stopReason } : {}),
    ...(behavior.refusalText ? { blockReason: 'refusal' } : {}),
    ...(behavior.structuredMode && req.jsonSchema !== undefined
      ? { structuredMode: behavior.structuredMode === 'native' ? 'json_schema' as const : 'prompt' as const }
      : {}),
  };
}

/**
 * ADR 0889 D6 — the tool-calling twin of `dispatchMock`. Consumes the next
 * program entry for `nodeId` and returns the shared `ToolsRoundResult` shape:
 * the entry's `toolCalls` as `toolUses` (ids are deterministic per program
 * cursor, so a fork replays identical ids), or a final text round. An exhausted
 * program ends the loop with an empty completion — a misaligned test surfaces
 * as "expected N rounds, got N+1", never a hang.
 */
export async function dispatchMockToolsRound(req: {
  nodeId?: string;
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  maxTokens?: number;
}): Promise<ToolsRoundResult> {
  const nodeId = req.nodeId ?? '';
  const state = programs.get(nodeId);
  if (state) {
    state.lastReceivedMaxTokens = req.maxTokens ?? null;
    state.receivedMaxTokens.push(req.maxTokens ?? null);
    state.lastReceivedMessages = req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  }
  const at = state?.cursor ?? 0;
  const behavior: MockBehavior =
    state !== undefined && state.cursor < state.program.length
      ? state.program[state.cursor++]!
      : {};
  if (behavior.errorCode) {
    throw Object.assign(new Error(`mock programmed failure (${behavior.errorCode})`), { code: behavior.errorCode });
  }
  const calls = behavior.toolCalls ?? [];
  return {
    text: behavior.content ?? '',
    toolUses: calls.map((c, i) => ({ id: `mock-call-${at}-${i}`, name: c.name, input: { ...(c.input ?? {}) } })),
    finishReason: calls.length > 0 ? 'tool_use' : (behavior.stopReason ?? 'end_turn'),
    inputTokens: behavior.inputTokens ?? 100,
    outputTokens: behavior.outputTokens ?? 50,
  };
}
