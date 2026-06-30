/**
 * Publish-to-registry checklist banner. Extracted from BuilderShell.tsx
 * (pure extraction — no behavior change). Renders the inline checklist
 * for the PR-based registry submission flow.
 */

import { useTranslation } from 'react-i18next';
import { formatBytes } from '../i18n/format.js';

interface PublishHelp {
  slug: string;
  size: number;
  manifestJson: string;
}

interface PublishHelpBannerProps {
  publishHelp: PublishHelp;
  onClose(): void;
}

export function PublishHelpBanner({ publishHelp, onClose }: PublishHelpBannerProps) {
  const { t } = useTranslation('builder');
  return (
    <div
      className="alert alert--publish builder-toolbar-error"
      role="status"
      aria-live="polite"
    >
      <strong>{t('publishHeading', { slug: publishHelp.slug })}</strong>
      <p className="muted publishhelp-intro">
        {t('publishIntro', { size: formatBytes(publishHelp.size) })}
      </p>
      <ol className="publishhelp-steps">
        <li>
          <button
            type="button"
            className="linklike"
            onClick={() => {
              const blob = new Blob([publishHelp.manifestJson], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${publishHelp.slug}.manifest.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
          >
            {t('publishStepDownload')}
          </button>{' '}
          {t('publishStepDownloadNote', { slug: publishHelp.slug, placeholder: '{{params.*}}' })}
        </li>
        <li>
          {t('publishStepForkPre')}{' '}
          <a href="https://github.com/openwop/openwop" target="_blank" rel="noreferrer">openwop/openwop</a>{' '}
          {t('publishStepForkMid')}{' '}
          <code>registry/packs/{publishHelp.slug}/manifest.json</code>{' '}
          {t('publishStepForkSee')}{' '}
          <a href="https://github.com/openwop/openwop/tree/main/registry/packs" target="_blank" rel="noreferrer">
            {t('publishStepForkLink')}
          </a>{' '}
          {t('publishStepForkPost')}
        </li>
        <li>
          {t('publishStepValidatePre')} <code>npm run openwop:check</code> {t('publishStepValidatePost')}
        </li>
        <li>
          {t('publishStepPrPre')}{' '}
          <a href="https://packs.openwop.dev" target="_blank" rel="noreferrer">packs.openwop.dev</a>.
        </li>
      </ol>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>{t('common:close')}</button>
      </div>
    </div>
  );
}
