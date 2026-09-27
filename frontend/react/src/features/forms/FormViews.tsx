/**
 * Form Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Forms page. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their status chip, destination chips,
 * and sub-line from the SAME helpers below, so grid and list never diverge (the
 * `primaryAction`/`subLine` precedent on `/agents`).
 *
 * Both cells are real `<Link>`s to `/forms/:formId` (rule 12) — cmd/middle-click
 * and "copy link address" work, which an `onClick` selector button never gave.
 * NEITHER carries a delete control: destructive actions belong to the entity's
 * own surface, not to a collection cell (rule 12), so Delete lives on the detail
 * page next to the thing it destroys.
 */

import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { ClipboardIcon } from '../../ui/icons/index.js';
import { formatRelativeTime, isDatable } from '../../i18n/format.js';
import type { FormDef } from './formsClient.js';

/** Semantic status chip per DESIGN.md §5.1 — the localized `status_*` label
 *  rides along, so color is never the sole signal. */
export const statusChipClass = (s: FormDef['status']): string =>
  s === 'published' ? 'chip chip--success' : 'chip chip--muted';

/** The href every cell points at. `?org=` rides along so the detail page opens
 *  against the workspace the row was listed under — a shared link that lands on
 *  the right form for the recipient too, not just the sender. */
export const formHref = (f: FormDef, orgId: string): string =>
  `/forms/${encodeURIComponent(f.formId)}${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`;

/** The contextual one-liner, composed from REAL stored fields only (rule 6) —
 *  the field count plus where submissions actually go. No fabricated counts:
 *  `FormDef` carries no submission total, so the cell never claims one. */
function formSubLine(f: FormDef, t: TFunction): string {
  const parts = [t('subFieldCount', { count: f.fields.length })];
  if (f.createToContact) parts.push(t('subToContact'));
  if (f.intakeBinding) parts.push(t('subToIntake'));
  return parts.join(' · ');
}

function FormChips({ f, t }: { f: FormDef; t: TFunction }): JSX.Element {
  return (
    <>
      <span className={statusChipClass(f.status)}>{t(`status_${f.status}`)}</span>
      {f.emailOptInField ? <span className="chip chip--muted">{t('subEmailOptIn')}</span> : null}
    </>
  );
}

/** Compact, store-backed timestamp (rule 10). Renders NOTHING when the store
 *  can't date it — the cell must not claim a time it doesn't have, and passing an
 *  unparseable value to `formatRelativeTime` throws and blanks the page. */
function FormUpdated({ f, t }: { f: FormDef; t: TFunction }): JSX.Element | null {
  if (!isDatable(f.updatedAt)) return null;
  return (
    <span title={f.updatedAt}>{t('subUpdated', { when: formatRelativeTime(f.updatedAt) })}</span>
  );
}

export function FormCard({ form: f, orgId }: { form: FormDef; orgId: string }): JSX.Element {
  const { t } = useTranslation('forms');
  return (
    <Link to={formHref(f, orgId)} className="surface-card u-flex u-flex-col u-gap-2">
      <span className="u-flex u-items-center u-gap-2">
        <ClipboardIcon size={16} aria-hidden /> <strong className="u-fs-14">{f.title}</strong>
      </span>
      <span className="muted u-fs-13">{formSubLine(f, t)}</span>
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <FormChips f={f} t={t} />
      </div>
      <span className="muted u-fs-12"><FormUpdated f={f} t={t} /></span>
    </Link>
  );
}

export function FormRow({ form: f, orgId }: { form: FormDef; orgId: string }): JSX.Element {
  const { t } = useTranslation('forms');
  const href = formHref(f, orgId);
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openForm', { name: f.title })}>
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{f.title}</span>
          </span>
          <span className="list-row-sub">{formSubLine(f, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <FormChips f={f} t={t} />
        <FormUpdated f={f} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('openFormAction')}</Link>
      </div>
    </div>
  );
}
