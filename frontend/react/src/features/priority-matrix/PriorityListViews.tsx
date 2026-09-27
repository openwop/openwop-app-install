/**
 * Priority-list Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Priority Matrix portfolio. The Card fills a `.card-grid`;
 * the Row fills a `.surface-card.list-view`. Both derive their chips from the
 * SAME helper below (`PriorityListChips`), so the grid and list views never
 * diverge (the StrategyViews / ProjectViews precedent). Cells are real links —
 * every list has its own URL (`/priority-matrix/:listId`).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ListOrderedIcon, BookOpenIcon } from '../../ui/icons/index.js';
import type { PriorityList } from './priorityMatrixClient.js';
import { MODEL_LABEL_KEY } from './pmShared.js';

export type CellProps = {
  l: PriorityList;
  /** Resolved project name when the list is project-scoped (absent ⇒ raw marker). */
  projectName?: string;
  kbEnabled: boolean;
};

const listHref = (l: PriorityList): string => `/priority-matrix/${encodeURIComponent(l.id)}`;

function modelLabel(l: PriorityList, t: TFunction): string {
  const k = (MODEL_LABEL_KEY as Record<string, string>)[l.criteriaSet.presetId ?? ''];
  return k ? t(k) : t('modelCustom');
}

/** The full chip set — scoring model, voting mode, project scope / KB-index
 *  state. Shared by Card + Row so the two views carry identical metadata. */
export function PriorityListChips({ l, projectName, kbEnabled, t }: CellProps & { t: TFunction }): JSX.Element {
  return (
    <>
      <span className="chip chip--muted">{modelLabel(l, t)}</span>
      <span className="chip chip--muted">{l.votingMode === 'multi-voter' ? t('chipMultiVoter', { aggregation: l.voteAggregation }) : t('chipSingleScore')}</span>
      {l.projectId
        ? <span className="chip chip--accent">{projectName ?? t('scopeProject')}</span>
        : (kbEnabled ? <span className="chip chip--muted" title={t('indexedForAgentsTitle')}><BookOpenIcon size={11} aria-hidden /> {t('indexedForAgents')}</span> : null)}
    </>
  );
}

/** The contextual one-liner from REAL fields — the list's scope. */
function subLine(l: PriorityList, projectName: string | undefined, t: TFunction): string {
  return l.projectId ? (projectName ?? t('scopeProject')) : t('workspaceWide');
}

export function PriorityListCard({ l, projectName, kbEnabled }: CellProps): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  return (
    <Link to={listHref(l)} className="surface-card u-text-left" title={t('openList', { name: l.name })}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-fs-14 u-fw-600 u-m-0">{l.name}</h3>
        <ListOrderedIcon size={14} aria-hidden />
      </div>
      <p className="muted u-fs-13 u-mt-2 u-mb-2">{subLine(l, projectName, t)}</p>
      <div className="u-flex u-gap-2 u-flex-wrap u-mt-2">
        <PriorityListChips l={l} {...(projectName ? { projectName } : {})} kbEnabled={kbEnabled} t={t} />
      </div>
    </Link>
  );
}

export function PriorityListRow({ l, projectName, kbEnabled }: CellProps): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const href = listHref(l);
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openList', { name: l.name })}>
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{l.name}</span>
          </span>
          <span className="list-row-sub">{subLine(l, projectName, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <PriorityListChips l={l} {...(projectName ? { projectName } : {})} kbEnabled={kbEnabled} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('openListAction')}</Link>
      </div>
    </div>
  );
}
