/**
 * The review step before Publish, Approve or Submit (ADR 0828 phase 3): what
 * blocks publishing, what is worth fixing, and what already passed. Each
 * finding can take the person to the section or the Page tab that fixes it.
 *
 * Blockers stop Publish and Approve. Submit stays available with blockers,
 * because a reviewer can help finish the page; the dialog says so.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { AlertIcon, CheckIcon } from '../../ui/icons/index.js';
import { sectionLabel } from './sectionLabel.js';
import type { Page, WorkflowAction } from './cmsClient.js';
import type { PublishCheck } from './publishChecks.js';

export function PublishChecklist({ page, action, checks, busy, onConfirm, onFix, onClose }: {
  page: Page;
  action: WorkflowAction;
  checks: readonly PublishCheck[];
  busy: boolean;
  onConfirm: () => void;
  /** Go to where a finding is fixed: a section, or the Page tab. */
  onFix: (check: PublishCheck) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const blocks = checks.filter((c) => c.level === 'block');
  const warns = checks.filter((c) => c.level === 'warn');
  const oks = checks.filter((c) => c.level === 'ok');
  const goesLive = action === 'publish' || action === 'approve';
  const blocked = goesLive && blocks.length > 0;
  const label = (c: PublishCheck): string => {
    const s = c.sectionId ? page.sections.find((x) => x.sectionId === c.sectionId) : undefined;
    const where = s ? sectionLabel(s) || t(`sectionType_${s.type}`, { defaultValue: s.type }) : '';
    return t(c.key, { ...(c.values ?? {}), section: where });
  };
  const row = (c: PublishCheck): JSX.Element => (
    <li key={c.id} className="cms-check-row" data-level={c.level}>
      <span className="cms-check-icon" aria-hidden="true">{c.level === 'ok' ? <CheckIcon size={14} /> : <AlertIcon size={14} />}</span>
      <span className="u-flex-1">{label(c)}</span>
      {c.fixOn ? (
        <Button variant="secondary" size="sm" aria-label={t('checkShowMeAria', { finding: label(c) })} onClick={() => onFix(c)}>{t('checkShowMe')}</Button>
      ) : null}
    </li>
  );
  const confirmLabel = blocked
    ? t('checkFixFirst', { count: blocks.length })
    : t(`action_${action}`, { defaultValue: action });

  return (
    <Modal onClose={onClose} label={t('checkTitle')} className="hire-modal cms-checklist" showClose describedBy="cms-check-lede">
      <div className="u-grid u-gap-3">
        <div className="u-grid u-gap-1">
          <h2 className="u-fs-16 u-m-0">{t('checkTitle')}</h2>
          <p id="cms-check-lede" className="u-label-sm u-m-0">
            {blocks.length === 0 && warns.length === 0
              ? t('checkAllClear')
              : goesLive ? t('checkLedeLive', { blocks: blocks.length, warns: warns.length }) : t('checkLedeSubmit', { blocks: blocks.length, warns: warns.length })}
          </p>
        </div>
        {blocks.length > 0 ? (
          <section className="u-grid u-gap-1" aria-labelledby="cms-check-blocks">
            <h3 id="cms-check-blocks" className="u-fs-14 u-m-0">{t('checkBlocksHeading', { count: blocks.length })}</h3>
            <ul className="cms-check-list">{blocks.map(row)}</ul>
          </section>
        ) : null}
        {warns.length > 0 ? (
          <section className="u-grid u-gap-1" aria-labelledby="cms-check-warns">
            <h3 id="cms-check-warns" className="u-fs-14 u-m-0">{t('checkWarnsHeading', { count: warns.length })}</h3>
            <ul className="cms-check-list">{warns.map(row)}</ul>
          </section>
        ) : null}
        {oks.length > 0 ? (
          <section className="u-grid u-gap-1" aria-labelledby="cms-check-oks">
            <h3 id="cms-check-oks" className="u-fs-14 u-m-0">{t('checkOksHeading')}</h3>
            <ul className="cms-check-list">{oks.map(row)}</ul>
          </section>
        ) : null}
        <div className="action-bar">
          <span className="u-flex-1" />
          <Button variant="quiet" onClick={onClose}>{t('checkCancel')}</Button>
          <Button variant="primary" disabled={blocked || busy} aria-busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
