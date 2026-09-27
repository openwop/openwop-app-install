/**
 * Privacy + cookies disclosure. Plain-prose page — no marketing copy, just
 * an honest accounting of what gets stored, where, for how long, and how to
 * delete it.
 *
 * ADR 0196 Phase 4 (DEMO-8): the page FORKS on the host's demo flag.
 *   - Demo host → the full anonymous-session disclosure (the 24h cookie, the
 *     in-memory retention table) — accurate for app.openwop.dev — plus the
 *     signed-in persistence rules (signup shipped; the old "coming soon"
 *     section was stale and is gone).
 *   - Clean / white-label install → a compact enterprise disclosure:
 *     workspace tenancy, signed-in persistence, keys-stay-server-side. It
 *     deliberately makes NO deployment-specific claims (KMS, SQL, log
 *     retention are operator configuration) — operators own those specifics
 *     and should extend this page for their service. See WHITE-LABEL.md.
 *
 * White-label note: the brand-bound tokens (domain, home/repo URLs) read
 * from `brand` so a re-deploy reflects them automatically.
 */
import { Trans, useTranslation } from 'react-i18next';
import { brand } from './brand/brand.js';
import { Notice } from './ui/Notice.js';
import { Skeleton } from './ui/Skeleton.js';
import { useDemoModeStatus } from './client/useDemoMode.js';

export function PrivacyPage() {
  const { t } = useTranslation('chrome');
  const status = useDemoModeStatus();
  // UX-PRIV-1 — don't publish a disclosure derived from a deployment type we
  // haven't established. `unresolved` is a moment, not an answer.
  if (status === 'unresolved') {
    return (
      <section className="privacy-page" aria-labelledby="privacy-heading">
        <div className="surface-card">
          <h1 id="privacy-heading">{t('privacyTitle')}</h1>
          <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="90%" /><Skeleton width="70%" /></div>
        </div>
      </section>
    );
  }
  if (status !== 'demo') {
    return (
      <section className="privacy-page" aria-labelledby="privacy-heading">
        <div className="surface-card">
          <h1 id="privacy-heading">{t('privacyTitle')}</h1>
          {/* UX-PRIV-1 — we fell back to this arm without confirming the
              deployment type, so say so. The clean arm omits the anon-cookie
              section by design; a reader on the demo host would otherwise never
              learn about a cookie they already have. */}
          {status === 'unknown' ? <Notice variant="warning" announce={t('privacyDeploymentUnknown')}>{t('privacyDeploymentUnknown')}</Notice> : null}
          <p className="muted">{t('privacyEnterpriseLede')}</p>

          <h2>{t('privacyEntTenancyHeading')}</h2>
          <p>{t('privacyEntTenancyBody')}</p>

          <h2>{t('privacyEntDataHeading')}</h2>
          <p>{t('privacyEntDataBody')}</p>

          <h2>{t('privacyEntKeysHeading')}</h2>
          <p>{t('privacyEntKeysBody')}</p>

          <h2>{t('privacyEntRetentionHeading')}</h2>
          <p>{t('privacyEntRetentionBody')}</p>

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
        <pre tabIndex={0} aria-label={t('privacyOneCookieHeading')}>
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

        <h2>{t('privacySignedInHeading')}</h2>
        <p>{t('privacySignedInBody')}</p>

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
