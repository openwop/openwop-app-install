/**
 * Conversation-run chat transport (RFC 0005) — the flag-gated cutover layer.
 *
 * Swaps the chat's per-turn `openwop-app.chat.turn` runs for ONE long-lived
 * conversation run: open on the first message, `exchange` per message (the gate
 * stays suspended), close on "New chat". The thread is rebuilt from the run's
 * `conversation.exchanged` events (wire-native attribution) — no client-side
 * persona labeling. Because `exchange` is synchronous (returns after the agent
 * reply is emitted), v1 needs no streaming: send → await exchange → refetch the
 * run's events → reconstruct.
 *
 * This is the SOLE chat transport (ADR 0067 §Phase 6): the per-turn
 * `openwop-app.chat.turn` fallback + its `conversationChatEnabled()` opt-out were
 * retired once the exchange path had provider parity (managed/BYOK/mock), idempotent
 * exchanges, event tailing, and clean telemetry. The backend per-turn workflow is
 * kept only so historical per-turn runs still replay/fork (the wire contract).
 */

import { pollEvents, getRun } from '../client/runsClient.js';
import { listOpenInterrupts } from '../client/interruptsClient.js';
import {
  openConversation,
  exchange,
  closeConversation,
  reconstructConversation,
  type ConversationTurn,
  type RunEvent,
  type ExchangeNotice,
} from './conversationClient.js';
import type { ContentPart } from './types.js';
import type { WorkflowRunState } from './types.js';

/** The synthesized host workflow holding a single `core.conversationGate`. */
export const CONVERSATION_WORKFLOW_ID = 'openwop-app.conversation';
/** The gate node id in that workflow (see host/index.ts synth). */
export const CONVERSATION_GATE_NODE_ID = 'gate';

/** A minimal chat bubble shape the hook adapts into its ChatMessage state.
 *  `content` may be a multimodal ContentPart[] (a voice-clip/attachment turn) —
 *  MessageRenderer renders text/audio/image/file parts natively. */
export interface ConversationBubble {
  id: string;
  role: 'user' | 'assistant' | 'workflow_run';
  content: string | ContentPart[];
  /** Producing agent persona/id for an assistant turn (wire-sourced). */
  agentPersona?: string;
  /** Set on a `workflow_run` bubble: the run an agent TOOL ignited during this
   *  turn (backend `host/turnRunDispatch.ts`). The caller turns it into a
   *  run-backed `workflow_run` message and re-attaches the live stream. */
  runRef?: { runId: string; agentId?: string; workflowId?: string; workflowName?: string };
  /** ADR 0665 D4 — this advisor produced nothing. The bubble renders the
   *  attribution and a muted "did not respond" line instead of empty prose, so a
   *  silent advisor is not read as an agreeing one. */
  noContribution?: true;
}

/** Light validation of the dispatch ContentPart[] shape on OPAQUE wire turn
 *  content, so a multimodal turn renders its real parts (audio player, image)
 *  instead of being JSON-stringified into the bubble — the "wall of base64"
 *  defect. Malformed arrays fall through to the text projection. */
function isContentParts(v: unknown): v is ContentPart[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((p) => {
    if (!p || typeof p !== 'object') return false;
    const t = (p as { type?: unknown }).type;
    if (t === 'text') return typeof (p as { text?: unknown }).text === 'string';
    if (t === 'audio') {
      const q = p as { mimeType?: unknown; dataBase64?: unknown };
      return typeof q.mimeType === 'string' && typeof q.dataBase64 === 'string';
    }
    if (t === 'image' || t === 'file') {
      const q = p as { mimeType?: unknown; dataBase64?: unknown; url?: unknown };
      return typeof q.mimeType === 'string' && (typeof q.dataBase64 === 'string' || typeof q.url === 'string');
    }
    return false;
  });
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** ADR 0665 D4 — a turn the backend typed as a non-contribution
 *  (`host/exchange/contentParts.ts`). Detected like `runReference` below: without
 *  a projection the object falls through to `asText` and renders as raw JSON. */
function isNoContribution(content: unknown): boolean {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  return (content as { kind?: unknown }).kind === 'no_contribution';
}

/** A turn whose content REFERENCES a dispatched run rather than carrying prose:
 *  `{ kind: 'workflow_run', runId, agentId }`. Emitted by the exchange for runs
 *  an agent tool ignited mid-turn (`host/turnRunDispatch.ts`) and by the ADR 0089
 *  deep-investigation path. Without this projection the object fell through to
 *  the assistant branch and `asText` rendered it as RAW JSON in the feed — and,
 *  because only a `workflow_run` message carries run state, the Workflow-progress
 *  rail stayed empty while a real run executed. */
function runReference(content: unknown): { runId: string; agentId?: string; workflowId?: string; workflowName?: string } | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const c = content as { kind?: unknown; runId?: unknown; agentId?: unknown; workflowId?: unknown; workflowName?: unknown };
  if (c.kind !== 'workflow_run' || typeof c.runId !== 'string' || !c.runId) return null;
  return {
    runId: c.runId,
    ...(typeof c.agentId === 'string' && c.agentId ? { agentId: c.agentId } : {}),
    // Optional: older turns (and the ADR 0089 deep-investigation bubble) carry
    // neither, so the caller supplies a translated fallback rather than rendering
    // a blank header and a bare `/` slug.
    ...(typeof c.workflowId === 'string' && c.workflowId ? { workflowId: c.workflowId } : {}),
    ...(typeof c.workflowName === 'string' && c.workflowName ? { workflowName: c.workflowName } : {}),
  };
}

/**
 * Seed the run state for a bubble that REFERENCES a dispatched run.
 *
 * Pure + exported so the naming fallback is directly testable: it lives on the
 * path a user hits when an agent tool ignites a run mid-turn, and a regression
 * here reads as a blank-titled bubble frozen at "running" — the exact symptom
 * ADR 0491 removed.
 *
 * `totalNodes: 0` is deliberate: the node count is unknown until the event log is
 * reconciled, and both consumers render a designed indeterminate state for 0
 * rather than a misleading 0%. `slug` stays empty because there is no `/slug`
 * mention behind a tool-dispatched run.
 */
export function seedRunState(
  runRef: { runId: string; workflowId?: string; workflowName?: string },
  genericLabel: string,
  startedAt: string,
  /** Optional localized name for `runRef.workflowId`. The backend supplies an
   *  English display default (a tool scope carries no locale), so when the client
   *  HAS a translation for this workflow it wins — otherwise the backend's name,
   *  then the id, then the generic label. Never blank at any step. */
  localizedName?: string,
): WorkflowRunState {
  const workflowName = localizedName || runRef.workflowName || runRef.workflowId || genericLabel;
  return {
    slug: '',
    workflowName,
    workflowId: runRef.workflowId ?? '',
    runId: runRef.runId,
    status: 'running',
    totalNodes: 0,
    completedNodeIds: [],
    failedNodeIds: [],
    nodeOutputs: {},
    currentNodeName: null,
    nodeNames: {},
    startedAt,
  };
}

/** Map reconstructed turns → chat bubbles. System turns (open/close markers)
 *  are dropped; `agent` turns become assistant bubbles carrying the wire
 *  attribution (`agent.agentId` ?? `from`), EXCEPT a `workflow_run` reference,
 *  which becomes a run-backed bubble. Pure — unit-tested. */
export function turnsToBubbles(turns: readonly ConversationTurn[]): ConversationBubble[] {
  const out: ConversationBubble[] = [];
  // Multimodal turns keep their REAL parts (audio player / image); everything
  // else projects to text as before.
  const contentOf = (c: unknown): string | ContentPart[] => (isContentParts(c) ? c : asText(c));
  for (const t of turns) {
    if (t.role === 'system') continue;
    if (t.role === 'user') {
      out.push({ id: t.messageId, role: 'user', content: contentOf(t.content) });
    } else {
      const persona = t.agent?.agentId ?? t.from;
      const runRef = runReference(t.content);
      if (runRef) {
        out.push({
          id: t.messageId, role: 'workflow_run', content: '', runRef,
          ...(persona && persona !== 'assistant' ? { agentPersona: persona } : {}),
        });
        continue;
      }
      if (isNoContribution(t.content)) {
        out.push({
          id: t.messageId, role: 'assistant', content: '', noContribution: true,
          ...(persona && persona !== 'assistant' ? { agentPersona: persona } : {}),
        });
        continue;
      }
      out.push({ id: t.messageId, role: 'assistant', content: contentOf(t.content), ...(persona && persona !== 'assistant' ? { agentPersona: persona } : {}) });
    }
  }
  return out;
}

/** Project a debug-bundle event row (loose `Record`) into the typed RunEvent
 *  shape the reconstructor reads — no `as any`/double-cast. */
function toRunEvent(e: Record<string, unknown>): RunEvent {
  const payload = e.payload && typeof e.payload === 'object' ? (e.payload as RunEvent['payload']) : undefined;
  return {
    ...(typeof e.type === 'string' ? { type: e.type } : {}),
    ...(payload ? { payload } : {}),
  };
}

/** Turns reconstructed from events newer than a cursor, plus the new cursor. */
export interface ConversationFetch {
  /** Turns parsed from events with `sequence > sinceSeq` (the open turn + every
   *  exchanged/closed turn in that window). On a from-0 fetch this is the whole
   *  thread; on a tail fetch it is just the newly-appended turns. */
  turns: ConversationTurn[];
  /** Highest event sequence observed (≥ sinceSeq) — pass back as the next cursor. */
  lastSeq: number;
}

/**
 * Fetch conversation turns from the run's event log, tailing from `sinceSeq`
 * (ADR 0067 §Phase 4). Uses the UNGATED core event-poll (`GET /v1/runs/{id}/events`),
 * NOT the capability-gated debug-bundle. Passing the last-seen sequence avoids
 * rescanning the whole log from seq 0 on every refresh; the caller folds the
 * returned turns into its accumulated thread.
 */
export async function fetchTurns(runId: string, sinceSeq = 0): Promise<ConversationFetch> {
  const polled = await pollEvents(runId, sinceSeq);
  let lastSeq = sinceSeq;
  const events = polled.events.map((e) => {
    if (typeof e.sequence === 'number' && e.sequence > lastSeq) lastSeq = e.sequence;
    return toRunEvent({ type: e.type, payload: e.payload });
  });
  return { turns: reconstructConversation(events), lastSeq };
}

/** Provider selection carried into the conversation run (mirrors the per-turn
 *  chat's createRun inputs) so the exchange handler dispatches replies with the
 *  same provider/model/credential. */
export interface ConversationProviderConfig {
  provider?: string;
  model?: string;
  credentialRef?: string;
  tenantId?: string;
  /** Enable the provider's NATIVE web search/grounding for this conversation,
   *  using the selected BYOK provider key (ADR 0101). Captured at open time. */
  webSearch?: boolean;
  /** The chat sessionId, carried into the run's metadata so the exchange handler
   *  can resolve the conversation's ConversationMeta (owner-subject knowledge +
   *  a board's injected strategy context are keyed by the chat sessionId). */
  chatSessionId?: string;
}

/** How long to wait for the conversation gate to suspend before giving up. */
const GATE_OPEN_TIMEOUT_MS = 10_000;

/**
 * Wait until the conversation gate has actually suspended (its interrupt is
 * open) before the caller sends the first turn.
 *
 * `POST /v1/runs` dispatches the run in the BACKGROUND and returns the runId
 * before the gate node executes (`host/runDispatch.ts` → `dispatchRunInBackground`),
 * so an `exchange` fired immediately after open races the suspend and the
 * resolve route 404s with `interrupt_not_found: no open interrupt for this node`.
 * Poll the run's open interrupts until the gate appears; fail fast (with a
 * readable message) if the run terminates before suspending. Only the FIRST
 * turn needs this — the gate stays suspended across exchanges, so later turns
 * never race.
 */
async function waitForGateOpen(runId: string, nodeId: string): Promise<void> {
  const deadline = Date.now() + GATE_OPEN_TIMEOUT_MS;
  let delay = 60;
  let polls = 0;
  for (;;) {
    const open = await listOpenInterrupts(runId).catch(() => []);
    if (open.some((i) => i.nodeId === nodeId)) return;
    // Every few polls, confirm the run didn't error/complete before suspending
    // (don't fetch the run every iteration — keep the read fan-out bounded).
    if (++polls % 4 === 0) {
      const run = await getRun(runId).catch(() => null);
      if (run && ['failed', 'completed', 'cancelled'].includes(run.status)) {
        throw new Error(`The conversation could not start (run ${run.status}).`);
      }
    }
    if (Date.now() >= deadline) {
      // Include the run's last-seen status: a run stuck `pending` means the
      // backend dispatch never executed the gate (a server-side failure —
      // since the fail-closed dispatch fix those mark the run `failed` fast,
      // so a lingering `pending` here points at a dispatch backlog), while
      // `running` means it is just slow. Diagnosable beats blind.
      // Track-3 i18n — CODED errors: useChatSession lifts `.code` into
      // `meta.error.code`, and `classifyChatError` (the one classifier owner)
      // renders the localized title/body; the message stays the English
      // diagnostic fallback for logs + unknown-code rendering.
      const last = await getRun(runId).catch(() => null);
      const stuckPending = last?.status === 'pending';
      const err = new Error(
        stuckPending
          ? 'The conversation run never started (still pending after 10s) — the server could not dispatch it. Check the server logs and try again.'
          : 'Timed out waiting for the conversation to start. Please try again.',
      ) as Error & { code?: string };
      err.code = stuckPending ? 'conversation_start_timeout' : 'conversation_gate_timeout';
      throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), 400);
  }
}

/**
 * ADR 0079 §Phase 2 — extract a streamable token delta from a run event for the
 * conversation's optimistic bubble. The run SSE replays from sequence 0 on
 * connect, so a delta is only "live" for THIS exchange when its `sequence`
 * exceeds the cursor captured at subscribe time (`startSeq`); older
 * `output.chunk` events belong to prior turns and must not re-type. Returns
 * the chunk text, or null for a non-chunk / replayed / malformed event. Pure +
 * unit-tested — the bug-prone replay-guard lives here, not inline.
 */
/**
 * ADR 0688 — the persisted type is `output.chunk`, the codemap name RFC 0094 §D
 * single-sources to the `outputChunk` payload. `ai.message.chunk` is the SSE
 * FRAME name for the same payload, never the persisted type; this host had been
 * persisting the frame name, and ADR 0682 then made that a vendor name.
 *
 * The other two are DEPLOY-SKEW tolerance, not history. Backend and frontend
 * ship as separate deploys, so there is a window each way where the running
 * backend emits one spelling and the loaded SPA expects the other — and what is
 * lost in that window is a live reply's streaming bubble, the one thing a user
 * watches. They cost a set lookup.
 *
 * Note this matcher never sees old rows regardless: the `sequence <= startSeq`
 * guard below drops everything replayed, so these entries earn their place from
 * the skew window alone and can be deleted once one full deploy has settled.
 */
const STREAM_DELTA_TYPES: ReadonlySet<string> = new Set([
  'output.chunk',
  'openwop-app.ai.message-chunk',
  'ai.message.chunk',
]);

export function streamDeltaFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): string | null {
  if (!STREAM_DELTA_TYPES.has(ev.type ?? '')) return null;
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const chunk = (ev.payload as { chunk?: unknown } | undefined)?.chunk;
  return typeof chunk === 'string' ? chunk : null;
}

/**
 * ADR 0079 §Phase 3 — classify a run event as the async-exchange SETTLE signal.
 * Under the async flag the `exchange` POST acks BEFORE the reply is emitted, so
 * the client streams `output.chunk` deltas into its optimistic bubble and
 * waits for one of two terminal events (newer than the subscribe cursor) to
 * reconcile: the agent's authoritative `conversation.exchanged` turn (`'agent'`),
 * or a terminal `openwop-app.ai.message-error` (`'error'`). Returns null for anything else
 * (deltas, the user-turn echo, replayed/older events). Pure + unit-tested.
 */
export function exchangeSettleSignal(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): 'agent' | 'error' | null {
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  if (ev.type === 'openwop-app.ai.message-error') return 'error';
  if (ev.type === 'conversation.exchanged') {
    const role = (ev.payload as { turn?: { role?: unknown } } | undefined)?.turn?.role;
    if (role === 'agent') return 'agent';
  }
  return null;
}

/**
 * ADR 0151 — extract an auto-generated conversation title from a `openwop-app.conversation.titled`
 * host event. Emitted once, on the first exchange, by the chat-autotitle binding; the
 * rail/tab swaps the substring placeholder for this live. Replay-guarded on `startSeq`
 * like the delta mapper (an older title belongs to a prior fold). Pure + unit-tested.
 * Returns null for any non-title / replayed / malformed event.
 */
export function titledFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): string | null {
  if (ev.type !== 'openwop-app.conversation.titled') return null;
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const title = (ev.payload as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

/**
 * RCL-UX-2 / RCL-7 — the composition's degradation ledger for THIS exchange.
 * The backend has durably appended `openwop-app.conversation.context-degraded`
 * since WF-BOA-4 and no frontend surface ever read it — a text-chat recall (or
 * persona/board/knowledge) failure informed the MODEL and never the human.
 * Returns the block names (mapped to localized labels via `voiceCtxBlockLabels`),
 * or null for a non-degradation / replayed / malformed event.
 */
export function contextDegradedFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): string[] | null {
  if (ev.type !== 'openwop-app.conversation.context-degraded') return null;
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const degraded = (ev.payload as { degraded?: unknown } | undefined)?.degraded;
  if (!Array.isArray(degraded)) return null;
  const blocks = degraded.filter((b): b is string => typeof b === 'string' && b.length > 0);
  return blocks.length > 0 ? blocks : null;
}

/**
 * RCL-UX-1 — did THIS exchange's composition draw on twin borrowed recall?
 * The backend emits `openwop-app.conversation.recall-used` (best-effort) when
 * owner-corpus chunks were actually composed; the send path uses it to stamp
 * the settled assistant message's `meta.twinRecalled`. Replay-guarded on
 * `startSeq` like every event mapper here (older events belong to prior turns).
 */
export function recallUsedFromEvent(
  ev: { type?: string; sequence?: number },
  startSeq: number,
): boolean {
  if (ev.type !== 'openwop-app.conversation.recall-used') return false;
  return typeof ev.sequence === 'number' && ev.sequence > startSeq;
}

/** The async-exchange error payload (best-effort fields off `openwop-app.ai.message-error`). */
export function exchangeErrorPayload(ev: { payload?: unknown }): { code?: string; message?: string } {
  const p = ev.payload as { code?: unknown; message?: unknown } | undefined;
  return {
    ...(typeof p?.code === 'string' ? { code: p.code } : {}),
    ...(typeof p?.message === 'string' ? { message: p.message } : {}),
  };
}

/** One step of a tool-bearing agent's live progress (ADR 0089 Phase 2). */
export interface ToolActivity {
  kind: 'reasoned' | 'tool-called' | 'tool-returned';
  /** Correlates a `tool-returned` to its `tool-called` card. */
  callId?: string;
  /** The tool id, for `tool-called` / `tool-returned`. */
  toolName?: string;
  /** `ok` | `error` | `forbidden` | `rate_limited`, for `tool-returned`. */
  status?: string;
  /** RFC 0064 §E — the populated failure discriminator on a non-success return
   *  (`agent.toolReturned.error`). Present for execution/validation/capability
   *  failures; ABSENT for the `forbidden`/`rate_limited` gate statuses (which
   *  carry `status` only). Carries the machine `code` + an SR-1-redacted
   *  `message` so the card can show the real reason, not a bare `status`. */
  error?: { code: string; message?: string };
  /** The agent that ran the tool (attribution on the card). */
  agentId?: string;
}

/**
 * Classify a run event as one step of the agent's tool loop (RFC 0064
 * `agent.reasoned` / `agent.toolCalled` / `agent.toolReturned`), so the chat can
 * render live progress ("🔍 used web search…") while a tool-bearing agent works,
 * instead of a silent wait. Replay-guarded on `startSeq` like the delta mapper
 * (older events belong to prior turns). Pure + unit-tested. Returns null for any
 * non-tool / replayed / malformed event.
 */
export function toolActivityFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): ToolActivity | null {
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as { toolName?: unknown; status?: unknown; callId?: unknown; agentId?: unknown; error?: unknown };
  const toolName = typeof p.toolName === 'string' ? p.toolName : undefined;
  const callId = typeof p.callId === 'string' ? p.callId : undefined;
  const agentId = typeof p.agentId === 'string' ? p.agentId : undefined;
  // RFC 0064 §E — carry the populated `error` discriminator through to the card.
  const rawErr = p.error && typeof p.error === 'object' ? p.error as { code?: unknown; message?: unknown } : undefined;
  const error = rawErr && typeof rawErr.code === 'string'
    ? { code: rawErr.code, ...(typeof rawErr.message === 'string' ? { message: rawErr.message } : {}) }
    : undefined;
  switch (ev.type) {
    case 'agent.reasoned':
      return { kind: 'reasoned', ...(agentId ? { agentId } : {}) };
    case 'agent.toolCalled':
      return { kind: 'tool-called', ...(callId ? { callId } : {}), ...(toolName ? { toolName } : {}), ...(agentId ? { agentId } : {}) };
    case 'agent.toolReturned':
      return { kind: 'tool-returned', ...(callId ? { callId } : {}), ...(toolName ? { toolName } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}), ...(error ? { error } : {}), ...(agentId ? { agentId } : {}) };
    default:
      return null;
  }
}

/** Open a conversation run for a chat session, carrying the provider config.
 *  Resolves only once the gate is suspended, so the caller's first `exchange`
 *  can't race the background dispatch (see `waitForGateOpen`). */
export async function openConversationSession(cfg: ConversationProviderConfig = {}): Promise<{ runId: string; nodeId: string }> {
  const inputs: Record<string, unknown> = {};
  if (cfg.provider) inputs.provider = cfg.provider;
  if (cfg.model) inputs.model = cfg.model;
  if (cfg.credentialRef) inputs.credentialRef = cfg.credentialRef;
  if (cfg.webSearch) inputs.webSearch = true;
  const { runId } = await openConversation({
    workflowId: CONVERSATION_WORKFLOW_ID,
    inputs,
    ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}),
    ...(cfg.chatSessionId ? { metadata: { chatSessionId: cfg.chatSessionId } } : {}),
  });
  await waitForGateOpen(runId, CONVERSATION_GATE_NODE_ID);
  return { runId, nodeId: CONVERSATION_GATE_NODE_ID };
}

/** Result of one exchange: the turns appended since `sinceSeq` and the new cursor. */
export interface SendResult {
  turns: ConversationTurn[];
  lastSeq: number;
  /** ADR 0173 — a non-blocking soft-warning the exchange ack carried (the org is
   *  approaching its BYOK daily spend cap). Absent on a normal turn. */
  notice?: ExchangeNotice;
}

/** Send one user turn to `to` (the @mention agentId) and return the turns
 *  appended since `sinceSeq` plus the new cursor (ADR 0067 §Phase 2/4). The
 *  `exchangeKey` makes the POST idempotent: a retried send returns the existing
 *  turns instead of duplicating them. The caller folds the returned turns into
 *  its accumulated thread (tailing — no full re-poll). */
export async function sendConversationTurn(
  runId: string,
  nodeId: string,
  // `content` may be a multimodal ContentPart[] (attachment turns) — turn content is
  // opaque on the RFC 0005 wire; the exchange client already posts it verbatim.
  input: { content: string | readonly ContentPart[]; to?: string; exchangeKey?: string; webSearch?: boolean; model?: string; provider?: string },
  sinceSeq = 0,
): Promise<SendResult> {
  const { notice } = await exchange(runId, nodeId, input);
  const fetched = await fetchTurns(runId, sinceSeq);
  return { ...fetched, ...(notice ? { notice } : {}) };
}

/** Close the conversation (resumes + completes the run). Best-effort. */
export async function closeConversationSession(runId: string, nodeId: string): Promise<void> {
  try {
    await closeConversation(runId, nodeId);
  } catch {
    /* a stale/closed run is fine to ignore on session reset */
  }
}
