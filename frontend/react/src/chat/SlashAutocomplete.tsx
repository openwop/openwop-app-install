/**
 * Unified slash-prefix picker — shows both built-in commands AND
 * registered workflows in one popover, grouped under subheads.
 *
 * Replaces the previous `CommandAutocomplete` (commands only) as part
 * of the 2026-05-28 mention-symbol swap:
 *   `@` → agents (new) — see AgentMentionAutocomplete.tsx (phase B2)
 *   `/` → commands + workflows (this file) — was just commands before
 *
 * Trigger: text starts with `/` and has no space yet (args mode hides
 * the picker so commands like `/help search-term` can type freely).
 *
 * Keyboard:
 *   ↑ ↓     navigate (wraps around)
 *   Enter   apply highlighted row
 *   Tab     apply highlighted row (no submit-Enter race)
 *   Esc     dismiss
 *
 * On apply:
 *   - Command row → insert `/clear ` (or `/help`, etc.) into textarea.
 *     The submit path's `findCommand()` matches it on Enter.
 *   - Workflow row → insert `/hello-world ` into textarea. The submit
 *     path's `detectWorkflowSlashMention()` matches it on Enter and
 *     dispatches through `runWorkflowMention()`.
 *
 * Built-in commands sort first so newcomers see `/clear /help /stop`
 * before a long list of user-defined workflows. Workflows then sort
 * alphabetically. The two groups carry visible subheads ("Commands" /
 * "Workflows") so the user knows they're choosing between two
 * distinct surfaces, not one homogeneous list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { filterCommands, resolveDescription, type CommandRegistration } from './registry/CommandRegistry.js';
import {
  detectSlashTrigger,
  filterMentions,
  listWorkflowMentions,
  refreshWorkflowMentionCache,
  type WorkflowMentionEntry,
} from './lib/workflowMentions.js';

/** A row in the unified menu. The discriminator drives both the
 *  rendered shape (commands carry usage hint; workflows carry slug +
 *  description) and what `onPick` returns. */
type SlashRow =
  | { kind: 'command'; cmd: CommandRegistration }
  | { kind: 'workflow'; wf: WorkflowMentionEntry };

interface Props {
  text: string;
  /** Called with the new textarea contents on selection. The caller
   *  is responsible for focus + cursor placement. */
  onPick: (newText: string) => void;
  /** Called on Esc. Caller usually no-ops (the picker dismisses
   *  naturally on text change). */
  onDismiss: () => void;
}

export function SlashAutocomplete({ text, onPick, onDismiss }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const trimmed = text.trimStart();
  // Trigger on a `/` token at the trailing position, allowing an optional
  // leading `@agent ` hand-off prefix so "@devon /" still opens the picker
  // (preserved on apply). Fixes: `/` showed nothing once an @mention was typed.
  const trigger = detectSlashTrigger(text);
  const shouldShow = trigger !== null;
  const prefix = trigger?.prefix ?? '';
  const query = trigger?.query ?? '';

  // When the picker opens, refresh the backend-owned workflow cache (ADR 0163
  // follow-on) and bump a tick so the freshly-fetched entries re-render. The
  // fetch is debounced by the open-edge: it only fires when the picker becomes
  // visible, not on every keystroke.
  const [, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!shouldShow) return;
    void refreshWorkflowMentionCache().then(() => setRefreshTick((t) => t + 1));
  }, [shouldShow]);

  // Re-source on every render so a newly-saved workflow shows up
  // without needing a route remount. `listWorkflowMentions()`
  // merges the backend-owned cache + localStorage but the list is tiny.
  const allWorkflows = listWorkflowMentions();
  const commandMatches = useMemo(
    // After an "@agent " hand-off, only workflows make sense (you can't `/clear`
    // a hand-off), so suppress built-in commands when a mention prefix is present.
    () => (shouldShow && !prefix ? filterCommands(query) : []),
    [shouldShow, prefix, query],
  );
  const workflowMatches = useMemo(
    () => (shouldShow ? filterMentions(allWorkflows, query) : []),
    [shouldShow, allWorkflows, query],
  );

  // Single flat row list backs the keyboard handler + index math.
  // Order: all commands, then all workflows. Subhead rows live in
  // the rendered output but aren't part of `rows` (they're not
  // selectable).
  const rows: SlashRow[] = useMemo(() => {
    const out: SlashRow[] = [];
    for (const cmd of commandMatches) out.push({ kind: 'command', cmd });
    for (const wf of workflowMatches) out.push({ kind: 'workflow', wf });
    return out;
  }, [commandMatches, workflowMatches]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (!shouldShow) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (rows.length === 0) {
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
        setSelectedIdx((i) => (i + 1) % rows.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => (i - 1 + rows.length) % rows.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        // stopPropagation so the textarea's React onKeyDown doesn't
        // also see this Enter and submit the half-typed slash input.
        e.stopPropagation();
        const picked = rows[selectedIdx];
        if (picked) apply(picked);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldShow, rows, selectedIdx]);

  function apply(row: SlashRow): void {
    // Insert the command/workflow + a trailing space so the user can keep
    // typing args, and PRESERVE any leading "@agent " hand-off prefix so
    // picking a workflow after "@devon /" keeps the agent.
    const body = row.kind === 'command' ? `${row.cmd.name} ` : `/${row.wf.slug} `;
    onPick(`${prefix}${body}`);
  }

  const listRef = useRef<HTMLDivElement>(null);
  if (!shouldShow) return null;

  if (rows.length === 0) {
    return (
      <div
        ref={listRef}
        className="slashac-empty"
      >
        <Trans i18nKey="noCommandsMatch" ns="chat" values={{ query: trimmed }} components={{ 1: <code />, 3: <code /> }} />
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('slashCommandsAria')}
      className="slashac-listbox"
    >
      {commandMatches.length > 0 && <Subhead label={t('commandsSection')} />}
      {commandMatches.map((cmd, i) => (
        <CommandRow
          key={`cmd:${cmd.name}`}
          cmd={cmd}
          selected={i === selectedIdx}
          onClick={() => apply({ kind: 'command', cmd })}
          onHover={() => setSelectedIdx(i)}
        />
      ))}
      {workflowMatches.length > 0 && <Subhead label={t('workflowsSection')} />}
      {workflowMatches.map((wf, wIdx) => {
        // wf's index in the flat `rows` array: all commands precede
        // any workflow, so its index is `commandMatches.length + wIdx`.
        const rowIdx = commandMatches.length + wIdx;
        return (
          <WorkflowRow
            key={`wf:${wf.workflowId}`}
            wf={wf}
            selected={rowIdx === selectedIdx}
            onClick={() => apply({ kind: 'workflow', wf })}
            onHover={() => setSelectedIdx(rowIdx)}
          />
        );
      })}
    </div>
  );
}

function Subhead({ label }: { label: string }): JSX.Element {
  return (
    <div
      className="slashac-subhead"
      aria-hidden
    >
      {label}
    </div>
  );
}

function CommandRow({
  cmd,
  selected,
  onClick,
  onHover,
}: {
  cmd: CommandRegistration;
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
      className="slashac-row"
      style={{ background: selected ? 'var(--color-surface-2)' : 'transparent' }}
    >
      <div className="u-flex u-items-center u-gap-2">
        <code className="u-fw-600 u-fs-12">{cmd.name}</code>
        {cmd.usage && <code className="muted u-fs-11">{cmd.usage}</code>}
      </div>
      <div className="muted u-fs-11">{resolveDescription(cmd.description)}</div>
    </div>
  );
}

function WorkflowRow({
  wf,
  selected,
  onClick,
  onHover,
}: {
  wf: WorkflowMentionEntry;
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
      className="slashac-row"
      style={{ background: selected ? 'var(--color-surface-2)' : 'transparent' }}
    >
      <div className="u-flex u-items-center u-gap-2">
        <code className="u-fw-600 u-fs-12">/{wf.slug}</code>
        <span className="muted u-fs-11">{wf.displayName}</span>
      </div>
      <div className="muted u-fs-11">{wf.description}</div>
    </div>
  );
}
