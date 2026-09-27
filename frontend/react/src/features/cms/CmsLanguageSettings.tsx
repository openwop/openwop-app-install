/**
 * CMS content language settings (ADR 0064 / RFC 0103). Per-org config of the
 * authored content locales: the base locale (read-only — the host default), the
 * supported translations (chips, base ∉ supported enforced server-side), and the
 * auto-translate-on-publish hint. Writes require the `cms-localization` toggle +
 * the admin tier; a disabled toggle surfaces a friendly notice (the PUT 404s).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { CheckboxField } from '../../ui/Field.js';
import { GlobeIcon, PlusIcon, XIcon } from '../../ui/icons/index.js';
import { listMembers, type OrgMember } from '../../client/accessClient.js';
import { UserPicker } from '../../orgs/UserPicker.js';
import { cmsErrorInfo, getLanguageSettings, listLocaleGrants, putLanguageSettings, putLocaleGrant, type CmsLocaleGrant, type LanguageSettings } from './cmsClient.js';

import { canonicalContentLocale } from './contentLocale.js';

function localeLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function CmsLanguageSettings({ orgId, onChange }: {
  orgId: string;
  /** Notify the parent when the locale set changes (so the editor's tabs refresh). */
  onChange?: (settings: LanguageSettings) => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const [settings, setSettings] = useState<LanguageSettings | null>(null);
  const [newLocale, setNewLocale] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Inline, beside the input it is about (was a page-top Notice, far from the field).
  const [tagError, setTagError] = useState<string | null>(null);
  // Per-instance ids — a literal id collides when the panel mounts twice.
  const tagErrId = `${useId()}-tag-err`;
  const tagHintId = `${tagErrId}-hint`;
  const [busy, setBusy] = useState(false);
  // Translator grants (ADR 0205 D1) — null while unloaded; [] also covers the
  // non-admin case (the list route is admin-tier and 403s).
  const [grants, setGrants] = useState<CmsLocaleGrant[] | null>(null);
  const [grantSubject, setGrantSubject] = useState('');
  const [grantLocales, setGrantLocales] = useState('');
  // CMSGAP-7 — the grant picker offers the org's principal-bound members
  // instead of a raw subject-id input (falls back to the input when the
  // members list is unavailable).
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  // Hold onChange in a ref so the load effect depends only on orgId, without
  // re-firing when the parent passes a fresh callback identity each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    // `live` — a settle after unmount (or an org switch) must not write state:
    // the post-teardown setState was an intermittent unhandled-error in the
    // vitest lane (jsdom torn down under a late .catch), and in the app it is
    // the same stale-write family as everywhere else.
    let live = true;
    setSettings(null); setError(null); setGrants(null);
    setSettingsError(null); setGrantsError(null);
    void getLanguageSettings(orgId)
      .then((s) => { if (!live) return; setSettings(s); onChangeRef.current?.(s); })
      // Leaving `settings` null rendered "Loading languages…" FOREVER — a panel
      // reporting a request that had already failed as still in flight.
      .catch((e) => { if (live) setSettingsError(e instanceof Error ? e.message : String(e)); });
    // Admin-tier list. `null` now means 403 (not permitted) and ONLY that, so the
    // panel still hides for a non-admin; any other failure is reported instead of
    // being shown as the same absence.
    void listLocaleGrants(orgId)
      .then((g) => { if (live) setGrants(g); })
      .catch((e) => { if (live) setGrantsError(e instanceof Error ? e.message : String(e)); });
    void listMembers(orgId).then((m) => { if (live) setMembers(m.filter((x) => !!x.subject)); }).catch(() => { if (live) setMembers([]); });
    return () => { live = false; };
  }, [orgId]);

  // ADR 0592 §6 (CMSLU-7) — map known backend error CODES to localized copy
  // (the toggle-off 404 by `details.feature`, grant denials by
  // `details.grantedLocales`) and demote to the raw message only when no
  // mapping exists. The old `/not enabled/i` ENGLISH regex broke the moment
  // the envelope localized — match on code, never on prose.
  const errMsg = useCallback((e: unknown): string => {
    const info = cmsErrorInfo(e);
    if (info) return t(info.key, { ...(info.options ?? {}), defaultValue: t('langSaveFailed') });
    return e instanceof Error && e.message ? e.message : t('langSaveFailed');
  }, [t]);

  const saveGrant = useCallback(async (subject: string, locales: string[]) => {
    setBusy(true); setError(null);
    try {
      await putLocaleGrant(orgId, subject, locales);
      setGrants(await listLocaleGrants(orgId));
      setGrantSubject(''); setGrantLocales('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [orgId, errMsg]);

  const persist = useCallback(async (patch: { supportedLocales?: string[]; autoTranslateOnPublish?: boolean }) => {
    setBusy(true); setError(null);
    try {
      const saved = await putLanguageSettings(orgId, patch);
      setSettings(saved);
      onChangeRef.current?.(saved);
    } catch (e) {
      // The PUT 404s when the cms-localization toggle is off for this tenant.
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [orgId, errMsg]);

  if (settingsError) {
    return <Notice variant="error">{t('langLoadFailed', { error: settingsError })}</Notice>;
  }
  if (!settings) return <span className="u-label-sm">{t('langLoading')}</span>;

  const addLocale = (): void => {
    const loc = canonicalContentLocale(newLocale);
    if (loc === null) { setTagError(t('langEnterTag')); return; }
    if (loc === settings.baseLocale || settings.supportedLocales.includes(loc)) { setTagError(t('langAlreadyConfigured', { loc })); return; }
    setTagError(null);
    setNewLocale('');
    void persist({ supportedLocales: [...settings.supportedLocales, loc] });
  };

  return (
    <div className="u-grid u-gap-2">
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="u-flex u-gap-1 u-items-center">
        <span className="u-label-sm">{t('langBaseLocale')}</span>
        <span className="chip"><GlobeIcon /> {localeLabel(settings.baseLocale)} <code>{settings.baseLocale}</code></span>
        <span className="u-label-sm">{t('langBaseLocaleHint')}</span>
      </div>

      <div className="u-grid u-gap-1">
        <span className="u-label-sm">{t('langTranslationsLabel')}</span>
        {settings.supportedLocales.length === 0 ? (
          <span className="u-label-sm">{t('langNoTranslations')}</span>
        ) : (
          <div className="u-flex u-gap-1 u-wrap">
            {settings.supportedLocales.map((loc) => (
              <span key={loc} className="chip">
                {localeLabel(loc)} <code>{loc}</code>
                <Button
                  variant="quiet" className="u-w-auto"
                  aria-label={t('langRemoveLocale', { loc })}
                  disabled={busy}
                  onClick={() => void persist({ supportedLocales: settings.supportedLocales.filter((l) => l !== loc) })}
                ><XIcon /></Button>
              </span>
            ))}
          </div>
        )}
        <div className="u-flex u-gap-1">
          <input
            value={newLocale}
            onChange={(e) => { setNewLocale(e.target.value); setTagError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLocale(); } }}
            placeholder={t('langNewLocalePlaceholder')}
            aria-label={t('langNewLocaleAria')}
            aria-invalid={tagError ? true : undefined}
            aria-describedby={tagError ? tagErrId : tagHintId}
            className="u-w-auto"
          />
          <Button variant="quiet" className="u-w-auto" disabled={busy || newLocale.trim().length === 0} onClick={addLocale}><PlusIcon /> {t('langAdd')}</Button>
        </div>
        {tagError
          ? <span id={tagErrId} className="field-error" role="alert">{tagError}</span>
          : <span id={tagHintId} className="u-label-sm muted">{t('langTagHint')}</span>}
      </div>

      <CheckboxField
        label={t('langAutoTranslate')}
        checked={settings.autoTranslateOnPublish}
        disabled={busy}
        onChange={(e) => void persist({ autoTranslateOnPublish: e.target.checked })}
      />

      {/* Translator grants (ADR 0205 D1) — admin-only list (403 ⇒ hidden). */}
      {grantsError ? <Notice variant="error">{t('langGrantsFailed', { error: grantsError })}</Notice> : null}
      {grants !== null && settings.supportedLocales.length > 0 ? (
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('grantsLabel')}</span>
          <span className="u-label-sm">{t('grantsLede')}</span>
          {grants.map((g) => (
            <div key={g.subject} className="u-flex u-gap-1 u-items-center u-wrap">
              <span className="u-label-sm">{members.find((m) => m.subject === g.subject)?.displayName ?? g.subject}</span>
              {g.locales.map((l) => <span key={l} className="chip">{l}</span>)}
              <Button
                variant="quiet" className="u-w-auto"
                aria-label={t('grantRemoveAria', { subject: g.subject })}
                disabled={busy}
                onClick={() => void saveGrant(g.subject, [])}
              ><XIcon /> {t('grantRemove')}</Button>
            </div>
          ))}
          <div className="u-flex u-gap-1 u-wrap">
            <UserPicker
              members={members}
              value={grantSubject}
              onChange={setGrantSubject}
              ariaLabel={t('grantMemberAria')}
              emptyLabel={t('grantMemberPlaceholder')}
              className="u-w-auto"
            />
            <input value={grantLocales} onChange={(e) => setGrantLocales(e.target.value)} placeholder={t('grantLocalesPlaceholder')} aria-label={t('grantLocalesPlaceholder')} className="u-w-auto" />
            <Button
              variant="quiet" className="u-w-auto"
              disabled={busy || !grantSubject.trim() || !grantLocales.trim()}
              onClick={() => {
                // ADR 0592 §9 (CMSLU-15) — validate against the CONFIGURED set
                // before the write: a grant for an unconfigured locale is a
                // de-facto lockout (the server now 400s too; this is the same
                // rule, earlier and localized).
                const locales = grantLocales.split(',').map((l) => l.trim()).filter(Boolean);
                const unsupported = locales.filter((l) => !settings.supportedLocales.includes(l));
                if (unsupported.length > 0) {
                  setError(t('grantUnsupportedLocales', { locales: unsupported.join(', ') }));
                  return;
                }
                void saveGrant(grantSubject.trim(), locales);
              }}
            ><PlusIcon /> {t('grantAdd')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
