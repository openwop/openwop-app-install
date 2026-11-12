/**
 * ADR 0363 P2 — the shared accessibility-issues panel. Renders the result of
 * {@link checkContentA11y} for any authored surface (document-editor, CMS,
 * app-builder). Body-only: the host owns the mount (a Modal, a canvas panel, a
 * detail column). Composed from `ui/` primitives — Notice for the clean state,
 * chips (color-never-alone: the severity/WCAG labels carry the meaning) for tags.
 *
 * ADR 1100 D3 — `describeRef` names where an issue is (e.g. "Section 3:
 * Columns") from its `nodeRef`; with `onLocate` the location is a button that
 * takes the author there. A ref the host cannot describe shows no location.
 */

import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import type { A11yIssue } from './contentA11y.js';

export function A11yIssuesPanel({ issues, describeRef, onLocate, incomplete }: {
  issues: A11yIssue[] | null;
  /** Set when part of the content could not be checked: shown as a warning, and
   *  an empty result is then never presented as an all-clear (ADR 1100 D3). */
  incomplete?: string | undefined;
  describeRef?: (nodeRef: string) => string | undefined;
  onLocate?: (nodeRef: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation('a11y');
  if (issues === null) return null; // not checked yet — host decides the prompt
  const warning = incomplete ? <Notice variant="warning">{incomplete}</Notice> : null;
  if (issues.length === 0) return warning ?? <Notice variant="success">{t('panelNone')}</Notice>;

  return (
    <div className="u-grid u-gap-2" role="group" aria-label={t('panelTitle')}>
      {warning}
      <p className="u-label-sm u-text-muted">{t('panelSummary', { count: issues.length })}</p>
      <ul className="u-grid u-gap-2 u-list-none u-p-0">
        {issues.map((iss) => {
          const ref = iss.nodeRef;
          const where = ref ? describeRef?.(ref) : undefined;
          return (
            <li key={iss.id} className="surface-card u-p-2 u-flex u-gap-2 u-items-start">
              <span className={`chip ${iss.severity === 'error' ? 'chip--danger' : 'chip--warning'}`}>
                {iss.severity === 'error' ? t('severityError') : t('severityWarning')}
              </span>
              <span className="chip chip--muted">WCAG {iss.wcag}</span>
              <span className="u-flex-1 u-grid u-gap-1">
                <span>{t(iss.messageKey, iss.params ?? {})}</span>
                {where && ref ? (
                  onLocate ? (
                    <span>
                      <Button variant="quiet" size="sm" className="u-w-auto" aria-label={t('goToSection', { where })} onClick={() => onLocate(ref)}>
                        {where}
                      </Button>
                    </span>
                  ) : (
                    <span className="u-label-sm u-text-muted"><span className="sr-only">{t('issueLocationLabel')} </span>{where}</span>
                  )
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
