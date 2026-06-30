/**
 * HITL Decision Card — persistent record of a human-in-the-loop
 * resolution that stays in the chat thread.
 *
 * Replaces the interactive ApprovalCard / ClarificationDialog /
 * RefinementForm / CancellationBanner once an interrupt resolves.
 * The card is non-interactive — it's audit history, not a re-do
 * affordance. Survives page reload because it derives from the
 * workflow_run message's `interruptHistory` field (a render-time
 * index of SSE events; the BE event log remains source of truth).
 *
 * Architecture decision: derive, don't persist (Option B in the
 * architect review). The decision card mirrors what the event log
 * already carries — `node.completed` at the interrupt's nodeId, with
 * `payload.outputs.output` as the resumeValue. We just present it.
 */

import { useTranslation } from 'react-i18next';
import { BanIcon, CheckIcon, XIcon } from '../ui/icons/index.js';
import { isRecord } from './lib/typeGuards.js';
import type { InterruptHistoryEntry } from './types.js';
import { formatNumber, formatDate } from '../i18n/format.js';
import i18n from '../i18n/index.js';

interface Props {
  entry: InterruptHistoryEntry;
  /** Friendly gate name (builder label, e.g. "Legal review"). When present it
   *  titles the row instead of the raw `approval_3` node id, which still shows
   *  as a muted code chip in the meta line for traceability. */
  nodeName?: string;
}

type IconKind = 'check' | 'x' | 'ban';

const KIND_VERB: Record<string, string> = {
  approval: 'Approved',
  clarification: 'Clarified',
  refinement: 'Refined',
  cancellation: 'Confirmed cancellation',
  'external-event': 'Received',
};

const KIND_ICON: Record<string, IconKind> = {
  approval: 'check',
  clarification: 'check',
  refinement: 'check',
  cancellation: 'ban',
  'external-event': 'check',
};

const KIND_COLOR: Record<string, string> = {
  approval: 'var(--color-success)',
  clarification: 'var(--color-accent)',
  refinement: 'var(--color-accent)',
  cancellation: 'var(--color-text-muted)',
  'external-event': 'var(--color-accent)',
};

function StatusIcon({ kind, color }: { kind: IconKind; color: string }): JSX.Element {
  const style = { color };
  if (kind === 'check') return <CheckIcon size={14} style={style} />;
  if (kind === 'x') return <XIcon size={14} style={style} />;
  return <BanIcon size={14} style={style} />;
}

export function HitlDecisionCard({ entry, nodeName }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const verb = KIND_VERB[entry.kind] ?? 'Resolved';
  const icon = KIND_ICON[entry.kind] ?? 'check';
  const color = KIND_COLOR[entry.kind] ?? 'var(--color-success)';

  // Surface the user's choice when the resumeValue has the canonical
  // approval shape (`{action, content, selectedKey?, comment?}`).
  // Falls back to a JSON preview for unknown shapes — defensive per
  // the type-guard pattern from the architect review.
  const { decisionLabel, comment, rejected } = parseResumeValue(entry.resumeValue);

  // Approval card sends `action: 'reject'` for the reject button;
  // we surface that distinctly so the user sees they rejected, not
  // "Approved" (which would be misleading).
  const effectiveVerb = rejected ? 'Rejected' : verb;
  const effectiveIcon: IconKind = rejected ? 'x' : icon;
  const effectiveColor = rejected ? 'var(--color-danger)' : color;

  // ARIA landmark label so screen-reader users can navigate the row
  // as a single coherent unit ("HITL decision: Approved Legal review")
  // rather than reading each chunk independently. Prefer the friendly gate
  // name; fall back to the user's pick, then to the verb alone.
  const ariaLabel = (nodeName ?? decisionLabel)
    ? t('hitlDecisionAriaWithLabel', { verb: effectiveVerb, label: nodeName ?? decisionLabel })
    : t('hitlDecisionAria', { verb: effectiveVerb });

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      className="hitl-card"
      style={{
        background: `color-mix(in oklch, ${effectiveColor} 7%, transparent)`,
        border: `1px solid color-mix(in oklch, ${effectiveColor} 26%, var(--color-border))`,
        // Signature: a status-colored left accent bar — reads the outcome
        // (approved / rejected / cancelled) at a glance, and pairs the color cue
        // with a line-weight cue (thicker on reject) for high-contrast users.
        borderInlineStartWidth: rejected ? '4px' : '3px',
        borderInlineStartColor: effectiveColor,
      }}
    >
      <div className="hitl-card__row">
        <span
          className="hitl-card__status"
          style={{ color: effectiveColor, background: `color-mix(in oklch, ${effectiveColor} 15%, transparent)` }}
        >
          <StatusIcon kind={effectiveIcon} color={effectiveColor} /> {effectiveVerb}
        </span>
        {nodeName && <span className="hitl-card__gate">{nodeName}</span>}
        {decisionLabel && <span className="hitl-card__pick muted">{decisionLabel}</span>}
        {entry.resolvedAt && <span className="hitl-card__time muted">{formatRelative(entry.resolvedAt)}</span>}
      </div>
      {comment && <div className="muted hitl-comment">“{comment}”</div>}
    </div>
  );
}

/**
 * Pull a human-readable label + the audit comment out of an arbitrary
 * resumeValue. Handles the canonical approval shape from
 * `chat/registry/defaultCards.tsx`'s ApprovalCard:
 *   `{ action: 'approve' | 'reject', selectedKey?: string, comment?: string }`
 * Plus clarification ({content, comment?}) and refinement ({content}).
 * Unknown shapes degrade to no label (the verb alone is informative).
 */
function parseResumeValue(value: unknown): {
  decisionLabel: string | null;
  comment: string | null;
  rejected: boolean;
} {
  if (!isRecord(value)) {
    return { decisionLabel: null, comment: null, rejected: false };
  }
  const rejected = value.action === 'reject';
  const selectedKey = typeof value.selectedKey === 'string' ? value.selectedKey : null;
  const content = typeof value.content === 'string' ? value.content : null;
  const comment = typeof value.comment === 'string' && value.comment.length > 0 ? value.comment : null;

  // Approval: prefer the user's pick (e.g., "Clarity critic") over the
  // raw `content`, which is the nested-key value the FE walked the
  // resumeSchema to find. Clarification / refinement: surface the
  // typed `content` as the label.
  const decisionLabel = selectedKey ?? content ?? null;

  return { decisionLabel, comment, rejected };
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(then)) return iso;
  const m = Math.floor(diffMs / 60_000);
  const h = Math.floor(diffMs / 3_600_000);
  const d = Math.floor(diffMs / 86_400_000);
  if (m < 1) return i18n.t('chat:justNow');
  if (m < 60) return i18n.t('chat:minutesAgo', { count: formatNumber(m) });
  if (h < 24) return i18n.t('chat:hoursAgo', { count: formatNumber(h) });
  if (d < 7) return i18n.t('chat:daysAgo', { count: formatNumber(d) });
  return formatDate(new Date(iso));
}
