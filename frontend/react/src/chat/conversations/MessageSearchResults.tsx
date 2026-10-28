/**
 * Message search results for the Conversations rail (ADR 0112, ADR 0997 D5).
 *
 * The rail's own filter matches titles on the client; this section adds the
 * server's message matches under the same box. Every state is designed:
 * - loading: a quiet "Searching messages…" line while the debounced request runs;
 * - error: a Notice with Retry. It used to read as "no matches" (CSU-2);
 * - no matches: one line, when neither titles nor messages match;
 * - results: a polite live count (CSU-3), the matched words in `<mark>`, and a
 *   note when the server examined only the newest matching messages.
 * The matches open the conversation (jump-to-message is ADR 0997 residue, CSU-5).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { searchChatConversations, type ConversationSearchHit } from '../../client/chatSessionsClient.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';

/** The server's query needs at least this many characters before it runs. */
export const MIN_QUERY_CHARS = 2;
const DEBOUNCE_MS = 250;

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'done'; hits: readonly ConversationSearchHit[]; truncated: boolean };

/** The query's words, as the server tokenises them (ADR 0997 D3). */
export function highlightTokens(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/** `text` with every case-insensitive occurrence of a token wrapped in `<mark>`.
 *  Splits plain text into nodes; never `innerHTML`. */
export function highlight(text: string, tokens: readonly string[]): ReactNode[] {
  if (tokens.length === 0) return [text];
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let len = 0;
    for (const tok of tokens) {
      const j = lower.indexOf(tok, i);
      if (j >= 0 && (at < 0 || j < at || (j === at && tok.length > len))) { at = j; len = tok.length; }
    }
    if (at < 0) { out.push(text.slice(i)); break; }
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={at} className="search-hit-mark">{text.slice(at, at + len)}</mark>);
    i = at + len;
  }
  return out;
}

interface Props {
  query: string;
  /** Conversations the rail's title filter is already showing for `query`. */
  titleMatches: number;
  /** Open a matched conversation. */
  onOpen: (conversationId: string) => void;
}

export function MessageSearchResults({ query, titleMatches, onOpen }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const q = query.trim();

  useEffect(() => {
    if (q.length < MIN_QUERY_CHARS) { setState({ kind: 'idle' }); return; }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setState({ kind: 'loading' });
      searchChatConversations(q, controller.signal).then(
        (r) => { if (!controller.signal.aborted) setState({ kind: 'done', hits: r.hits.filter((h) => h.messageId), truncated: r.truncated }); },
        () => { if (!controller.signal.aborted) setState({ kind: 'error' }); },
      );
    }, DEBOUNCE_MS);
    return () => { controller.abort(); clearTimeout(handle); };
  }, [q, attempt]);

  if (q.length < MIN_QUERY_CHARS || state.kind === 'idle') return null;
  const tokens = highlightTokens(q);
  const hits = state.kind === 'done' ? state.hits : [];

  return (
    <section aria-label={t('messageMatches')} className="u-border-b">
      {/* One polite region for every outcome, so a screen reader hears the result
          of each search once, without focus leaving the box. */}
      <div role="status" aria-live="polite" className="sr-only">
        {state.kind === 'done' ? t('messageMatchesCount', { count: hits.length }) : ''}
      </div>
      {state.kind === 'loading' && (
        <p className="muted u-fs-12 u-m-0 u-p-2">{t('searchingMessages')}</p>
      )}
      {state.kind === 'error' && (
        <div className="u-m-2">
          <Notice variant="error" announce={t('messageSearchFailed')}>
            {t('messageSearchFailed')}
            <div className="u-mt-1-5">
              <Button variant="secondary" className="sesshist-mini-btn" onClick={() => setAttempt((n) => n + 1)}>
                {t('tryAgain')}
              </Button>
            </div>
          </Notice>
        </div>
      )}
      {state.kind === 'done' && hits.length === 0 && titleMatches === 0 && (
        <p className="muted u-fs-12 u-m-0 u-p-2">{t('searchNoMatches')}</p>
      )}
      {hits.length > 0 && (
        <>
          <h3 className="muted sesshist-group-head">{t('messageMatches')}</h3>
          <ul className="u-list-none u-m-0 u-p-1-5 u-flex u-flex-col u-gap-1">
            {hits.map((h) => (
              <li key={`${h.conversationId}:${h.messageId}`} className="session-row sesshist-row">
                <button type="button" className="sesshist-row-open" onClick={() => onOpen(h.conversationId)}>
                  <span className="sesshist-row-title u-truncate u-block" title={h.title}>{h.title || t('untitledConversation')}</span>
                  <span className="muted u-fs-11 u-truncate u-block">{highlight(h.snippet, tokens)}</span>
                </button>
              </li>
            ))}
          </ul>
          {state.kind === 'done' && state.truncated && (
            <p className="muted u-fs-11 u-m-0 u-pad-2-4">{t('searchTruncated')}</p>
          )}
        </>
      )}
    </section>
  );
}
