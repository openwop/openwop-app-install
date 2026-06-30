/**
 * SsoPanel — Enterprise SSO (SAML 2.0) + SCIM provisioning status, mapped onto
 * openwop's ACTUAL architecture (RFC 0050 / ADR 0002). Unlike a consumer
 * "sign in with Okta" flow, openwop's SAML + SCIM are HOST seams: the host
 * validates SAML assertions at its ACS and provisions users via SCIM, advertised
 * honestly in `/.well-known/openwop` `auth.profiles` ONLY when the seam is
 * configured + behaviorally honored (it never claims a profile it can't back).
 *
 * This panel reads the live capabilities and shows which auth profiles the host
 * advertises + the enterprise integration endpoints — the white-label/B2B story,
 * not a demo login button.
 */
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { config, authedHeaders, fetchOpts } from '../../client/config.js';

interface Caps { auth?: { profiles?: string[] } }

const ACS_PATH = '/v1/host/openwop-app/auth/saml/validate';
const SCIM_PATH = '/v1/host/openwop-app/auth/scim/provision';

function Row({ name, detail, on, onLabel, offLabel }: {
  name: string; detail: string; on: boolean; onLabel: string; offLabel: string;
}): JSX.Element {
  return (
    <div className="sso-row">
      <div className="u-grid u-gap-1">
        <strong>{name}</strong>
        <span className="muted">{detail}</span>
      </div>
      <span className={`chip ${on ? 'chip--success' : 'chip--muted'}`}>{on ? onLabel : offLabel}</span>
    </div>
  );
}

export function SsoPanel(): JSX.Element {
  const { t } = useTranslation('users');
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const origin = config.baseUrl.replace(/\/$/, '');

  useEffect(() => {
    let cancelled = false;
    void fetch(`${config.baseUrl}/.well-known/openwop`, fetchOpts({ headers: authedHeaders() }))
      .then((r) => (r.ok ? r.json() : { auth: { profiles: [] } }))
      .then((c: Caps) => { if (!cancelled) setProfiles(c.auth?.profiles ?? []); })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  const has = (p: string) => (profiles ?? []).includes(p);
  const saml = has('openwop-auth-saml');
  const scim = has('openwop-auth-scim');

  return (
    <div className="surface-card u-p-4 u-grid u-gap-4">
      <div className="u-grid u-gap-1">
        <strong>{t('ssoTitle')}</strong>
        <span className="muted">{t('ssoLede')}</span>
      </div>

      {profiles === null ? (
        <div className="muted">{t('ssoReadingCaps')}</div>
      ) : (
        <div className="u-grid u-gap-2">
          <Row name={t('ssoOidcName')} detail={t('ssoOidcDetail')} on onLabel={t('ssoActive')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoPasswordName')} detail={t('ssoPasswordDetail')} on onLabel={t('ssoActive')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoSamlName')} detail={t('ssoSamlDetail')} on={saml} onLabel={t('ssoAdvertised')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoScimName')} detail={t('ssoScimDetail')} on={scim} onLabel={t('ssoAdvertised')} offLabel={t('ssoNotConfigured')} />
        </div>
      )}

      <div className="u-grid u-gap-2">
        <span className="u-label-sm">{t('ssoEndpointsLabel')}</span>
        <label className="u-grid u-gap-1">
          <span className="muted">{t('ssoSamlAcs')}</span>
          <code className="mfa-secret">{origin}{ACS_PATH}</code>
        </label>
        <label className="u-grid u-gap-1">
          <span className="muted">{t('ssoScimProvisioning')}</span>
          <code className="mfa-secret">{origin}{SCIM_PATH}</code>
        </label>
      </div>

      {!saml && !scim ? (
        <div className="alert info" role="status">
          <Trans t={t} i18nKey="ssoNotEnabled" components={[<code key="saml" />, <code key="scim" />]} />
        </div>
      ) : null}
    </div>
  );
}
