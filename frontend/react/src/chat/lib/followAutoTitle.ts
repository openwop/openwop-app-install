/**
 * ADR 1019 D4 — follow a new chat's auto-title past the end of its first exchange.
 *
 * The server names the chat AFTER the first exchange is durable (a model call of a
 * second or more), and the exchange's run stream is closed by then, so the
 * `openwop-app.conversation.titled` event usually lands with nobody listening. This
 * reads the session header on a short bounded backoff until the server says how the
 * title ended: `auto` → report it; `user` / `given` → stop (a person or the chat's
 * own source named it); still `default` / `claimed` after the last read → stop
 * silently (no title this time, the placeholder stays).
 */
import { getChatSession, type ChatSessionHeader } from '../../client/chatSessionsClient.js';

/** Offsets from the first exchange's settle. The last read sits past the server's
 *  15 s title bound plus the reads before it. */
export const AUTO_TITLE_FOLLOW_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 18_000, 30_000];

export interface FollowAutoTitleDeps {
  read?: (sessionId: string) => Promise<Pick<ChatSessionHeader, 'title' | 'titleSource'>>;
  delaysMs?: readonly number[];
}

/** Starts the follow; returns a cancel function. `onTitle` fires at most once. */
export function followAutoTitle(
  sessionId: string,
  onTitle: (title: string) => void,
  deps: FollowAutoTitleDeps = {},
): () => void {
  const read = deps.read ?? getChatSession;
  const delays = deps.delaysMs ?? AUTO_TITLE_FOLLOW_DELAYS_MS;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0;
  const step = (i: number): void => {
    if (cancelled || i >= delays.length) return;
    const wait = Math.max(0, delays[i]! - elapsed);
    elapsed = delays[i]!;
    timer = setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        let header: Pick<ChatSessionHeader, 'title' | 'titleSource'> | null = null;
        try { header = await read(sessionId); } catch { /* transient — the next read retries */ }
        if (cancelled) return;
        const source = header?.titleSource;
        if (source === 'auto' && header?.title) { cancelled = true; onTitle(header.title); return; }
        if (source === 'user' || source === 'given') { cancelled = true; return; }
        step(i + 1);
      })();
    }, wait);
  };
  step(0);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
