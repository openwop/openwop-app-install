/**
 * TurnReceipt — ADR 0768 P1 ("honest receipts").
 *
 * One line under an assistant turn saying what it did: model, tools run (and
 * how many failed), hand-offs, cost, sources. It expands to the SAME cards the
 * turn always had (tool calls, hand-offs, decisions, verifications, token
 * counts), so nothing is hidden that was shown before, it is folded.
 *
 * Every figure comes from fields the turn already carries (`agentEvents`,
 * `meta`); a figure the turn cannot source is omitted, never estimated.
 *
 * Default state: EXPANDED while the turn streams (you watch the work happen)
 * and whenever something went wrong (a failed tool or a failed verification
 * is never folded away); COLLAPSED once a healthy turn settles. A user toggle
 * overrides the default for the life of the bubble.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from './types.js';
import { Button } from '../ui/Button.js';
import { ToolCallCard, HandoffIndicator, DecisionBadge, VerificationCard } from './AgentEventCards.js';
import { formatUsd, turnCostUsd } from './lib/cost.js';
import { formatDurationMs, formatNumber } from '../i18n/format.js';
import { ChevronDownIcon, GlobeIcon } from '../ui/icons/index.js';
import { useToolEffects, type ToolEffect } from './lib/toolEffects.js';
import { useWorkbenchActions } from './workbench/workbenchActions.js';

export interface TurnReceiptSummary {
  model: string | null;
  tools: number;
  /** ADR 0784 — calls whose tool declares `read` / `write`; `tools` minus both is unknown. */
  reads: number;
  writes: number;
  failedTools: number;
  handoffs: number;
  failedVerifications: number;
  cost: number | null;
  sources: number;
  hasTokens: boolean;
  hasDetails: boolean;
}

/** Pure — what the receipt line can honestly claim about this turn. */
export function summarizeTurn(message: ChatMessage, effects: ReadonlyMap<string, ToolEffect> = new Map()): TurnReceiptSummary {
  const ev = message.agentEvents;
  const meta = message.meta;
  const toolCalls = ev?.toolCalls ?? [];
  const verified = ev?.verified ?? [];
  const hasTokens = meta?.inputTokens != null || meta?.outputTokens != null;
  const eventCount = toolCalls.length + (ev?.handoffs.length ?? 0) + (ev?.decisions.length ?? 0) + verified.length;
  return {
    model: meta?.provider && meta?.model ? meta.model : null,
    tools: toolCalls.length,
    reads: toolCalls.filter((c) => effects.get(c.toolName) === 'read').length,
    writes: toolCalls.filter((c) => effects.get(c.toolName) === 'write').length,
    failedTools: toolCalls.filter((c) => c.error).length,
    handoffs: ev?.handoffs.length ?? 0,
    failedVerifications: verified.filter((v) => v.verdict === 'fail').length,
    cost: meta && !meta.error ? turnCostUsd(meta) : null,
    sources: meta?.citations?.length ?? 0,
    hasTokens,
    hasDetails: eventCount > 0 || hasTokens || Boolean(meta?.provider && meta?.model) || (meta?.citations?.length ?? 0) > 0,
  };
}

export function TurnReceipt({ message }: { message: ChatMessage }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const detailsId = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const effects = useToolEffects((message.agentEvents?.toolCalls ?? []).map((c) => c.toolName));
  const s = summarizeTurn(message, effects);
  const workbench = useWorkbenchActions();
  const settled = !message.isStreaming;
  // The meta half only speaks once the turn settles (tokens/cost are final
  // then); the event half is live while streaming.
  const showMeta = settled && Boolean(message.meta) && !message.meta?.error;
  const hasEvents = s.tools + s.handoffs > 0 || (message.agentEvents?.decisions.length ?? 0) > 0 || (message.agentEvents?.verified?.length ?? 0) > 0;
  const hasDuration = settled && message.replyMs !== undefined;
  if (!hasEvents && !(showMeta && s.hasDetails) && !hasDuration) return null;

  const troubled = s.failedTools > 0 || s.failedVerifications > 0;
  const open = userOpen ?? (!settled || troubled);

  const parts: string[] = [];
  if (showMeta && s.model) parts.push(s.model);
  // ADR 0784 — "2 reads · 1 change" where each tool DECLARED its effect; any
  // tool without a known effect stays a neutral "N tools" (never guessed).
  if (s.reads > 0) parts.push(t('receiptReads', { count: s.reads }));
  if (s.writes > 0) parts.push(t('receiptChanges', { count: s.writes }));
  const unknownTools = s.tools - s.reads - s.writes;
  if (unknownTools > 0) parts.push(t('receiptTools', { count: unknownTools }));
  if (s.failedTools > 0) parts.push(t('receiptFailed', { count: s.failedTools }));
  if (s.handoffs > 0) parts.push(t('receiptHandoffs', { count: s.handoffs }));
  // ADR 0768 P3 — reply time from the conversation log's own timestamps; omitted
  // (never estimated) when the turn does not carry it.
  if (hasDuration && message.replyMs !== undefined) parts.push(formatDurationMs(message.replyMs, message.replyMs >= 10_000 ? 0 : 1));
  if (showMeta && s.cost != null) parts.push(formatUsd(s.cost));
  // Decisions / verifications alone still get a visible label — never a bare chevron.
  if (parts.length === 0 && !(showMeta && s.sources > 0)) parts.push(t('receiptDetails'));

  const ev = message.agentEvents;
  return (
    <div className="turn-receipt" data-troubled={troubled ? 'true' : undefined}>
      <Button
        variant="quiet"
        className="turn-receipt-toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={open ? t('receiptHide') : t('receiptShow')}
        onClick={() => setUserOpen(!open)}
      >
        {troubled ? <span className="turn-receipt-dot" aria-hidden="true" /> : null}
        <span className="turn-receipt-parts">
          {parts.map((p, i) => (
            <span key={`${i}-${p}`} className="turn-receipt-part">{p}</span>
          ))}
          {showMeta && s.sources > 0 ? (
            <span className="turn-receipt-part u-iflex u-items-center u-gap-1"><GlobeIcon size={11} /> {t('sources', { count: s.sources })}</span>
          ) : null}
        </span>
        <ChevronDownIcon size={12} className={open ? 'turn-receipt-chevron is-open' : 'turn-receipt-chevron'} />
      </Button>
      {open ? (
        <div id={detailsId} className="turn-receipt-details">
          {ev?.handoffs.map((h, i) => <HandoffIndicator key={`h-${i}-${h.at}`} handoff={h} />)}
          {ev?.toolCalls.map((tc) => {
            const e = effects.get(tc.toolName);
            return (
              <div key={`tc-${tc.callId}`} className="turn-receipt-tool">
                {e ? <span className={`turn-receipt-effect is-${e}`}>{t(e === 'write' ? 'receiptEffectChange' : 'receiptEffectRead')}</span> : null}
                <ToolCallCard call={tc} />
              </div>
            );
          })}
          {ev?.decisions.map((d, i) => <DecisionBadge key={`d-${i}-${d.at}`} decision={d} />)}
          {(ev?.verified ?? []).map((v, i) => <VerificationCard key={`v-${i}-${v.at}`} verified={v} />)}
          {showMeta && s.sources > 0 && workbench ? (
            <Button variant="quiet" className="turn-receipt-sources" onClick={workbench.openSources}>
              <GlobeIcon size={11} /> {t('receiptOpenSources')}
            </Button>
          ) : null}
          {showMeta && (s.model || s.hasTokens) ? (
            <div className="turn-receipt-meta">
              {message.meta?.provider && message.meta?.model ? <span>{message.meta.provider}/{message.meta.model}</span> : null}
              {message.meta?.inputTokens != null ? <span>{t('tokensIn', { count: formatNumber(message.meta.inputTokens) })}</span> : null}
              {message.meta?.outputTokens != null ? <span>{t('tokensOut', { count: formatNumber(message.meta.outputTokens) })}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
