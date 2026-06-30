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
 * Scope: only ever started from a Board-of-Advisors summon, so a normal chat is
 * never affected.
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
}

export interface BoardroomCadence {
  /** Begin a cadence. The first queued turn fires when the in-flight opening
   *  turn (the user's `@@` message routed to the chair) completes. `question` is
   *  the user's original board question — passed as each advisor's knowledge
   *  retrieval query (ADR 0043 Phase 5B) so they retrieve against the topic, not
   *  the hand-off prompt. */
  start: (turns: readonly BoardroomTurn[], config: BYOKActiveConfig, question: string) => void;
  /** Abandon the remaining queued turns. */
  cancel: () => void;
  /** True while turns remain queued. */
  active: boolean;
}

/** The moderator-style hand-off prompt that opens each cadence turn. Kept short
 *  and neutral; the routed advisor's persona + system prompt do the rest. */
function handoffPrompt(turn: BoardroomTurn, persona: string): string {
  return turn.kind === 'synthesis'
    ? i18n.t('chat:boardSynthesisPrompt')
    : i18n.t('chat:boardAdvisorPrompt', { persona });
}

export function useBoardroomCadence({ isSending, errored, send, personaOf }: Options): BoardroomCadence {
  const queueRef = useRef<BoardroomTurn[]>([]);
  const configRef = useRef<BYOKActiveConfig | null>(null);
  const questionRef = useRef<string>('');
  const prevSendingRef = useRef(isSending);
  const [active, setActive] = useState(false);

  const cancel = useCallback(() => {
    queueRef.current = [];
    configRef.current = null;
    questionRef.current = '';
    setActive(false);
  }, []);

  const start = useCallback((turns: readonly BoardroomTurn[], config: BYOKActiveConfig, question: string) => {
    if (turns.length === 0) return;
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
      cancel();
      return;
    }
    const next = queueRef.current.shift();
    const config = configRef.current;
    if (!next || !config) {
      cancel();
      return;
    }
    void send(handoffPrompt(next, personaOf(next.agentId)), config, {
      activeAgentId: next.agentId,
      // Retrieve each advisor's knowledge against the user's real question, not
      // the hand-off prompt (ADR 0043 Phase 5B).
      ...(questionRef.current ? { knowledgeQuery: questionRef.current } : {}),
    });
    if (queueRef.current.length === 0) setActive(false);
  }, [isSending, errored, active, send, personaOf, cancel]);

  return { start, cancel, active };
}
