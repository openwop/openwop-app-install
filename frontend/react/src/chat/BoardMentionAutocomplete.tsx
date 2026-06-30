/**
 * Board `@@`-mention autocomplete popover (ADR 0040 / ADR 0043).
 *
 * The `@` sibling lists agents (`AgentMentionAutocomplete`); this one lists
 * Boards of Advisors on the `@@` trigger so a board is DISCOVERABLE rather than
 * requiring the user to already know its handle. Selecting a board inserts
 * `@@<handle> `; the submit path (`detectBoardMention` in ChatSidebar) then
 * convenes the cohort + runs the sequential boardroom cadence.
 *
 * Trigger detection is mutually exclusive with the agent picker: a single `@`
 * (agent) is preceded by whitespace/start, whereas `@@` (board) requires the
 * inner `@` to be preceded by another `@` that is itself at whitespace/start. So
 * exactly one popover is ever active for a given caret.
 *
 * Keyboard: ↑↓ navigate, Enter / Tab apply, Esc dismisses — same contract as the
 * agent picker, including `stopPropagation` so Enter never submits a half-typed
 * summon.
 *
 * The chat surface already couples to the advisory-board feature for `@@`
 * (ChatSidebar imports `getBoardByHandle`); this file confines the additional
 * `listBoards` import to one place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { listBoards } from '../features/advisory-board/advisoryBoardClient.js';

interface Props {
  text: string;
  cursorPos: number;
  onPick: (newText: string, newCursorPos: number) => void;
  onDismiss: () => void;
}

export interface BoardMentionEntry {
  handle: string;
  name: string;
  advisorCount: number;
}

interface MentionState {
  /** Index of the FIRST `@` of the `@@` trigger. */
  atPos: number;
  /** Query substring between `@@` and the cursor (may be empty). */
  query: string;
}

/** Locate an active `@@` board mention at the caret. The inner `@` must be
 *  immediately preceded by a `@` that is itself preceded by whitespace or
 *  start-of-string, and there must be no whitespace between `@@` and the cursor. */
export function detectBoardMentionState(text: string, cursorPos: number): MentionState | null {
  let i = cursorPos - 1;
  while (i >= 0) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) return null;
    if (ch === '@') {
      // `i` is the inner `@`; require a leading `@` at i-1 anchored to ws/start.
      if (text.charAt(i - 1) !== '@') return null; // single `@` → the agent picker's job
      const before = i - 2 < 0 ? '' : text.charAt(i - 2);
      if (before === '' || /\s/.test(before)) {
        return { atPos: i - 1, query: text.substring(i + 1, cursorPos) };
      }
      return null;
    }
    i--;
  }
  return null;
}

/** Case-insensitive substring filter on handle + name. */
export function filterBoardMentions(boards: readonly BoardMentionEntry[], query: string): BoardMentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...boards];
  return boards.filter((b) => b.handle.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
}

/** Fetch boards on mount → `{ boards, isLoading, error }`. Mirrors
 *  `useAgentMentions` (refetch per mount; newly-created boards show on reload). */
export function useBoardMentions(): {
  boards: readonly BoardMentionEntry[];
  isLoading: boolean;
  error: string | null;
} {
  const [boards, setBoards] = useState<readonly BoardMentionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listBoards();
        if (cancelled) return;
        setBoards(list.map((b) => ({ handle: b.handle, name: b.name, advisorCount: b.advisors.length })));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { boards, isLoading, error };
}

export function BoardMentionAutocomplete({ text, cursorPos, onPick, onDismiss }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const { boards, isLoading, error } = useBoardMentions();
  const mention = detectBoardMentionState(text, cursorPos);
  const query = mention?.query ?? '';
  const matches = useMemo(
    () => (mention ? filterBoardMentions(boards, query) : []),
    [boards, mention, query],
  );

  const [selectedIdx, setSelectedIdx] = useState(0);
  useEffect(() => { setSelectedIdx(0); }, [query, mention?.atPos]);

  const apply = useCallback(
    (picked: BoardMentionEntry): void => {
      if (!mention) return;
      const before = text.substring(0, mention.atPos);
      const after = text.substring(mention.atPos + 2 + query.length);
      const insertion = `@@${picked.handle} `;
      const newText = before + insertion + after;
      onPick(newText, before.length + insertion.length);
    },
    [mention, query, text, onPick],
  );

  useEffect(() => {
    if (!mention) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (matches.length === 0) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss(); }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        setSelectedIdx((i) => (i + 1) % matches.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setSelectedIdx((i) => (i - 1 + matches.length) % matches.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault(); e.stopPropagation();
        const picked = matches[selectedIdx];
        if (picked) apply(picked);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onDismiss();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mention, matches, selectedIdx, onDismiss, apply]);

  const listRef = useRef<HTMLDivElement>(null);
  if (!mention) return null;

  if (isLoading && boards.length === 0) {
    return <EmptyPanel listRef={listRef}>{t('loadingBoards')}</EmptyPanel>;
  }
  if (error) {
    return <EmptyPanel listRef={listRef} tone="error">{t('couldNotLoadBoards', { error })}</EmptyPanel>;
  }
  if (boards.length === 0) {
    return (
      <EmptyPanel listRef={listRef}>
        <Trans i18nKey="noBoardsInstalled" ns="chat" components={{ 1: <strong />, 3: <code /> }} />
      </EmptyPanel>
    );
  }
  if (matches.length === 0) {
    return (
      <EmptyPanel listRef={listRef}>
        <Trans i18nKey="noBoardsMatch" ns="chat" values={{ query }} components={{ 1: <code /> }} />
      </EmptyPanel>
    );
  }

  return (
    <div ref={listRef} role="listbox" aria-label={t('boardMentionsAria')} className="mentionac-listbox">
      {matches.map((board, i) => (
        <BoardRow
          key={board.handle}
          board={board}
          selected={i === selectedIdx}
          onClick={() => apply(board)}
          onHover={() => setSelectedIdx(i)}
        />
      ))}
      <div className="mentionac-tip">
        {t('boardMentionTip')}
      </div>
    </div>
  );
}

function EmptyPanel({
  listRef,
  children,
  tone = 'muted',
}: {
  listRef: React.RefObject<HTMLDivElement>;
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}): JSX.Element {
  return (
    <div
      ref={listRef}
      className="mentionac-empty"
      style={{
        border: `1px solid ${tone === 'error' ? 'var(--color-danger)' : 'var(--color-border)'}`,
        color: tone === 'error' ? 'var(--color-danger)' : 'var(--color-text-muted)',
      }}
    >
      {children}
    </div>
  );
}

function BoardRow({
  board,
  selected,
  onClick,
  onHover,
}: {
  board: BoardMentionEntry;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className="mentionac-row"
      style={{ background: selected ? 'var(--color-surface-2)' : 'transparent' }}
    >
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <code className="u-fw-600 u-fs-12">@@{board.handle}</code>
        <span className="muted u-fs-11">{board.name}</span>
        <span className="u-fs-10 u-pad-1x6 u-radius u-bg-surface-2 muted u-mono">
          {t('advisors', { count: board.advisorCount })}
        </span>
      </div>
    </div>
  );
}
