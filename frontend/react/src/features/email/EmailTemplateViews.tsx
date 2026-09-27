/**
 * Template Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Email hub's templates collection. The Card fills a `.card-grid`; the
 * Row fills a `.surface-card.list-view`. Both derive their sub-line and format
 * chip from the SAME helpers below, so grid and list never diverge.
 *
 * Both cells are real `<Link>`s to `/email/templates/:templateId` (rule 12), and
 * NEITHER carries a delete control — destructive actions belong to the entity's
 * own surface. See ADR 0520; the Forms cells (ADR 0519) are the reference.
 */

import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { formatRelativeTime, isDatable } from '../../i18n/format.js';
import type { EmailTemplate } from './emailClient.js';

/** The href every cell points at. `?org=` rides along so the editor opens against
 *  the workspace the row was listed under — a shared link that lands on the right
 *  template for the recipient too, not just the sender. */
const templateHref = (tpl: EmailTemplate, orgId: string): string =>
  `/email/templates/${encodeURIComponent(tpl.templateId)}${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`;

/** The contextual one-liner, from REAL stored fields only (rule 6): the subject
 *  line is what a recipient actually sees, so it is the honest sub-line. */
export function templateSubLine(tpl: EmailTemplate, t: TFunction): string {
  return tpl.subject.trim() || t('subNoSubject');
}

function TemplateChips({ tpl, t }: { tpl: EmailTemplate; t: TFunction }): JSX.Element | null {
  // 'text' is the default and absent-format back-compat value — chipping the
  // common case would be noise, so only markdown announces itself.
  return (tpl.format ?? 'text') === 'markdown'
    ? <span className="chip chip--muted">{t('formatMarkdown')}</span>
    : null;
}

/** Compact, store-backed timestamp (rule 10). Renders NOTHING when the store
 *  can't date it — the row must not claim a time it doesn't have, and passing an
 *  unparseable value to `formatRelativeTime` throws and blanks the page. */
function TemplateUpdated({ tpl, t }: { tpl: EmailTemplate; t: TFunction }): JSX.Element | null {
  if (!isDatable(tpl.updatedAt)) return null;
  return <span title={tpl.updatedAt}>{t('subUpdated', { when: formatRelativeTime(tpl.updatedAt) })}</span>;
}

export function TemplateCard({ template: tpl, orgId }: { template: EmailTemplate; orgId: string }): JSX.Element {
  const { t } = useTranslation('email');
  return (
    <Link to={templateHref(tpl, orgId)} className="surface-card u-flex u-flex-col u-gap-2">
      <strong className="u-fs-14">{tpl.name}</strong>
      <span className="muted u-fs-13">{templateSubLine(tpl, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <TemplateChips tpl={tpl} t={t} />
      </div>
      <span className="muted u-fs-12"><TemplateUpdated tpl={tpl} t={t} /></span>
    </Link>
  );
}

export function TemplateRow({ template: tpl, orgId }: { template: EmailTemplate; orgId: string }): JSX.Element {
  const { t } = useTranslation('email');
  const href = templateHref(tpl, orgId);
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openTemplate', { name: tpl.name })}>
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{tpl.name}</span>
          </span>
          <span className="list-row-sub">{templateSubLine(tpl, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <TemplateChips tpl={tpl} t={t} />
        <TemplateUpdated tpl={tpl} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('openTemplateAction')}</Link>
      </div>
    </div>
  );
}
