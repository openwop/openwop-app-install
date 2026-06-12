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
import { config, authedHeaders, fetchOpts } from '../../client/config.js';

interface Caps { auth?: { profiles?: string[] } }

const ACS_PATH = '/v1/host/sample/auth/saml/validate';
const SCIM_PATH = '/v1/host/sample/auth/scim/provision';

function Row({ name, detail, on, onLabel = 'Advertised', offLabel = 'Not configured' }: {
  name: string; detail: string; on: boolean; onLabel?: string; offLabel?: string;
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
        <strong>Enterprise SSO &amp; provisioning</strong>
        <span className="muted">
          SAML 2.0 single sign-on and SCIM 2.0 provisioning (RFC 0050). Host seams for
          white-label / B2B deployments — advertised only when configured + honored.
        </span>
      </div>

      {profiles === null ? (
        <div className="muted">Reading host capabilities…</div>
      ) : (
        <div className="u-grid u-gap-2">
          <Row name="OIDC (Google / GitHub)" detail="Firebase-brokered bearer — the demo's primary sign-in." on onLabel="Active" />
          <Row name="Email &amp; password" detail="Local accounts with TOTP MFA (this app, when the Users feature is on)." on onLabel="Active" />
          <Row name="SAML 2.0 SSO" detail="The host validates IdP assertions at its ACS (Okta / Azure AD / Ping…)." on={saml} />
          <Row name="SCIM 2.0 provisioning" detail="The IdP create/deactivates users + assigns groups via SCIM." on={scim} />
        </div>
      )}

      <div className="u-grid u-gap-2">
        <span className="u-label-sm">Enterprise integration endpoints (point your IdP here)</span>
        <label className="u-grid u-gap-1">
          <span className="muted">SAML ACS</span>
          <code className="mfa-secret">{origin}{ACS_PATH}</code>
        </label>
        <label className="u-grid u-gap-1">
          <span className="muted">SCIM provisioning</span>
          <code className="mfa-secret">{origin}{SCIM_PATH}</code>
        </label>
      </div>

      {!saml && !scim ? (
        <div className="alert info" role="status">
          Not enabled on this deployment. A white-label host turns these on by configuring an
          IdP certificate / SCIM bearer (see ADR 0002 / RFC 0050); the host then advertises the
          <code> openwop-auth-saml</code> / <code>openwop-auth-scim</code> profiles above.
        </div>
      ) : null}
    </div>
  );
}
