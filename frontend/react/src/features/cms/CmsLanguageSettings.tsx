/**
 * CMS content language settings (ADR 0064 / RFC 0103). Per-org config of the
 * authored content locales: the base locale (read-only — the host default), the
 * supported translations (chips, base ∉ supported enforced server-side), and the
 * auto-translate-on-publish hint. Writes require the `cms-localization` toggle +
 * the admin tier; a disabled toggle surfaces a friendly notice (the PUT 404s).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { GlobeIcon, PlusIcon, XIcon } from '../../ui/icons/index.js';
import { getLanguageSettings, putLanguageSettings, type LanguageSettings } from './cmsClient.js';

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

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
  const [busy, setBusy] = useState(false);
  // Hold onChange in a ref so the load effect depends only on orgId, without
  // re-firing when the parent passes a fresh callback identity each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setSettings(null); setError(null);
    void getLanguageSettings(orgId).then((s) => { setSettings(s); onChangeRef.current?.(s); }).catch(() => setSettings(null));
  }, [orgId]);

  const persist = useCallback(async (patch: { supportedLocales?: string[]; autoTranslateOnPublish?: boolean }) => {
    setBusy(true); setError(null);
    try {
      const saved = await putLanguageSettings(orgId, patch);
      setSettings(saved);
      onChangeRef.current?.(saved);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('langSaveFailed');
      // The PUT 404s when the cms-localization toggle is off for this tenant.
      setError(/not enabled/i.test(msg) ? t('langNotEnabled') : msg);
    } finally {
      setBusy(false);
    }
  }, [orgId, t]);

  if (!settings) return <span className="u-label-sm">{t('langLoading')}</span>;

  const addLocale = (): void => {
    const loc = newLocale.trim();
    if (!LOCALE_RE.test(loc)) { setError(t('langEnterTag')); return; }
    if (loc === settings.baseLocale || settings.supportedLocales.includes(loc)) { setError(t('langAlreadyConfigured', { loc })); return; }
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
                <button
                  type="button"
                  className="btn-ghost u-w-auto"
                  aria-label={t('langRemoveLocale', { loc })}
                  disabled={busy}
                  onClick={() => void persist({ supportedLocales: settings.supportedLocales.filter((l) => l !== loc) })}
                ><XIcon /></button>
              </span>
            ))}
          </div>
        )}
        <div className="u-flex u-gap-1">
          <input
            value={newLocale}
            onChange={(e) => setNewLocale(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLocale(); } }}
            placeholder={t('langNewLocalePlaceholder')}
            aria-label={t('langNewLocaleAria')}
            className="u-w-auto"
          />
          <button type="button" className="btn-ghost u-w-auto" disabled={busy || newLocale.trim().length === 0} onClick={addLocale}><PlusIcon /> {t('langAdd')}</button>
        </div>
      </div>

      <label className="u-flex u-gap-1 u-items-center">
        <input
          type="checkbox"
          checked={settings.autoTranslateOnPublish}
          disabled={busy}
          onChange={(e) => void persist({ autoTranslateOnPublish: e.target.checked })}
        />
        <span className="u-label-sm">{t('langAutoTranslate')}</span>
      </label>
    </div>
  );
}
