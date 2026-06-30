/**
 * Task source chip — where a Kanban card came from (PRD §8 source taxonomy).
 *
 * Accessibility: each source has a distinct glyph AND text label, so the
 * source is never conveyed by color alone (PRD §20).
 */

import type { ComponentType, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { BotIcon, ClockIcon, MessageCircleIcon, PlugIcon, UserIcon, WorkflowIcon } from '../ui/icons/index.js';
import type { KanbanCardSource } from '../kanban/kanbanClient.js';

type IconCmp = ComponentType<{ size?: number; strokeWidth?: number; style?: CSSProperties }>;

// Each source maps to a Lucide icon + label-key + a token-driven `.chip--*` variant
// (no hardcoded hex; chips theme across surfaces). Color is never the sole
// signal — the icon + label carry the meaning (PRD §20).
const SOURCE_META: Record<KanbanCardSource, { labelKey: string; Icon: IconCmp; chip: string }> = {
  human: { labelKey: 'sourceHuman', Icon: UserIcon, chip: 'chip--muted' },
  workflow: { labelKey: 'sourceWorkflow', Icon: WorkflowIcon, chip: 'chip--accent' },
  agent: { labelKey: 'sourceAgent', Icon: BotIcon, chip: 'chip--ai' },
  discord: { labelKey: 'sourceDiscord', Icon: MessageCircleIcon, chip: 'chip--ai' },
  schedule: { labelKey: 'sourceSchedule', Icon: ClockIcon, chip: 'chip--warning' },
  api: { labelKey: 'sourceApi', Icon: PlugIcon, chip: 'chip--success' },
};

export function TaskSourceChip({ source, sourceLabel }: { source?: KanbanCardSource | undefined; sourceLabel?: string | undefined }): JSX.Element {
  const { t } = useTranslation('agents');
  const meta = SOURCE_META[source ?? 'human'];
  const { Icon } = meta;
  const label = t(meta.labelKey);
  const title = sourceLabel ? t('sourceTitleWithLabel', { type: label, label: sourceLabel }) : t('sourceTitleCreatedBy', { type: label });
  // The chip always names the source TYPE (e.g. "Discord"); the specific origin
  // (e.g. "#support-inbox") rides alongside as secondary muted text so the
  // category is never buried in the detail.
  return (
    <>
      <span className={`chip ${meta.chip}`} title={title}>
        <Icon size={12} />
        <span>{label}</span>
      </span>
      {sourceLabel ? <span className="muted u-fs-12">{sourceLabel}</span> : null}
    </>
  );
}
