/**
 * ADV-UX-1 (Blocker) / ADR 0588 D5 — the simulated-persona disclaimer, IN CHAT.
 *
 * ADR 0040:345 requires the disclaimer "in chat + on the board", and ADR 0040:194
 * describes a disclaimer banner in the council chat. It had exactly two
 * renderers, both on `/advisors` — the management page — and ZERO under
 * `chat/`: the `SIMULATION NOTICE` prepend that carried it died with
 * `host/advisoryBoardConvene.ts` in the ADR 0040 §Correction of 2026-06-15 and
 * was never re-homed. The chat is the only surface where the advice is actually
 * read, so the one place it was missing is the one place it matters.
 *
 * The text is SERVER-authored (`board.disclaimer`, `service.ts#disclaimerFor`) —
 * never a client copy — so there is one source of truth for a legal string and
 * no drift lane. `disclaimerFor` is total since ADR 0588 D5, so this renders for
 * every persona kind; the `null` branch is kept because the wire type allows it
 * and a third-party host might return it.
 *
 * Failure honesty: a failed board read renders NOTHING rather than a guess. That
 * is deliberate and bounded — the disclaimer is also on the board card and the
 * board is unopenable without a successful read elsewhere — but it is a real
 * residual, so the read failure is logged rather than swallowed silently.
 */

import { useEffect, useState } from 'react';
import { Notice } from '../../ui/Notice.js';
import { getBoard } from '../../features/advisory-board/advisoryBoardClient.js';

export function BoardDisclaimerNotice({ boardId }: { boardId: string }): JSX.Element | null {
  const [disclaimer, setDisclaimer] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDisclaimer(null);
    void (async () => {
      try {
        const board = await getBoard(boardId);
        if (live) setDisclaimer(board.disclaimer);
      } catch (err) {
        // Not a Notice: an advisory-board read failure is not the user's problem
        // to act on mid-conversation, and a second banner would displace the
        // one polite live-region slot a real error needs.
        console.warn('board_disclaimer_unavailable', boardId, err);
      }
    })();
    return () => { live = false; };
  }, [boardId]);

  if (!disclaimer) return null;
  // `announce` is deliberately NOT set: this mounts WITH content on every board
  // conversation open, and a live region mounted with content announces nothing
  // anyway — while claiming the one polite slot that a send failure needs.
  return <Notice variant="info">{disclaimer}</Notice>;
}
