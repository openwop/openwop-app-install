/**
 * ADR 0944 D2 — `/chat?client=<orgId>` opens a NEW conversation bound to that
 * client's shared agent memory. The binding is set once, at creation, by the
 * server (which checks the caller may read the client), so the link creates the
 * conversation here and hands over to the existing `?conversation=` deep link,
 * keeping any `?agent=` beside it. Both chat layouts read that link, so neither
 * needs to know about clients. One-shot per value.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createChatSession, type ChatSessionHeader } from '../client/chatSessionsClient.js';

export type ClientDeepLinkState = 'idle' | 'opening' | 'failed';

export function useClientDeepLink(enabled = true): { state: ClientDeepLinkState; dismiss: () => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<ClientDeepLinkState>('idle');
  const pending = useRef<{ client: string; result: Promise<ChatSessionHeader> } | null>(null);
  const wanted = searchParams.get('client');

  useEffect(() => {
    if (!wanted) { pending.current = null; return; }
    if (!enabled) return;
    // StrictMode replays the effect. Reuse the request while attaching a fresh
    // live subscriber, so cleanup cannot strand a successfully created chat.
    if (pending.current?.client !== wanted) {
      pending.current = { client: wanted, result: createChatSession({ sessionId: crypto.randomUUID(), clientOrgId: wanted }) };
    }
    const request = pending.current;
    setState('opening');
    let live = true;
    void request.result
      .then((created) => {
        if (!live || pending.current !== request) return;
        setSearchParams((current) => {
          if (current.get('client') !== wanted) return current;
          const next = new URLSearchParams(current);
          next.delete('client');
          next.set('conversation', created.sessionId);
          return next;
        }, { replace: true });
        setState('idle');
      })
      .catch(() => {
        if (!live || pending.current !== request) return;
        setSearchParams((current) => {
          if (current.get('client') !== wanted) return current;
          const next = new URLSearchParams(current);
          next.delete('client');
          return next;
        }, { replace: true });
        setState('failed');
      });
    return () => { live = false; };
  }, [enabled, wanted, searchParams, setSearchParams]);

  return { state, dismiss: () => setState('idle') };
}
