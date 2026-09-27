/**
 * Agent @-mention autocomplete popover.
 *
 * Replaces the cursor-aware behaviour of the old
 * `WorkflowMentionAutocomplete` on the `@` trigger, with one
 * material difference: the popover now lists installed *agents*
 * (sourced from `GET /v1/agents` via `useAgentMentions()`), not
 * workflows. Workflows have moved to the unified `/` picker
 * (`SlashAutocomplete.tsx`) as of the 2026-05-28 mention-symbol swap.
 *
 * Trigger: when scanning leftward from the cursor we hit `@` before
 * any whitespace, AND the `@` is preceded by whitespace or
 * start-of-string. Identical detection rule to the previous workflow
 * picker — only the data source + display row changes.
 *
 * Keyboard: ↑↓ navigate, Enter / Tab to apply, Esc dismisses.
 *
 * On apply: rebuilds the textarea text with `@<persona-slug> ` and
 * hands back the new cursor position so ChatInput can restore DOM
 * selection. The actual *activation* of the agent (adding it to the
 * active-agents side panel + switching the currently-routing agent)
 * lands in phase D3, driven by the submit path's
 * `detectAgentMention()` check. For phase B2 this picker is purely a
 * text-insertion affordance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  filterAgentMentions,
  useAgentMentions,
  type AgentMentionEntry,
} from './lib/agentMentions.js';

interface Props {
  text: string;
  cursorPos: number;
  onPick: (newText: string, newCursorPos: number) => void;
  onDismiss: () => void;
  /** ADR 0192 D8 — channel-scoped entries (the channel's agent members with
   *  their server-persisted mention slugs). When set, the tenant-wide agent
   *  fetch is skipped entirely. */
  entriesOverride?: readonly AgentMentionEntry[];
}

interface MentionState {
  /** Index of the `@` character. */
  atPos: number;
  /** Query substring between `@` and cursor (may be empty). */
  query: string;
}

/** Locate an active mention near the cursor. Symmetric to the
 *  previous workflow-mention detector — `@` must be preceded by
 *  whitespace or start-of-string, and there must be no whitespace
 *  between `@` and the cursor. */
function detectMentionState(text: string, cursorPos: number): MentionState | null {
  let i = cursorPos - 1;
  while (i >= 0) {
    const ch = text.charAt(i);
    if (ch === '@') {
      const prev = i === 0 ? '' : text.charAt(i - 1);
      if (prev === '' || /\s/.test(prev)) {
        return { atPos: i, query: text.substring(i + 1, cursorPos) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

export function AgentMentionAutocomplete({
  text,
  cursorPos,
  onPick,
  onDismiss,
  entriesOverride,
}: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  // Unconditional hook call; the fetch is skipped when the caller supplies its
  // own entry source (a channel roster — ADR 0192 D8).
  const fetched = useAgentMentions(entriesOverride !== undefined);
  const entries = entriesOverride ?? fetched.entries;
  const isLoading = entriesOverride !== undefined ? false : fetched.isLoading;
  const error = entriesOverride !== undefined ? null : fetched.error;
  const mention = detectMentionState(text, cursorPos);
  const query = mention?.query ?? '';
  const matches = useMemo(
    () => (mention ? filterAgentMentions(entries, query) : []),
    [entries, mention, query],
  );

  const [selectedIdx, setSelectedIdx] = useState(0);
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, mention?.atPos]);

  const apply = useCallback(
    (picked: AgentMentionEntry): void => {
      if (!mention) return;
      const before = text.substring(0, mention.atPos);
      const after = text.substring(mention.atPos + 1 + query.length);
      const insertion = `@${picked.slug} `;
      const newText = before + insertion + after;
      const newCursorPos = before.length + insertion.length;
      onPick(newText, newCursorPos);
    },
    [mention, query, text, onPick],
  );

  useEffect(() => {
    if (!mention) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (matches.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => (i + 1) % matches.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => (i - 1 + matches.length) % matches.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        // stopPropagation so the textarea's React onKeyDown does NOT
        // also see this Enter and submit the half-typed message.
        e.stopPropagation();
        const picked = matches[selectedIdx];
        if (picked) apply(picked);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mention, matches, selectedIdx, onDismiss, apply]);

  const listRef = useRef<HTMLDivElement>(null);
  if (!mention) return null;

  // Empty-state branches: distinct copy for "still loading", "host
  // doesn't have any agents installed", and "user query matches
  // nothing". Each tells the user something different about how to
  // recover — generic "no matches" hides the load + zero-installed
  // cases behind the same text.
  if (isLoading && entries.length === 0) {
    return (
      <EmptyPanel listRef={listRef}>
        {t('loadingAgents')}
      </EmptyPanel>
    );
  }
  if (error) {
    return (
      <EmptyPanel listRef={listRef} tone="error">
        {t('couldNotLoadAgents', { error })}
      </EmptyPanel>
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyPanel listRef={listRef}>
        <Trans i18nKey="noAgentsInstalled" ns="chat" components={{ 1: <strong /> }} />
      </EmptyPanel>
    );
  }
  if (matches.length === 0) {
    return (
      <EmptyPanel listRef={listRef}>
        <Trans i18nKey="noAgentsMatch" ns="chat" values={{ query }} components={{ 1: <code /> }} />
      </EmptyPanel>
    );
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('agentMentionsAria')}
      className="mentionac-listbox"
    >
      {matches.map((entry, i) => (
        <AgentRow
          key={entry.agentId}
          entry={entry}
          selected={i === selectedIdx}
          onClick={() => apply(entry)}
          onHover={() => setSelectedIdx(i)}
        />
      ))}
      <div className="mentionac-tip">
        {t('agentMentionTip')}
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
        border: `1px solid ${tone === 'error' ? 'var(--color-danger)' : 'var(--rule)'}`,
        color: tone === 'error' ? 'var(--color-danger)' : 'var(--ink-3)',
      }}
    >
      {children}
    </div>
  );
}

function AgentRow({
  entry,
  selected,
  onClick,
  onHover,
}: {
  entry: AgentMentionEntry;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className="mentionac-row"
      style={{ background: selected ? 'var(--paper-2)' : 'transparent' }}
    >
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <code className="u-fw-600 u-fs-12">@{entry.slug}</code>
        <span className="muted u-fs-11">{entry.displayName}</span>
        {/* Channel-roster entries carry no modelClass — no empty chip (ADR 0192). */}
        {entry.modelClass && (
          <span className="u-fs-10 u-pad-1x6 u-radius u-bg-surface-2 muted u-mono">
            {entry.modelClass}
          </span>
        )}
      </div>
      <div className="muted u-fs-11">{entry.description}</div>
    </div>
  );
}
