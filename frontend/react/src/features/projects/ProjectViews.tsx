/**
 * Project Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Projects page. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their status chips + sub-line from the
 * SAME helpers below, so the grid and list views never diverge (the
 * `primaryAction`/`subLine` precedent on `/agents`). Composed from existing
 * primitives — no bespoke CSS.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { FolderIcon } from '../../ui/icons/index.js';
import type { Project, ProjectStatus, ProjectHealth } from './projectsClient.js';

// Status/health are project lifecycle markers, not run-states — but the §5.3
// chip families read naturally here (text label + tone, so colour is never the
// sole signal): paused→warning, off-track→danger, active/on-track→success.
const STATUS_CHIP: Record<ProjectStatus, string> = {
  planning: 'chip--muted',
  active: 'chip--success',
  paused: 'chip--warning',
  done: 'chip--muted',
  archived: 'chip--muted',
};
const STATUS_KEY: Record<ProjectStatus, string> = {
  planning: 'statusPlanning',
  active: 'statusActive',
  paused: 'statusPaused',
  done: 'statusDone',
  archived: 'statusArchived',
};
const HEALTH_CHIP: Record<ProjectHealth, string> = {
  'on-track': 'chip--success',
  'at-risk': 'chip--warning',
  'off-track': 'chip--danger',
};
const HEALTH_KEY: Record<ProjectHealth, string> = {
  'on-track': 'healthOnTrack',
  'at-risk': 'healthAtRisk',
  'off-track': 'healthOffTrack',
};

/** The contextual one-liner from REAL fields — the charter goal/brief, else a
 *  no-charter fallback. Shared by Card + Row. */
export function projectSubLine(p: Project, t: TFunction): string {
  return p.charter?.goal || p.charter?.brief || t('subNoCharter');
}

function ProjectChips({ p, t }: { p: Project; t: TFunction }): JSX.Element {
  const status = p.charter?.status;
  const health = p.charter?.health;
  return (
    <>
      {status ? <span className={`chip ${STATUS_CHIP[status]}`}>{t(STATUS_KEY[status])}</span> : null}
      {health ? <span className={`chip ${HEALTH_CHIP[health]}`}>{t(HEALTH_KEY[health])}</span> : null}
      {p.visibility === 'private' ? <span className="chip chip--muted">{t('visibilityPrivate')}</span> : null}
    </>
  );
}

function ProjectCounts({ p, t }: { p: Project; t: TFunction }): JSX.Element {
  return (
    <>
      <span>{t('workflowCount', { count: p.workflows.length })}</span>
      {p.members && p.members.length > 0 ? <span>{t('memberCount', { count: p.members.length })}</span> : null}
    </>
  );
}

export function ProjectCard({ project: p }: { project: Project }): JSX.Element {
  const { t } = useTranslation('projects');
  return (
    <Link to={`/projects/${encodeURIComponent(p.id)}`} className="surface-card u-flex u-flex-col u-gap-2">
      <span className="u-flex u-items-center u-gap-2">
        <FolderIcon size={16} aria-hidden /> <strong className="u-fs-14">{p.name}</strong>
      </span>
      <span className="muted u-fs-13">{projectSubLine(p, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <ProjectChips p={p} t={t} />
      </div>
      <span className="muted u-fs-12 u-flex u-gap-3 u-wrap">
        <ProjectCounts p={p} t={t} />
      </span>
    </Link>
  );
}

export function ProjectRow({ project: p }: { project: Project }): JSX.Element {
  const { t } = useTranslation('projects');
  const href = `/projects/${encodeURIComponent(p.id)}`;
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openProject', { name: p.name })}>
        <FolderIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{p.name}</span>
          </span>
          <span className="list-row-sub">{projectSubLine(p, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <ProjectChips p={p} t={t} />
        <ProjectCounts p={p} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="secondary btn-sm">{t('openProjectAction')}</Link>
      </div>
    </div>
  );
}
