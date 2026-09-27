/**
 * Boardroom cadence driver (ADR 0043 Phase 5A / ADR 0040 increment 2).
 *
 * Drives a planned sequence of advisor turns ONE AT A TIME on the existing chat
 * send path. The blocker it solves: `send()` returns before the turn completes
 * (async SSE), so we can't await one advisor before the next. Instead the driver
 * watches the FALLING EDGE of `isSending` (a turn just finished) and dispatches
 * the next planned turn then — a self-clocking queue.
 *
 * Each planned turn is dispatched as a normal `send()` routed to that advisor
 * (`activeAgentId`), with a short moderator-style hand-off prompt so the provider
 * always has a trailing user turn (Anthropic/OpenAI both require the request to
 * end on a user message — a bare "continue as agent" turn isn't portable). The
 * chair's opening framing is the user's own `@@<board>` turn, already dispatched;
 * this driver runs the advisors + optional synthesis that follow it.
 *
 * Scope: started from a Board-of-Advisors summon OR a project convene (`runProjectConvene`
 * has called it since ADR 0054 D6 — this line used to say "only ever … Board-of-Advisors",
 * which was stale and is what let board vocabulary reach project rooms unnoticed). A normal
 * chat is never affected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n/index.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { SendOptions } from '../hooks/useChatSession.js';
import type { BoardroomTurn } from './boardroomCadence.js';

interface Options {
  /** True while a chat turn is streaming. */
  isSending: boolean;
  /** True when the most-recently-finished turn ended in an error. Drives the
   *  cadence to halt rather than march the rest of the board into the same
   *  failure (e.g. a missing credential). */
  errored: boolean;
  /** The chat send path (routes to `activeAgentId`). */
  send: (text: string, config: BYOKActiveConfig, opts?: SendOptions) => Promise<void>;
  /** Resolve an agent's display persona for the hand-off prompt. */
  personaOf: (agentId: string) => string;
  /** ADV-UX-4 — append a system line to the feed. The cadence used to `cancel()`
   *  in silence on a failed turn, so a board that stopped after two of five
   *  advisors and never synthesised was INDISTINGUISHABLE from one that finished.
   *  `convene.ts` has had this dep in hand for its other disclosures all along. */
  emitSystem?: (text: string) => void;
}

export interface BoardroomCadence {
  /** Begin a cadence. The first queued turn fires when the in-flight opening
   *  turn (the user's `@@` message routed to the chair) completes. `question` is
   *  the user's original board question — passed as each advisor's knowledge
   *  retrieval query (ADR 0043 Phase 5B) so they retrieve against the topic, not
   *  the hand-off prompt. */
  start: (turns: readonly BoardroomTurn[], config: BYOKActiveConfig, question: string, handle?: string) => void;
  /** Abandon the remaining queued turns. */
  cancel: () => void;
  /** True while turns remain queued. */
  active: boolean;
}

/** The moderator-style hand-off prompt that opens each cadence turn. Kept short
 *  and neutral; the routed advisor's persona + system prompt do the rest.
 *
 *  `COLWF-3` — the SYNTHESIS prompt is lane-branched, on the same signal `haltMessage` below
 *  already branches on (an empty handle means the PROJECT lane). The board wording asked a
 *  project teammate to "synthesize the BOARD's perspectives: name where the ADVISORS agree" —
 *  and unlike the halt sentence, which the L3 note branched for exactly this reason, this text
 *  goes to the MODEL. A project chair was being told it chairs a board.
 *
 *  `boardAdvisorPrompt` ("{{persona}}, your perspective?") is left shared deliberately: it is
 *  already lane-neutral, and duplicating it would create two strings to keep in step for no
 *  gain. */
function handoffPrompt(turn: BoardroomTurn, persona: string, handle: string): string {
  if (turn.kind !== 'synthesis') return i18n.t('chat:boardAdvisorPrompt', { persona });
  return handle ? i18n.t('chat:boardSynthesisPrompt') : i18n.t('chat:projectSynthesisPrompt');
}

/** ADR 0608 D7 (`CPWF-2`) — the halt sentence, or `null` when nothing was lost.
 *  Pure and module-level so the `errored` arm and the unmount cleanup cannot drift. */
function haltMessage(remaining: readonly BoardroomTurn[], handle: string): string | null {
  if (remaining.length === 0) return null;
  const synthesisPending = remaining.some((tn) => tn.kind === 'synthesis');
  const advisorsPending = remaining.filter((tn) => tn.kind !== 'synthesis').length;
  const synthesis = i18n.t(synthesisPending ? 'chat:boardCadenceHaltedSynthesis' : 'chat:boardCadenceHaltedNoSynthesis');
  return handle
    ? i18n.t('chat:boardCadenceHalted', { remaining: advisorsPending, synthesis, handle })
    : i18n.t('chat:projectCadenceHalted', { remaining: advisorsPending, synthesis });
}

export function useBoardroomCadence({ isSending, errored, send, personaOf, emitSystem }: Options): BoardroomCadence {
  const queueRef = useRef<BoardroomTurn[]>([]);
  const configRef = useRef<BYOKActiveConfig | null>(null);
  const questionRef = useRef<string>('');
  const prevSendingRef = useRef(isSending);
  const [active, setActive] = useState(false);

  // The board's `@@` handle, captured at `start` for the halt message's
  // "re-summon" instruction — a disclosure that names no exit is half a
  // disclosure.
  //
  // L3 — EMPTY means the PROJECT-team lane, not "a board with no handle".
  // `runProjectConvene` calls `start` with three arguments, so the halt message
  // used to say "The **boardroom** stopped … re-summon **@@**" for a failed
  // project convene: the wrong surface, and a dangling token. That violates the
  // ADV-UX-4 principle the ref exists to serve. Branch the sentence instead.
  const handleRef = useRef<string>('');

  /**
   * ADV-UX-4 — NAME the shortfall before abandoning the queue. Who did not speak,
   * and whether the synthesis ran, are exactly the two facts a reader cannot
   * recover from a truncated transcript.
   *
   * ADR 0608 D7 (`CPWF-2`) — the message is built by a MODULE-LEVEL pure function
   * so the `errored` arm and the UNMOUNT cleanup share one implementation with no
   * hook-dependency coupling between them. The disclosure used to fire only on
   * `errored`, so navigating away mid-cadence dropped the rest of the cohort and
   * the synthesis in SILENCE — the same "stopped after two of five is
   * indistinguishable from finished" defect this exists to prevent, through a
   * different door.
   */
  const emitSystemRef = useRef(emitSystem);
  emitSystemRef.current = emitSystem;
  const discloseHalt = (): void => {
    const msg = haltMessage(queueRef.current, handleRef.current);
    if (msg) emitSystemRef.current?.(msg);
  };

  const cancel = useCallback(() => {
    queueRef.current = [];
    configRef.current = null;
    questionRef.current = '';
    setActive(false);
  }, []);

  // ADR 0608 D7 (`CPWF-2`) — disclose on UNMOUNT (a route change, closing the tab
  // deck panel, switching sessions). It must run EXACTLY ONCE, at teardown, and
  // read the latest `emitSystem` — hence the ref rather than a dep on a callback
  // whose identity changes every render (that would emit a halt line MID-cadence,
  // which is worse than the silence it fixes).
  //
  // BOUNDARY, stated: a hard tab-close or reload runs no cleanup and cannot be
  // disclosed at all. The queue is browser-only state, which is the deeper finding
  // (`GEN-CPW-2`) and is not fixable here.
  useEffect(() => () => {
    const msg = haltMessage(queueRef.current, handleRef.current);
    if (msg) emitSystemRef.current?.(msg);
  }, []);

  const start = useCallback((turns: readonly BoardroomTurn[], config: BYOKActiveConfig, question: string, handle = '') => {
    if (turns.length === 0) return;
    handleRef.current = handle;
    queueRef.current = [...turns];
    configRef.current = config;
    questionRef.current = question;
    setActive(true);
  }, []);

  // Self-clocking: advance exactly once per turn completion (the true→false
  // edge of `isSending`), so dispatching the next turn (which flips `isSending`
  // back to true) can't double-fire while the stream is in flight.
  useEffect(() => {
    const fellIdle = prevSendingRef.current && !isSending;
    prevSendingRef.current = isSending;
    if (!fellIdle || !active) return;
    // The turn that just finished failed — stop the boardroom rather than march
    // the rest of the cohort into the same failure (and avoid burst-firing the
    // whole queue when every turn fails fast, e.g. a missing credential).
    if (errored) {
      discloseHalt();
      cancel();
      return;
    }
    const next = queueRef.current.shift();
    const config = configRef.current;
    if (!next || !config) {
      cancel();
      return;
    }
    void send(handoffPrompt(next, personaOf(next.agentId), handleRef.current), config, {
      activeAgentId: next.agentId,
      // ADV-UX-5 / WF-BOA-8 — this is the ORCHESTRATOR speaking, not the human.
      //
      // ADR 0608 D7 (`CPWF-2`) — CORRECTED 2026-08-24. The comment that stood here
      // said "the turn is durably persisted as `role:'user'`, so without the marker
      // the record is simply false", which reads as though this marker makes the
      // record true. It does not, and the reason is worth stating precisely — the
      // first draft of THIS correction got it wrong in the other direction by
      // claiming the flag "never leaves the browser", which is also false:
      //
      //   - it DOES reach the backend, inside the OPAQUE `content` JSON blob of
      //     the `chat_session` message row (`useSessionPersistence.persistMessage`
      //     stringifies the whole message), so the SPA's own history rehydrates it;
      //   - it does NOT reach the RFC 0005 `ConversationTurn` — what `:fork`
      //     replays and what a server-side auditor or another host reads. `grep -rn
      //     'orchestrated' backend/typescript/src` → ZERO hits: no backend code
      //     reads or writes a field by this name.
      //
      // So the durable RECORD THAT MATTERS still shows a machine-authored hand-off
      // as an ordinary human turn. Making it honest needs a field on
      // `ConversationTurn`, which is RFC 0005 wire surface and therefore an
      // `../openwop` RFC, not a host change (CLAUDE.md § "A spec change needs an
      // RFC"). Kept as the SPA-history label it actually is; tracked as `CPWF-2`.
      orchestrated: true,
      // Retrieve each advisor's knowledge against the user's real question, not
      // the hand-off prompt (ADR 0043 Phase 5B).
      ...(questionRef.current ? { knowledgeQuery: questionRef.current } : {}),
    });
    if (queueRef.current.length === 0) setActive(false);
  }, [isSending, errored, active, send, personaOf, cancel, emitSystem]);

  return { start, cancel, active };
}
