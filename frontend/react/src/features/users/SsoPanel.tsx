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
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { InlineState } from '../../ui/InlineState.js';
import { config } from '../../client/config.js';
import { clearCapabilitiesCache, getCapabilities } from '../../client/runsClient.js';

interface Caps { auth?: { profiles?: string[] } }

const ACS_PATH = '/host/openwop-app/auth/saml/validate';
const SCIM_PATH = '/host/openwop-app/auth/scim/provision';

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
  /** The capability read failed. Distinct from `profiles === []` (the host really
   *  advertises neither profile) — that difference decides whether this panel may
   *  say "Not configured" and offer setup instructions. */
  const [capsFailed, setCapsFailed] = useState(false);
  // USERS-UX-4 (retry half) — bumping re-runs the capability read, so a failed
  // read is recoverable in place instead of demanding a full page reload.
  const [attempt, setAttempt] = useState(0);
  const origin = config.baseUrl.replace(/\/$/, '');

  useEffect(() => {
    let cancelled = false;
    // `getCapabilities()` (client/runsClient.ts), NOT a raw fetch — the shared
    // owner of this read, with a 300s cache, in-flight dedupe and a clear()-race
    // guard. This file hand-rolled its own and so never inherited any of it.
    //
    // THE FABRICATION GUARD IS PRESERVED, and it is why this matters. A non-ok
    // response used to be REWRITTEN into `{ auth: { profiles: [] } }` — an
    // outright fabrication, not merely a swallowed error — rendering SAML/SCIM as
    // "Not configured" plus setup instructions, telling an enterprise admin their
    // SSO was off when it may be advertised and working. That bug had to be found
    // and fixed HERE, in the duplicate, because the shared client's error handling
    // never applied to it. `getCapabilities()` REJECTS on a failed read, so the
    // catch below still distinguishes "failed" from "advertises neither".
    // `as Promise<Caps>` follows CapabilitiesPanel.tsx:150 — the SDK's
    // `Capabilities` type does not declare `auth`, and this is how the other
    // consumers of this same client narrow it.
    void (getCapabilities() as Promise<Caps>)
      .then((c) => { if (!cancelled) { setProfiles(c.auth?.profiles ?? []); setCapsFailed(false); } })
      .catch(() => { if (!cancelled) { setCapsFailed(true); setProfiles(null); } });
    return () => { cancelled = true; };
  }, [attempt]);

  // CLEAR THE CACHE FIRST. Against a 300s TTL a retry would otherwise re-read the
  // same cached answer and look like a no-op — the one way adopting the shared
  // client could have made this surface WORSE. (A failed read caches nothing, so
  // this matters for the admin who fixes their SAML config and retries, not for
  // the transient-failure case.)
  const retryCaps = (): void => { clearCapabilitiesCache(); setCapsFailed(false); setProfiles(null); setAttempt((a) => a + 1); };

  const has = (p: string) => (profiles ?? []).includes(p);
  const saml = has('openwop-auth-saml');
  const scim = has('openwop-auth-scim');

  return (
    <div className="surface-card u-p-4 u-grid u-gap-4">
      <div className="u-grid u-gap-1">
        <strong>{t('ssoTitle')}</strong>
        <span className="muted">{t('ssoLede')}</span>
      </div>

      {capsFailed ? (
        // USERS-UX-4 — the shared <Notice> primitive with an explicit
        // `announce` (a hand-rolled region born WITH its text announces
        // nothing), plus a retry so the failure is actionable.
        <Notice variant="error" announce={t('ssoCapsFailed')}>
          <span className="u-grid u-gap-2">
            {t('ssoCapsFailed')}
            <span>
              <Button variant="secondary" size="sm" onClick={retryCaps}>{t('common:retry')}</Button>
            </span>
          </span>
        </Notice>
      ) : profiles === null ? (
        // USERS-UX-18 — the designed loading state (skeleton + sr-only text),
        // not a bare muted sentence.
        <InlineState kind="loading" message={t('ssoReadingCaps')} />
      ) : (
        <div className="u-grid u-gap-2">
          <Row name={t('ssoOidcName')} detail={t('ssoOidcDetail')} on onLabel={t('ssoActive')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoPasswordName')} detail={t('ssoPasswordDetail')} on onLabel={t('ssoActive')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoSamlName')} detail={t('ssoSamlDetail')} on={saml} onLabel={t('ssoAdvertised')} offLabel={t('ssoNotConfigured')} />
          <Row name={t('ssoScimName')} detail={t('ssoScimDetail')} on={scim} onLabel={t('ssoAdvertised')} offLabel={t('ssoNotConfigured')} />
        </div>
      )}

      {/* USERS-UX-5 — these are name/value display rows, not form fields: a
          <label> wrapping a non-form <code> is semantically wrong (nothing to
          focus, nothing labelled). Plain grouping elements instead. */}
      <div className="u-grid u-gap-2">
        <span className="u-label-sm">{t('ssoEndpointsLabel')}</span>
        <div className="u-grid u-gap-1">
          <span className="muted">{t('ssoSamlAcs')}</span>
          <code className="mfa-secret">{origin}{ACS_PATH}</code>
        </div>
        <div className="u-grid u-gap-1">
          <span className="muted">{t('ssoScimProvisioning')}</span>
          <code className="mfa-secret">{origin}{SCIM_PATH}</code>
        </div>
      </div>

      {!capsFailed && !saml && !scim ? (
        // USERS-UX-4 — shared <Notice> (static informational copy: no announce
        // needed; it renders with the panel, it does not "appear").
        <Notice variant="info">
          <Trans t={t} i18nKey="ssoNotEnabled" components={[<code key="saml" />, <code key="scim" />]} />
        </Notice>
      ) : null}
    </div>
  );
}
