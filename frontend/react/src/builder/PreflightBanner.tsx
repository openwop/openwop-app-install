/**
 * Pre-flight warning banner — host-capability + engine-limit breaches
 * found on a Run/Validate click. Extracted from BuilderShell.tsx (pure
 * extraction — no behavior change).
 */

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBuilderStore } from './store/builderStore.js';
import type { PreflightIssue, LimitIssue } from './builderShellHelpers.js';

interface PreflightBannerProps {
  preflight: { caps: PreflightIssue[]; limits: LimitIssue[] };
  onCancel(): void;
  onRunAnyway(): void;
}

export function PreflightBanner({ preflight, onCancel, onRunAnyway }: PreflightBannerProps) {
  const { t } = useTranslation('builder');
  return (
    <div className="alert warning builder-toolbar-error">
      {preflight.caps.length > 0 && (
        <>
          <strong>
            {t('preflightCapsHeading', { count: preflight.caps.length })}
          </strong>{' '}
          {t('preflightCapsIntro', { count: preflight.caps.length })}{' '}
          <code>HOST_CAPABILITY_MISSING</code>:
          <ul className="preflight-issue-list">
            {preflight.caps.map((i) => (
              <li key={i.nodeId}>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => useBuilderStore.getState().selectNode(i.nodeId)}
                >
                  {i.name}
                </button>{' '}
                {t('preflightNodeNeeds')} <code>{i.missing.join(', ')}</code>
              </li>
            ))}
          </ul>
          {/* ADR 0163 Phase 5 — guide setup instead of a dead end. */}
          <Link to="/connections" className="linklike">{t('configureConnectionsCta')}</Link>
        </>
      )}
      {preflight.limits.length > 0 && (
        <>
          <strong>
            {t('preflightLimitsHeading', { count: preflight.limits.length })}
          </strong>
          <ul className="preflight-issue-list">
            {preflight.limits.map((i) => (
              <li key={i.kind}>{i.message}</li>
            ))}
          </ul>
        </>
      )}
      <div className="button-row">
        <button type="button" className="secondary" onClick={onCancel}>{t('common:cancel')}</button>
        <button type="button" onClick={onRunAnyway}>{t('runAnyway')}</button>
      </div>
    </div>
  );
}
