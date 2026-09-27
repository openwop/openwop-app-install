/**
 * ADR 0363 P2 — the shared accessibility-issues panel. Renders the result of
 * {@link checkContentA11y} for any authored surface (document-editor, CMS,
 * app-builder). Body-only: the host owns the mount (a Modal, a canvas panel, a
 * detail column). Composed from `ui/` primitives — Notice for the clean state,
 * chips (color-never-alone: the severity/WCAG labels carry the meaning) for tags.
 */

import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import type { A11yIssue } from './contentA11y.js';

export function A11yIssuesPanel({ issues }: { issues: A11yIssue[] | null }): JSX.Element | null {
  const { t } = useTranslation('a11y');
  if (issues === null) return null; // not checked yet — host decides the prompt
  if (issues.length === 0) return <Notice variant="success">{t('panelNone')}</Notice>;

  return (
    <div className="u-grid u-gap-2" role="group" aria-label={t('panelTitle')}>
      <p className="u-label-sm u-text-muted">{t('panelSummary', { count: issues.length })}</p>
      <ul className="u-grid u-gap-2 u-list-none u-p-0">
        {issues.map((iss) => (
          <li key={iss.id} className="surface-card u-p-2 u-flex u-gap-2 u-items-start">
            <span className={`chip ${iss.severity === 'error' ? 'chip--danger' : 'chip--warning'}`}>
              {iss.severity === 'error' ? t('severityError') : t('severityWarning')}
            </span>
            <span className="chip chip--muted">WCAG {iss.wcag}</span>
            <span className="u-flex-1">{t(iss.messageKey, iss.params ?? {})}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
