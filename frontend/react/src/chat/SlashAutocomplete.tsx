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
 * alphabetically. The groups carry visible subheads ("Commands" /
 * "Workflows" / "Templates") so the user knows they're choosing between
 * distinct surfaces, not one homogeneous list.
 *
 * The picker-templates ADR — a typed query that matches chain templates adds
 * a third group, "Templates" (at most three rows + "Browse all templates…").
 * A template row opens the shared preflight overlay; it never inserts a slug
 * and never runs (`lib/slashTemplates.ts` `slashRowIntent`). A template the
 * caller already owns a copy of is offered as that owned workflow instead,
 * with a "From template" chip.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { optionId, useReportActiveOption, type ComboboxWiring } from './lib/comboboxWiring.js';
import { Trans, useTranslation } from 'react-i18next';
import { filterCommands, resolveDescription, type CommandRegistration } from './registry/CommandRegistry.js';
import {
  detectSlashTrigger,
  filterMentions,
  listWorkflowMentions,
  refreshWorkflowMentionCache,
  workflowMentionLoadFailed,
  type WorkflowMentionEntry,
} from './lib/workflowMentions.js';
import {
  buildTemplateGroup,
  listCachedChainTemplates,
  refreshChainTemplateCache,
  slashRowIntent,
  type SlashRow,
  type TemplateGate,
  type TemplateIntent,
  type TemplateRowModel,
} from './lib/slashTemplates.js';
import { useScopeWriteAccess } from '../lib/writeAccess.js';
import { useAllFeatureAccess } from '../featureToggles/FeatureAccessContext.js';

interface Props {
  /** Combobox wiring to the composer textarea (grade-ux CHATUX-1). */
  combobox?: ComboboxWiring;
  text: string;
  /** Called with the new textarea contents on selection. The caller
   *  is responsible for focus + cursor placement. */
  onPick: (newText: string) => void;
  /** Called on Esc. Caller usually no-ops (the picker dismisses
   *  naturally on text change). */
  onDismiss: () => void;
  /** The picker-templates ADR — when set, a typed query that matches chain
   *  templates adds a third group, Templates. Picking one hands this an
   *  "open preflight" (or "browse all") intent; it never inserts or runs. */
  onTemplateIntent?: (intent: TemplateIntent) => void;
}

/**
 * The picker mounts only while a `/` token is active, so the caller-access read
 * the Templates group needs happens when the picker opens, not on every
 * composer mount.
 */
export function SlashAutocomplete(props: Props): JSX.Element | null {
  if (detectSlashTrigger(props.text) === null) return null;
  if (!props.onTemplateIntent) return <SlashPicker {...props} gate={null} />;
  return <TemplateGatedSlashPicker {...props} onTemplateIntent={props.onTemplateIntent} />;
}

function TemplateGatedSlashPicker(props: Props & { onTemplateIntent: (intent: TemplateIntent) => void }): JSX.Element | null {
  // The `from-chain` route requires `workspace:write`; a member without it is
  // shown the template disabled rather than offered a pick that ends in a 403.
  const canWrite = useScopeWriteAccess('workspace:write');
  const { byId } = useAllFeatureAccess();
  const gate = useMemo<TemplateGate>(
    () => ({ canWrite, featureEnabled: (id) => byId[id]?.enabled === true }),
    [canWrite, byId],
  );
  return <SlashPicker {...props} gate={gate} />;
}

function SlashPicker({ text, onPick, onDismiss, combobox, onTemplateIntent, gate }: Props & { gate: TemplateGate | null }): JSX.Element | null {
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
  // visible, not on every keystroke. The chain catalog warms on the same edge
  // (the picker-templates ADR), separately, so a slow catalog never holds back
  // the caller's own workflows.
  const [, setRefreshTick] = useState(0);
  const templatesOn = gate !== null;
  useEffect(() => {
    if (!shouldShow) return;
    void refreshWorkflowMentionCache().then(() => setRefreshTick((n) => n + 1));
    if (templatesOn) void refreshChainTemplateCache().then(() => setRefreshTick((n) => n + 1));
  }, [shouldShow, templatesOn]);

  // Re-source on every render so a newly-saved workflow shows up
  // without needing a route remount. `listWorkflowMentions()`
  // merges the backend-owned cache + localStorage but the list is tiny.
  const allWorkflows = listWorkflowMentions();
  const catalog = listCachedChainTemplates();
  const commandMatches = useMemo(
    // After an "@agent " hand-off, only workflows make sense (you can't `/clear`
    // a hand-off), so suppress built-in commands when a mention prefix is present.
    () => (shouldShow && !prefix ? filterCommands(query) : []),
    [shouldShow, prefix, query],
  );
  // The picker-templates ADR — matching templates the caller does not own yet,
  // and the owned copies of the ones they do (offered in the template's place).
  const templateGroup = useMemo(
    () => (shouldShow && gate ? buildTemplateGroup(catalog, allWorkflows, query, gate) : null),
    [shouldShow, gate, catalog, allWorkflows, query],
  );
  const workflowMatches = useMemo(() => {
    if (!shouldShow) return [];
    const matched = filterMentions(allWorkflows, query);
    for (const wf of templateGroup?.ownedInstead ?? []) if (!matched.includes(wf)) matched.push(wf);
    return matched;
  }, [shouldShow, allWorkflows, query, templateGroup]);

  // Single flat row list backs the keyboard handler + index math.
  // Order: commands, workflows, then templates and the "Browse all" row.
  // Subhead rows live in the rendered output but aren't part of `rows`
  // (they're not selectable).
  const rows: SlashRow[] = useMemo(() => {
    const out: SlashRow[] = [];
    for (const cmd of commandMatches) out.push({ kind: 'command', cmd });
    for (const wf of workflowMatches) out.push({ kind: 'workflow', wf });
    if (templateGroup?.show) {
      for (const tpl of templateGroup.templates) out.push({ kind: 'template', tpl });
      out.push({ kind: 'browse-templates', disabled: gate?.canWrite !== true });
    }
    return out;
  }, [commandMatches, workflowMatches, templateGroup, gate]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);
  useReportActiveOption(combobox, shouldShow, rows.length, selectedIdx);

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
    // picking a workflow after "@devon /" keeps the agent. A template row
    // opens the shared preflight instead (it never inserts or runs).
    const intent = slashRowIntent(row, prefix);
    if (intent.kind === 'insert') onPick(intent.text);
    else if (intent.kind === 'open-preflight' || intent.kind === 'browse-templates') onTemplateIntent?.(intent);
  }

  const listRef = useRef<HTMLDivElement>(null);
  if (!shouldShow) return null;

  // ADR 0764 D4 (CHATWF-4) — a failed workflow-list load is NOT "no match". The
  // two rendered identically, so a 429/5xx read as "you have no such workflow".
  const loadFailed = workflowMentionLoadFailed();

  if (rows.length === 0) {
    return (
      <div
        ref={listRef}
        className="slashac-empty"
        role="status"
      >
        {loadFailed
          ? t('workflowsLoadFailed')
          : <Trans i18nKey="noCommandsMatch" ns="chat" values={{ query: trimmed }} components={[<></>, <code />, <></>, <code />]} />}
      </div>
    );
  }

  const listboxId = combobox?.listboxId ?? 'slashac';
  return (
    <div
      ref={listRef}
      role="listbox"
      id={combobox?.listboxId}
      aria-label={t('slashCommandsAria')}
      {...(loadFailed ? { 'aria-describedby': `${listboxId}-load-failed` } : {})}
      className="slashac-listbox"
    >
      {loadFailed && (
        // Not an option, so hidden from the listbox's children; the listbox's
        // aria-describedby still reads it (a description may reference hidden text).
        <div id={`${listboxId}-load-failed`} className="slashac-note" aria-hidden="true">{t('workflowsLoadFailed')}</div>
      )}
      {rows.map((row, i) => {
        // A subhead opens each group: commands, workflows, then templates (the
        // "Browse all" row belongs to the Templates group).
        const group = row.kind === 'browse-templates' ? 'template' : row.kind;
        const prev = rows[i - 1];
        const prevGroup = prev ? (prev.kind === 'browse-templates' ? 'template' : prev.kind) : null;
        const subhead = group !== prevGroup
          ? <Subhead label={t(group === 'command' ? 'commandsSection' : group === 'workflow' ? 'workflowsSection' : 'templatesSection')} />
          : null;
        const common = {
          id: optionId(listboxId, i),
          selected: i === selectedIdx,
          onClick: () => apply(row),
          onHover: () => setSelectedIdx(i),
        };
        const key = row.kind === 'command' ? `cmd:${row.cmd.name}`
          : row.kind === 'workflow' ? `wf:${row.wf.workflowId}`
            : row.kind === 'template' ? `tpl:${row.tpl.chainId}`
              : 'tpl:browse';
        return (
          <SlashRowItem key={key} subhead={subhead}>
            {row.kind === 'command' ? <CommandRow {...common} cmd={row.cmd} />
              : row.kind === 'workflow' ? <WorkflowRow {...common} wf={row.wf} />
                : row.kind === 'template' ? <TemplateRow {...common} tpl={row.tpl} />
                  : <BrowseTemplatesRow {...common} disabled={row.disabled} />}
          </SlashRowItem>
        );
      })}
      {/* ADR 0768 D4 — the keys this picker ACTUALLY handles (the onKey handler
          above: arrows wrap, Enter or Tab applies, Esc dismisses). aria-hidden like
          the agent picker's tip: the combobox pattern already conveys navigation. */}
      <div className="mentionac-tip" aria-hidden="true">{t('slashPickerKeys')}</div>
    </div>
  );
}

/** A row with the subhead that opens its group, if any. A fragment: the
 *  listbox's options stay its direct children. */
function SlashRowItem({ subhead, children }: { subhead: JSX.Element | null; children: JSX.Element }): JSX.Element {
  return <>{subhead}{children}</>;
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
  id,
  cmd,
  selected,
  onClick,
  onHover,
}: {
  id: string;
  cmd: CommandRegistration;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      // Focus stays in the composer (aria-activedescendant), so this rarely fires;
      // it keeps the pointer handler paired with a keyboard one (jsx-a11y).
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className="slashac-row"
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
  id,
  wf,
  selected,
  onClick,
  onHover,
}: {
  id: string;
  wf: WorkflowMentionEntry;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      // Focus stays in the composer (aria-activedescendant), so this rarely fires;
      // it keeps the pointer handler paired with a keyboard one (jsx-a11y).
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className="slashac-row"
    >
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <code className="u-fw-600 u-fs-12">/{wf.slug}</code>
        <span className="muted u-fs-11 u-truncate">{wf.displayName}</span>
        {wf.draft ? <span className="chip chip--muted u-fs-10">{t('workflowDraftChip')}</span> : null}
        {wf.fromChainId ? <span className="chip chip--muted u-fs-10">{t('workflowFromTemplateChip')}</span> : null}
      </div>
      <div className="muted u-fs-11">{wf.description}</div>
    </div>
  );
}

function TemplateRow({
  id,
  tpl,
  selected,
  onClick,
  onHover,
}: {
  id: string;
  tpl: TemplateRowModel;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={tpl.disabled || undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className={tpl.disabled ? 'slashac-row muted' : 'slashac-row'}
    >
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <span className="u-fw-600 u-fs-12 u-truncate">{tpl.label}</span>
      </div>
      <div className="muted u-fs-11">{tpl.disabled ? t('templateAskAdmin') : tpl.description}</div>
    </div>
  );
}

function BrowseTemplatesRow({
  id,
  disabled,
  selected,
  onClick,
  onHover,
}: {
  id: string;
  disabled: boolean;
  selected: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={onHover}
      className={disabled ? 'slashac-row muted' : 'slashac-row'}
    >
      <div className="u-fs-12">{t('templateBrowseAll')}</div>
      {disabled ? <div className="muted u-fs-11">{t('templateAskAdmin')}</div> : null}
    </div>
  );
}
