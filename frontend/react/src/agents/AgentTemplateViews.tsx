/**
 * Agent-template Card + shared Signals — the grid cell of the §4.5 collection-view
 * canon for the Agent Templates LIBRARY (`/agents/templates`, System A).
 *
 * The page's `<ViewToggle>` switches between the sortable `<DataTable>` (`list`)
 * and a `.card-grid` of `<AgentTemplateCard>` (`grid`). Both the card and the
 * table's Signals column render `<TemplateSignals>` from the SAME `AgentEntry`
 * fields, so the two views never diverge (the `*Views.tsx` precedent —
 * AdvisoryBoardViews, KbViews). Composes existing primitives only
 * (`.surface-card`, `.card-grid`, `.chip`, `u-*` utilities) — no new CSS, so the
 * token/spacing-literal gates stay green.
 */

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AgentEntry } from '../client/agentsClient.js';
import { slugify } from './agentUi.js';
import { formatNumber } from '../i18n/format.js';

/** Degraded / handoff / confidence chips — shared by the card and the table's
 *  Signals column so grid and list stay in lockstep. Renders nothing when a
 *  template has no signals (avoids a phantom grid-gap row in the card). */
export function TemplateSignals({ agent: a }: { agent: AgentEntry }): JSX.Element | null {
  const { t } = useTranslation('agents');
  const degradedCount = a.degraded?.length ?? 0;
  if (degradedCount === 0 && !a.hasHandoffSchemas && a.confidenceThreshold === undefined) return null;
  return (
    <div className="u-flex u-gap-2 u-wrap u-items-center">
      {degradedCount > 0 ? (
        <span className="chip chip--warning" title={t('templatesDegradedTitle', { count: degradedCount })}>
          {t('templatesDegraded', { count: degradedCount })}
        </span>
      ) : null}
      {a.hasHandoffSchemas ? <span className="chip chip--muted">{t('templatesHandoff')}</span> : null}
      {a.confidenceThreshold !== undefined ? (
        <span className="chip chip--muted">
          {t('templatesConfidence', { value: formatNumber(a.confidenceThreshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}
        </span>
      ) : null}
    </div>
  );
}

/** One installed template as a profile card. The whole card is the link to the
 *  detail route — the same target as the list row's `onRowClick`. */
export function AgentTemplateCard({ agent: a }: { agent: AgentEntry }): JSX.Element {
  const { t } = useTranslation('agents');
  const toolCount = a.toolAllowlist.length;
  return (
    <Link
      to={`/agents/templates/${encodeURIComponent(a.agentId)}`}
      className="surface-card u-grid u-gap-2"
    >
      <div className="u-flex u-items-baseline u-gap-3 u-wrap">
        <strong className="u-fs-14">{a.label || a.persona}</strong>
        <code className="muted u-fs-11">@{slugify(a.persona)}</code>
        <span className="chip chip--muted u-ml-auto">{a.modelClass}</span>
      </div>
      {a.description ? <p className="muted u-fs-12 u-m-0 u-clamp-2">{a.description}</p> : null}
      <TemplateSignals agent={a} />
      <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-11 muted">
        <code className="u-fs-11">{a.packName}@{a.packVersion}</code>
        <span className="u-ml-auto">
          {toolCount > 0 ? t('templatesToolsCount', { count: toolCount }) : t('templatesNoTools')}
        </span>
      </div>
    </Link>
  );
}
