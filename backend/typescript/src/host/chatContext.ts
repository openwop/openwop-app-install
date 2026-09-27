/**
 * Chat context composition (ADR 0199 Phase 1) — the ONE owner of "what does an
 * agent know at the start of a model call", extracted verbatim from the
 * conversation exchange's inlined block so the realtime-voice session mint can
 * compose the SAME brain instead of a hardcoded placeholder.
 *
 * Consumers:
 *   - `handleConversationResolve` (host/conversationExchange.ts) — the text
 *     chat turn (behavior-identical to the pre-extraction inline block);
 *   - the realtime voice routes (features/voice/realtime/routes.ts) — session
 *     instructions = this scaffold + the spoken-mode addendum + the budgeted
 *     transcript digest below.
 *
 * Deliberately free of run/executor imports: every input is a primitive, so
 * the exchange passes run-derived values and the realtime route passes
 * request-derived ones through the same seam.
 */
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { resolveAgentIdentity, type AgentIdentity } from './agentIdentity.js';
import { composeAgentSystemPrompt, firstNameOf } from './agentPromptScaffold.js';
import { getConversationMeta, type ConversationMeta } from './conversationStore.js';
import { composeKnowledgeForSubject, resolveAgentKnowledgeRetrieve, composeAgentKnowledgeContext, composeBorrowedRecallContext } from './agentKnowledgeComposition.js';
import { getBorrowedRecallResolver } from './twinRecallSurface.js';
import { createAgentMemoryPort } from './agentMemoryAdapter.js';
import { resolveSubjectAccess } from './subjectAccess.js';
import { resolveBoardContextResult, resolveBoardConveneRefusal } from './boardContextResolver.js';
import { getUser } from '../features/users/usersService.js';
import { getProfile } from '../features/profiles/profilesService.js';
import { loadTurns } from './exchange/loadTurns.js';
import { transcriptBudgetConfig, windowTranscript } from './transcriptBudget.js';
import type { ConversationTurn } from './conversation.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { agentVisibleToTenant } from './agentVisibility.js';

const logger = createLogger('host.chatContext');

/** ADR 0084 — owner-subject KB grounding depth (mirrors agent dispatch). */
export const OWNER_KNOWLEDGE_TOP_K = 6;

/** The generic fallback when no (tenant-visible) agent persona resolves. */
export const GENERIC_CHAT_SCAFFOLD = 'You are a helpful AI assistant in a shared chat. Reply concisely.';

/** GRADE-16 — once-per-window dedup for the persona-miss warn (a stale agent
 *  scope would otherwise warn on every turn of that conversation forever).
 *  Small bounded map; entries expire by timestamp and the map is swept on use. */
const PERSONA_WARN_WINDOW_MS = 10 * 60_000;
const personaWarnAt = new Map<string, number>();
function shouldWarnPersonaMiss(key: string): boolean {
  const nowTs = Date.now();
  if (personaWarnAt.size > 500) {
    for (const [k, at] of personaWarnAt) if (nowTs - at >= PERSONA_WARN_WINDOW_MS) personaWarnAt.delete(k);
  }
  const last = personaWarnAt.get(key);
  if (last !== undefined && nowTs - last < PERSONA_WARN_WINDOW_MS) return false;
  personaWarnAt.set(key, nowTs);
  return true;
}

export interface ComposeChatContextInput {
  /** The addressed agent (a registry id). Absent ⇒ the generic scaffold. */
  agentId?: string | undefined;
  /** The CHAT sessionId (ConversationMeta key). Absent ⇒ no meta-bound blocks. */
  conversationId?: string | undefined;
  /** The acting human's User.userId — for the scaffold's identity anchor AND
   *  the owner-subject IDOR guard. */
  callerUserId?: string | undefined;
  /** Seed text for knowledge retrieval (the user's turn text; for a voice
   *  session, the recent transcript or the agent's role). */
  seedText?: string | undefined;
  /** WF-RCL-4 / RCL-3(b) — the BACKING RUN of this composition (the exchange
   *  passes `interrupt.runId`; the voice mint has none). Threaded into the
   *  borrowed-recall resolver ctx so the ADR 0044 §5 consent audit row can name
   *  the run — the chat lane was structurally unable to supply it before this
   *  field existed. Additive; no other leg reads it. */
  runId?: string | undefined;
  /** PR #3409 review F1 — the PER-DISPATCH identity within `runId`, for the
   *  consent-ledger replay guard. A conversation is ONE run resolved per TURN,
   *  so the exchange passes `turn:<turnIndex>` (stable across a retried
   *  exchange, distinct per genuine turn); without it the guard deduped turns
   *  2..n away and the ledger undercounted on the primary lane. Voice omits it
   *  (it also has no runId). No other leg reads it. */
  dispatchId?: string | undefined;
}

export interface ComposedChatContext {
  systemPrompt: string;
  /** The resolved agent manifest (null when none addressed / not found). The
   *  exchange consumes the full object downstream (tool-loop eligibility). */
  agent: ResolvedAgentManifest | null;
  /** Whether the resolved agent is visible to this tenant (fail-closed check). */
  tenantOk: boolean;
  /** The conversation meta, returned so the exchange's roster enforcement
   *  doesn't re-fetch (single read per turn). */
  meta: ConversationMeta | null;
  /** ADR 0277 OQ-1 — block NAMES that failed to compose (mirrors the
   *  context_degraded log sites; never reasons/content). Callers may surface
   *  them (the realtime mint responses do). Caller-neutral only: authz-denied
   *  paths compose silently and are NEVER reported here. */
  degraded: string[];
  /** ADR 0373 — the rosterId↔agentId identity this compose ALREADY resolved
   *  (`profileId` is the agentProfile key: the rosterId for a standing agent,
   *  else the definition-level agentId). Returned rather than discarded so a
   *  per-turn consumer (the deep-investigation capability read) reuses this
   *  resolution instead of paying a SECOND reverse roster scan — which
   *  `agentIdentity.ts` explicitly warns hot paths must not request. Null when
   *  no agent is addressed. */
  identity: AgentIdentity | null;
  /** RCL-UX-1 — at least one chunk of a granted twin OWNER's corpus was
   *  actually composed into this scaffold. The exchange uses it to mark the
   *  turn as memory-shaped for the acting caller (post-ADR 0589 §D2 the caller
   *  IS the owner, so surfacing it is first-party disclosure). False when the
   *  borrowed leg composed nothing or only a degradation notice. */
  borrowedRecalled: boolean;
  /**
   * H1 / ADR 0588 D5 — non-null when this conversation is bound to a board that
   * may NOT convene (the likeness acknowledgement is absent). The value is the
   * user-facing refusal message. Callers MUST refuse the turn / the session mint
   * rather than composing this scaffold: a `living` board with no acknowledgement
   * is not allowed to speak, and every OTHER field returned here is composed as
   * if it were.
   *
   * Reported rather than THROWN because the exchange has already claimed its
   * idempotency key by this point and must release it before refusing (a thrown
   * compose would strand that claim as `in_progress` and 409 every retry). It is
   * also NOT a `degraded` entry: a refusal is not a degradation, and the ledger's
   * consumers turn entries into "answer anyway, but say what's missing".
   */
  conveneRefusal: string | null;
}

/** The acting human's display name — tenant-scoped, fail-soft. (Moved here from
 *  the exchange so the identity anchor has one owner.) */
export async function resolveCallerDisplayName(tenantId: string, userId: string | undefined): Promise<string | null> {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  try {
    const user = await getUser(userId);
    if (!user || (user.tenantId && user.tenantId !== tenantId)) return null;
    const name = user.displayName?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** ADR 0320 — what agents should CALL the caller: their profile `preferredName`
 *  when set, else null (the scaffold then addresses them by the first token of
 *  their display name). Tenant-scoped, fail-soft — a missing/absent profile just
 *  yields the first-name default, never an error. */
export async function resolveCallerAddressName(tenantId: string, userId: string | undefined): Promise<string | null> {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  try {
    const profile = await getProfile(tenantId, userId);
    const preferred = profile?.preferredName?.trim();
    return preferred && preferred.length > 0 ? preferred : null;
  } catch {
    return null;
  }
}

/**
 * Compose the agent's system scaffold for a chat-shaped model call: registry
 * persona + authored systemPrompt (tenant-checked), the caller's display name,
 * the conversation's injected context block (boardroom strategy), and the
 * owner-subject knowledge grounding (IDOR-guarded, fail-soft).
 */
export async function composeChatContext(tenantId: string, input: ComposeChatContextInput): Promise<ComposedChatContext> {
  const { agentId, conversationId, callerUserId, seedText, runId, dispatchId } = input;
  const degraded: string[] = [];
  // H1 — set by the board leg below when this conversation's board may not
  // convene. Not a `degraded` entry: it is a REFUSAL, not a partial grounding.
  let conveneRefusal: string | null = null;
  // RCL-UX-1 — set by the borrowed-recall leg when owner-corpus chunks were
  // actually composed (not on an empty or purely-degraded compose).
  let borrowedRecalled = false;

  // ADR 0277 — normalize the id FIRST. A voice session scoped via the roster
  // picker carries a `host:*` rosterId; the registry only knows the persona's
  // `agentRef.agentId` projection, so resolving the raw id missed → the WHOLE
  // scaffold collapsed to the generic fallback (persona, board context, owner
  // KB, and the caller's NAME all silently dropped). Forward-only here: a
  // `host:*` id is one point-get; every other id passes through untouched, so
  // the text hot path pays a startsWith check.
  // Reverse scan enabled since ADR 0277 P2: the per-agent knowledge fold-in
  // below needs the PROFILE id for registry-form ids too; the resolver's
  // per-tenant TTL cache keeps the per-turn cost to one scan per ~30s.
  const identity = agentId ? await resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true }) : null;
  const agent = identity ? await getAgentRegistry().resolve(identity.agentId, tenantId) : null;
  const tenantOk = !agent || agentVisibleToTenant(agent, tenantId); // the ONE rule (ADR 0379)
  const [userName, addressName] = await Promise.all([
    resolveCallerDisplayName(tenantId, callerUserId),
    resolveCallerAddressName(tenantId, callerUserId),
  ]);
  if (agentId && (!agent || !agent.systemPrompt || !tenantOk)) {
    // ADR 0277 — the persona miss was previously invisible ("context_degraded"):
    // the session still opened, just dumber. Name the drop so it is diagnosable.
    // GRADE-16 — deduped: a conversation addressed to a deleted/renamed agent
    // hits this on EVERY turn for the life of the thread; warn once per
    // (agent, conversation) per window instead of streaming.
    const dedupKey = `${agentId}|${conversationId ?? ''}`;
    if (shouldWarnPersonaMiss(dedupKey)) {
      logger.warn('context_degraded', { block: 'persona', agentId, resolvedAgentId: identity?.agentId, reason: !agent ? 'registry_miss' : !tenantOk ? 'tenant_mismatch' : 'no_system_prompt' });
    }
    degraded.push('persona');
  }

  const convMeta = conversationId
    ? await getConversationMeta(tenantId, conversationId).catch(() => null)
    : null;

  // The two knowledge retrievals are INDEPENDENT (owner-subject grounding vs the
  // agent's own binding) — run them concurrently: each is a KB retrieval on the
  // per-turn hot path, and serializing them doubled the worst-case latency.
  const seed = (seedText ?? '').trim();
  const [knowledgeBlock, agentKnowledgeBlock, borrowedRecallBlock, boardContextBlock] = await Promise.all([
    // ADR 0084 Phase 2 — owner-subject KB grounding with the IDOR guard: resolve
    // the CALLER's access to a membership-scoped subject before composing; 'none'
    // composes nothing (no leak). Best-effort — a failure never breaks the turn.
    (async (): Promise<string> => {
      if (!convMeta?.ownerSubject) return '';
      try {
        const access = await resolveSubjectAccess(tenantId, convMeta.ownerSubject, callerUserId);
        if (access === 'none') return '';
        return await composeKnowledgeForSubject(tenantId, convMeta.ownerSubject, seedText ?? '', { topK: OWNER_KNOWLEDGE_TOP_K });
      } catch (err) {
        logger.warn('owner_knowledge_compose_failed', { conversationId, error: err instanceof Error ? err.message : String(err) });
        degraded.push('owner_knowledge');
        return '';
      }
    })(),
    // ADR 0277 P2 — the per-agent knowledge binding (ADR 0038: bound KBs + the
    // agent's memory namespace; this is what the advisory-board "Shared knowledge"
    // grant writes). Until now only the workflow `chat.turn` node composed it
    // (ADR 0043 Phase 5B) — the interactive exchange and voice never retrieved
    // it, so the grant was stored + displayed but inert in the ONE chat. Seeded
    // like the node path: no seed text (multimodal-only turn) ⇒ skip retrieval.
    // Fail-soft + fail-closed on capability: `resolveAgentKnowledgeRetrieve`
    // returns undefined for agents without the `knowledge` capability.
    (async (): Promise<string> => {
      if (!(agent && agent.systemPrompt && tenantOk && identity && seed)) return '';
      try {
        // ADR 0442 P3 — pass the ACTING participant so a `per-user` agent (e.g.
        // KickBot) recalls THIS caller's own `user:<id>` memory, never another
        // participant's, in a shared cohort tenant (F1). A default-scope agent
        // ignores `actor` and reads `agent:<profileId>` exactly as before.
        const retrieve = await resolveAgentKnowledgeRetrieve(
          tenantId, identity.profileId, createAgentMemoryPort(tenantId), { userId: callerUserId },
        );
        return retrieve ? await composeAgentKnowledgeContext(retrieve, seed) : '';
      } catch (err) {
        logger.warn('context_degraded', { block: 'agent_knowledge', agentId, reason: err instanceof Error ? err.message : String(err) });
        degraded.push('agent_knowledge');
        return '';
      }
    })(),
    // ADR 0044 Phase 2 — a granted TWIN recalling its OWNER's corpus, on the ONE
    // interactive composition owner (this covers text chat AND voice, which both
    // compose here). Previously the borrowed retriever was wired ONLY on the
    // ad-hoc agent-dispatch route (routes/agents.ts), so a twin never recalled its
    // owner's memory in real chat — contradicting ADR 0044's "chat, runs, and forks
    // alike". `getBorrowedRecallResolver()` is the LIVE authorization gate the
    // `twin` feature fills: it re-checks the toggle + link + active grant every
    // turn and returns `undefined` when any is absent (fail-closed), so a non-twin
    // / not-granted / toggle-off agent composes NOTHING here (unaffected). The
    // resolver keys on the ROSTER id (getTwinLink → getRosterEntry), which is
    // `identity.profileId`. Its output is STRUCTURALLY fenced by
    // `composeBorrowedRecallContext` — second-party personal data is always
    // cited-as-data. Live per-turn read (this scaffold is composed fresh per turn,
    // never frozen into the event log), so revocation takes effect immediately.
    (async (): Promise<string> => {
      if (!(agent && agent.systemPrompt && tenantOk && identity && seed)) return '';
      const resolver = getBorrowedRecallResolver();
      if (!resolver) return '';
      try {
        // ADR 0589 §D2 — pass the ACTING caller. Without it this leg had no
        // per-caller authorization at all, while the owner-KB leg 40 lines up in
        // the SAME `Promise.all` re-resolved the caller (`:200`). Absent ⇒ deny.
        // RCL-DEBT-2 — conditional spread like the other two lanes: the
        // deny-on-absent behavior must not hinge on one lane using a
        // truthiness-vs-key-presence convention the resolver happens to share.
        // WF-RCL-4 — `runId` rides along for the ADR 0044 §5 audit row.
        // F1 — `dispatchId` (`turn:<turnIndex>`) makes each TURN a distinct
        // consent-ledger dispatch; without it the durable replay guard
        // deduped every turn after the first (one conversation = one run).
        const source = await resolver(tenantId, identity.profileId, {
          ...(callerUserId ? { callerUserId } : {}),
          ...(runId ? { runId } : {}),
          ...(dispatchId ? { dispatchId } : {}),
        });
        if (!source) return '';
        // RCL-6 — the owner-naming preamble rides inside the fence.
        const comp = await composeBorrowedRecallContext(source.retrieve, seed, source.ownerName);
        if (comp.recalled) borrowedRecalled = true;
        // RCL-UX-2 — the PARTIAL failure now reaches the ledger too. It was
        // absorbed inside the composition (only a thrown leg pushed here), so
        // the model was told while every human surface structurally could not
        // be. Distinct value, board_context_partial precedent: "some of it is
        // missing" is a different thing to say than "none of it loaded".
        if (comp.failed) {
          logger.warn('context_degraded', { block: comp.recalled ? 'twin_borrowed_recall_partial' : 'twin_borrowed_recall', agentId, reason: 'borrowed_source_failed' });
          degraded.push(comp.recalled ? 'twin_borrowed_recall_partial' : 'twin_borrowed_recall');
        }
        return comp.block;
      } catch (err) {
        logger.warn('context_degraded', { block: 'twin_borrowed_recall', agentId, reason: err instanceof Error ? err.message : String(err) });
        degraded.push('twin_borrowed_recall');
        return '';
      }
    })(),
    // ADVB-1 (Blocker) — the board's planning-context block is RE-RESOLVED for
    // THIS caller on THIS turn. It is NEVER served from the persisted
    // `injectedContextBlock` snapshot.
    //
    // The boardroom is a SHARED conversation (ADR 0278 join semantics: any org
    // member with `workspace:read` opens the SAME canonical conversation), but
    // the snapshot is written by whichever `workspace:write` curator opened it.
    // Its sources are readability-scoped PER USER — a `scope:'user'` strategy is
    // creator-only, a `private` project is member-only — so replaying one
    // caller's render to every later reader grounded the advisors' answers, and
    // therefore their replies, in planning content the reader cannot see. Org
    // `workspace:write` is NOT the same predicate as `canSubjectReadStrategy` /
    // `resolveProjectAccess`; it misses precisely where they diverge.
    //
    // This is the shape of the owner-KB leg above: re-check the CALLER, compose
    // nothing when they have no access. The resolver RBAC-filters for whoever we
    // pass as convener, so passing `callerUserId` is the whole fix; it also
    // makes revocation take effect on the next turn rather than never.
    (async (): Promise<string> => {
      if (!convMeta?.boardId) return '';
      // H1 / ADR 0588 D5 — the likeness gate, HERE, on the turn path. The two
      // lanes that used to carry it (`POST …/boards/:id/chat` and the `@@`
      // attach) are both room-CREATION lanes, so a room opened BEFORE the
      // acknowledgement was un-fabricated kept composing turns normally. First,
      // before any grounding is assembled for a room that may not speak.
      conveneRefusal = await resolveBoardConveneRefusal(tenantId, convMeta.boardId);
      if (conveneRefusal) {
        logger.warn('board_convene_blocked', { boardId: convMeta.boardId, conversationId });
        return '';
      }
      const { block, failed, shortfall } = await resolveBoardContextResult(tenantId, convMeta.boardId, callerUserId);
      if (failed) {
        // WF-BOA-4 — an advisor about to speak attributed with its planning
        // grounding silently absent. Name it so callers can surface it.
        logger.warn('context_degraded', { block: 'board_context', boardId: convMeta.boardId, conversationId });
        degraded.push('board_context');
        return '';
      }
      if (shortfall > 0) {
        // M4 — the PARTIAL resolve, which is the commoner shape than the total
        // failure above: refs that were archived or deleted are dropped by the
        // resolvers and a SHORTER block comes back with `failed:false`. Distinct
        // ledger entry, because "some of it is missing" is a different thing to
        // say to the model than "none of it loaded". Authz-withheld refs are
        // excluded upstream — this ledger is caller-neutral by contract.
        logger.info('context_degraded', { block: 'board_context_partial', boardId: convMeta.boardId, conversationId, shortfall });
        degraded.push('board_context_partial');
      }
      return block ?? '';
    })(),
  ]);
  // The knowledge blocks are self-framed/fenced; concatenate those present, in a
  // fixed order: conversation-owner grounding first (it frames the room), the
  // agent's own corpus second, borrowed owner-corpus (fenced/untrusted) last.
  const combinedKnowledge = [knowledgeBlock, agentKnowledgeBlock, borrowedRecallBlock].filter((b) => b.length > 0).join('\n\n');

  // Temporal grounding (this session): the CHAT scaffold is composed fresh per
  // turn and never fed the replay-anchor hash (that's the workflow-node path in
  // bootstrap/nodes.ts), so a live current date is replay-safe here — and it
  // closes the "I'd need to know the current date" gap on relative-time asks
  // ("goals for next quarter"). One resolve at the ONE composition owner.
  const today = promptDateStamp();
  // ADVB-1 — `boardContextBlock` is the LIVE, caller-scoped resolve above.
  // `convMeta.injectedContextBlock` is a durable PROVENANCE record of the last
  // curator snapshot and is deliberately NOT read here; re-reading it is the
  // defect. `advisory-board-context-rbac.test.ts` is the tripwire.
  const injectedContextBlock = boardContextBlock || undefined;
  const scaffold = agent && agent.systemPrompt && tenantOk
    ? composeAgentSystemPrompt({ persona: agent.persona, role: agent.label, systemPrompt: agent.systemPrompt, userName, addressName, today, injectedContextBlock, ...(combinedKnowledge ? { knowledgeBlock: combinedKnowledge } : {}) })
    : composeGenericScaffold({ userName, addressName, today, injectedContextBlock, knowledgeBlock });
  // ADR 0308 D1 — every composed scaffold (agent-scoped AND generic; text AND
  // voice, which composes through this same owner) carries the anti-fabrication
  // contract. One owner, no per-surface copies.
  const systemPrompt = `${scaffold}\n\n${TOOL_GROUNDED_COMMITMENTS}`;

  return { systemPrompt, agent, tenantOk, meta: convMeta, degraded, identity, conveneRefusal, borrowedRecalled };
}

/**
 * WF-BOA-4 — the GROUNDING-HONESTY notice. `composeChatContext` has always
 * computed a `degraded` ledger and `conversationExchange` never read it, so an
 * advisor whose persona missed or whose planning context / knowledge failed to
 * load still spoke ATTRIBUTED — under its own name, with its own `speakerId` —
 * and `turnPolicy.synthesize` defaults true, so the moderator then synthesised a
 * confident recommendation over it. A room full of ungrounded voices looked
 * exactly like a healthy one.
 *
 * The XCH-GRP-1 pattern applies verbatim: tell the MODEL what it is missing, in
 * the same composition that computed the miss, so the notice and the ledger are
 * constitutionally unable to disagree. It cannot lie about a block it does have,
 * because the ledger is the only input.
 *
 * Recorded residual (ADR 0588 D4): this makes the ungrounded voice able to say
 * so; it does not put a marker on the durable TURN. `ConversationTurn` is the
 * RFC 0005 wire shape, so a per-turn `degraded` field is an RFC change, not host
 * work — deliberately not smuggled in here.
 */
const DEGRADED_BLOCK_LABELS: Record<string, string> = {
  persona: 'your own persona and instructions',
  owner_knowledge: "this conversation owner's knowledge base",
  agent_knowledge: 'your bound knowledge base and memory',
  twin_borrowed_recall: "your principal's borrowed recall",
  twin_borrowed_recall_partial: "PART of your principal's borrowed recall (one of its sources failed to read, so what you were given is incomplete — a failed read, not an empty corpus)",
  board_context: "this board's planning context (its strategies and projects)",
  board_context_partial: "PART of this board's planning context (one or more of its strategies or projects has been archived or deleted, so what you were given is incomplete)",
};

export function groundingHonestyNotice(degraded: readonly string[]): string | null {
  const labels = degraded.map((d) => DEGRADED_BLOCK_LABELS[d]).filter((l): l is string => Boolean(l));
  if (labels.length === 0) return null;
  return `GROUNDING NOTICE — the following could not be loaded for this turn: ${labels.join('; ')}. Answer only from what is actually in this conversation, say plainly that the missing material was unavailable if it bears on the question, and do not present a recommendation as if it were grounded in it.`;
}

/**
 * ADR 0308 D1 — tool-grounded commitments (the anti-fabrication contract).
 * Born of a real incident: a board-chat assistant promised a metrics report,
 * an email draft, and "a link in your inbox" — with no tool call and no way to
 * run after the turn ended. An agent's words about ACTIONS must be backed by
 * tool calls in the SAME turn.
 */
export const TOOL_GROUNDED_COMMITMENTS =
  'Commitments must be tool-grounded. You may state that you did or produced something ' +
  'ONLY when a tool call in this same turn actually did it. If you lack a tool for what ' +
  'the user asks, say so plainly and offer what you CAN do with the tools you have. ' +
  'When you say you WILL do something, ground it in this same turn via one of exactly ' +
  'three paths (ADR 0311): DO it now with tools; SCHEDULE it with a scheduling tool ' +
  '(ADR 0309); or FILE it as a todo with a todo tool and tell the user you filed it. ' +
  'A bare unfiled promise is forbidden — you run only within this turn and nothing ' +
  'executes after it ends. Never tell the user to check a place ("your inbox", "the ' +
  'shared documents") unless a tool result in this turn confirms you wrote there.';

/** ADR 0277 — the no-persona scaffold. Previously a bare static string that
 *  discarded the caller's already-resolved NAME, the boardroom context block,
 *  and the owner-subject knowledge — an unscoped ("workspace assistant") voice
 *  session lost all three even when every lookup succeeded. Blocks append only
 *  when present, so a truly bare call still composes the exact legacy string. */
function composeGenericScaffold(input: { userName: string | null; addressName?: string | null; today?: string | null; injectedContextBlock?: string | undefined; knowledgeBlock?: string }): string {
  const injected = input.injectedContextBlock?.trim();
  const knowledge = input.knowledgeBlock?.trim();
  const name = input.userName?.trim();
  const addr = input.addressName?.trim() || (name ? firstNameOf(name) : '');
  const today = input.today?.trim();
  return [
    GENERIC_CHAT_SCAFFOLD,
    ...(injected ? ['', injected] : []),
    ...(knowledge ? ['', knowledge] : []),
    ...(today ? ['', `Today's date is ${today}.`] : []),
    ...(name ? ['', `You are talking to a human user named ${name}. Address them as ${addr}.`] : []),
  ].join('\n');
}

/** The current date, formatted for temporal grounding in a chat scaffold, e.g.
 *  "Tuesday, 2026-07-15 (UTC)" — weekday (relative-time reasoning) + unambiguous
 *  ISO date + explicit zone (the server runs UTC). The ONE impure boundary for
 *  the date; the scaffold functions themselves take the string and stay pure. */
export function promptDateStamp(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return `${weekday}, ${now.toISOString().slice(0, 10)} (UTC)`;
}

/**
 * Spoken-mode addendum (ADR 0199) — the useful half of the retired RT-2
 * placeholder, appended AFTER the agent scaffold so voice keeps its manner
 * without losing its brain.
 */
export const SPOKEN_MODE_ADDENDUM =
  'You are in a spoken, real-time voice conversation. Be brief and conversational — ' +
  'one idea at a time. Confirm before taking any action that has effects.';

function turnText(t: ConversationTurn): string {
  const c = t.content as unknown;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => (p as { type?: string }).type === 'text').map((p) => (p as { text?: string }).text ?? '').join(' ');
  return '';
}

/** The one turn-loading + windowing path (ADR 0148 budget) behind both the
 *  digest and the structured-turns view. Resolves the chat's backing run via
 *  ConversationMeta (`conversationRunId`). */
async function loadWindowedTurns(
  storage: Storage, tenantId: string, conversationId: string,
): Promise<{ kept: Awaited<ReturnType<typeof loadTurns>>; omittedCount: number }> {
  const meta = await getConversationMeta(tenantId, conversationId);
  const runId = meta?.conversationRunId;
  if (!runId) return { kept: [], omittedCount: 0 };
  const turns = await loadTurns(storage, runId, conversationId);
  if (turns.length === 0) return { kept: [], omittedCount: 0 };
  return windowTranscript(turns, transcriptBudgetConfig(), (t) => turnText(t).length);
}

/**
 * ADR 0199 OQ-1 (Deferred Phase G) — the SAME windowed transcript as
 * structured turns, for providers that accept real history items (OpenAI
 * `conversation.item.create`) instead of an instructions block. One
 * loadTurns + windowTranscript owner with the digest; fail-soft to [].
 */
export async function composeTranscriptTurns(
  storage: Storage, tenantId: string, conversationId: string,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  try {
    const { kept } = await loadWindowedTurns(storage, tenantId, conversationId);
    return kept
      .map((t) => ({ role: t.role === 'user' ? ('user' as const) : ('assistant' as const), text: turnText(t).trim() }))
      .filter((t) => t.text.length > 0);
  } catch {
    return [];
  }
}

/**
 * A speaker-labeled, char-budgeted digest of the conversation so far, for
 * seeding a realtime-voice session opened mid-conversation as an
 * instructions block (the Gemini path — no history-item API). Fail-soft: ''.
 */
export async function composeTranscriptDigest(storage: Storage, tenantId: string, conversationId: string): Promise<string> {
  try {
    const { kept, omittedCount } = await loadWindowedTurns(storage, tenantId, conversationId);
    if (kept.length === 0) return '';
    const lines = kept
      .map((t) => {
        const text = turnText(t).trim();
        if (!text) return null;
        const who = t.role === 'user' ? 'User' : (t.from ?? t.agent?.agentId ?? 'Assistant');
        return `${who}: ${text}`;
      })
      .filter((l): l is string => l !== null);
    if (lines.length === 0) return '';
    const head = omittedCount > 0 ? `Conversation so far (${omittedCount} earlier turns omitted):` : 'Conversation so far:';
    return `${head}\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
