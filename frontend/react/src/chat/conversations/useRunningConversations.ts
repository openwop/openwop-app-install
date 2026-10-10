/**
 * ADR 0776 P2 — "Running" for conversations the client does not hold open.
 *
 * Reads the server's answer (`/chat/sessions/running`) on mount, then every
 * 20 s while the page is visible and again when it regains focus: a run started
 * from another device, or by an agent tool, has no frame this client would see.
 * A failed read keeps the LAST answer rather than clearing every row's status
 * (a network blip must not claim that nothing is running).
 */
import { useEffect, useState } from 'react';
import { listRunningConversations } from '../../client/chatSessionsClient.js';

const POLL_MS = 20_000;
const EMPTY: ReadonlySet<string> = new Set();

export function useRunningConversations(enabled = true): ReadonlySet<string> {
  const [running, setRunning] = useState<ReadonlySet<string>>(EMPTY);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      listRunningConversations().then(
        (r) => { if (live) setRunning(new Set(r.conversations.map((c) => c.conversationId))); },
        () => { /* keep the last answer */ },
      );
    };
    read();
    const timer = setInterval(read, POLL_MS);
    window.addEventListener('focus', read);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [enabled]);
  return running;
}
