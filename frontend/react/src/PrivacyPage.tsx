/**
 * Privacy + cookies disclosure for the public app.openwop.dev demo.
 * Plain-prose page — no marketing copy, just an honest accounting of
 * what gets stored, where, for how long, and how to delete it.
 *
 * Linked from the InMemoryHostBanner. If/when Phase 3 (Firebase Auth +
 * persistent Cloud SQL backend) lands, this page expands with the
 * signed-in retention rules.
 *
 * White-label note: the brand-bound tokens (domain, home/repo URLs) read
 * from `brand` so a re-deploy reflects them automatically. The legal/
 * operational specifics below (cookie name, Cloud Run, retention windows,
 * the steward contact) are deployment-specific — adopters should review
 * and rewrite this page for their own service. See WHITE-LABEL.md.
 */
import { Trans, useTranslation } from 'react-i18next';
import { brand } from './brand/brand.js';

export function PrivacyPage() {
  const { t } = useTranslation('chrome');
  return (
    <section className="privacy-page" aria-labelledby="privacy-heading">
      <div className="surface-card">
        <h1 id="privacy-heading">{t('privacyTitle')}</h1>
        <p className="muted">
          <Trans
            t={t}
            i18nKey="privacyLastUpdated"
            values={{ domain: brand.primaryDomain }}
            components={{ 0: <code /> }}
          />
        </p>

        <h2>{t('privacyOneCookieHeading')}</h2>
        <p>{t('privacyOneCookieBody')}</p>
        <pre>
{`Name:    openwop.session
Domain:  ${brand.primaryDomain}
Path:    /
Max-Age: 86400 seconds (24 hours)
Flags:   HttpOnly; Secure; SameSite=Lax`}
        </pre>
        <p>
          <Trans
            t={t}
            i18nKey="privacyCookiePayload"
            values={{ payload: '{ sid, tenantId: "anon:<sid>", tier: "anon", iat, exp }' }}
            components={{ 0: <code />, 1: <code /> }}
          />
        </p>

        <h2>{t('privacyStoreHeading')}</h2>
        <table className="cap-table">
          <thead>
            <tr><th>{t('privacyColData')}</th><th>{t('privacyColWhere')}</th><th>{t('privacyColRetention')}</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('privacyRowWorkflowsData')}</td>
              <td>{t('privacyRowWorkflowsWhere')}</td>
              <td>{t('privacyRowWorkflowsRetention')}</td>
            </tr>
            <tr>
              <td>{t('privacyRowByokData')}</td>
              <td>{t('privacyRowByokWhere')}</td>
              <td>{t('privacyRowByokRetention')}</td>
            </tr>
            <tr>
              <td>{t('privacyRowRunsData')}</td>
              <td>{t('privacyRowRunsWhere')}</td>
              <td>{t('privacyRowRunsRetention')}</td>
            </tr>
            <tr>
              <td><Trans t={t} i18nKey="privacyRowCookieData" components={{ 0: <code /> }} /></td>
              <td>{t('privacyRowCookieWhere')}</td>
              <td>{t('privacyRowCookieRetention')}</td>
            </tr>
          </tbody>
        </table>

        <h2>{t('privacyNotDoHeading')}</h2>
        <ul>
          <li>{t('privacyNotDo1')}</li>
          <li>{t('privacyNotDo2')}</li>
          <li>{t('privacyNotDo3')}</li>
          <li>{t('privacyNotDo4')}</li>
          <li>{t('privacyNotDo5')}</li>
          <li>{t('privacyNotDo6')}</li>
        </ul>

        <h2>{t('privacyOutboundHeading')}</h2>
        <p>
          <Trans
            t={t}
            i18nKey="privacyOutboundBody"
            components={{ 0: <code />, 1: <code />, 2: <code />, 3: <code /> }}
          />
        </p>

        <h2>{t('privacyLogsHeading')}</h2>
        <p>
          <Trans
            t={t}
            i18nKey="privacyLogsBody"
            components={{ 0: <code />, 1: <code />, 2: <code />, 3: <code /> }}
          />
        </p>

        <h2>{t('privacyDeleteHeading')}</h2>
        <ol>
          <li><Trans t={t} i18nKey="privacyDeleteStep1" values={{ domain: brand.primaryDomain }} components={{ 0: <code /> }} /></li>
          <li>{t('privacyDeleteStep2')}</li>
        </ol>

        <h2>{t('privacyComingHeading')}</h2>
        <p>{t('privacyComingBody')}</p>

        <h2>{t('privacyContactHeading')}</h2>
        <p>
          <Trans
            t={t}
            i18nKey="privacyContactBody"
            values={{
              home: brand.homeUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
              repo: brand.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, ''),
            }}
            components={{
              0: <a href={brand.homeUrl} className="inline-link" target="_blank" rel="noopener" />,
              1: <code />,
              2: <a href={brand.repoUrl} className="inline-link" target="_blank" rel="noopener" />,
            }}
          />
        </p>
      </div>
    </section>
  );
}
