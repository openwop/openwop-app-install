import { useTranslation } from 'react-i18next';
import { GlobeIcon } from '../ui/icons/index.js';
import { PREVIEW_ENABLED, PREVIEW_LOCALES, SUPPORTED_LOCALES } from './locales.js';
import { setLocale } from './index.js';
import { PSEUDO_LOCALE, PSEUDO_LOCALE_ENABLED } from './pseudo.js';

/**
 * LanguageSwitcher — the user-facing UI-locale control (ADR 0065). Lists every
 * declared locale by its own native name (`Intl.DisplayNames`), plus any preview
 * locales (drafted, pending review) and the pseudo-locale when QA mode is on.
 *
 * Renders nothing at a single declared locale — so an English-only app ships it
 * invisibly, and it appears the moment a second locale is declared. It controls
 * the *interface* language; content language is negotiated server-side (ADR 0064).
 */
export function LanguageSwitcher(): JSX.Element | null {
  const { t, i18n } = useTranslation();

  const previewLocales = PREVIEW_ENABLED ? (PREVIEW_LOCALES as readonly string[]) : [];
  const options: string[] = [
    ...SUPPORTED_LOCALES,
    ...previewLocales,
    ...(PSEUDO_LOCALE_ENABLED ? [PSEUDO_LOCALE] : []),
  ];
  if (options.length < 2) return null;

  const label = t('common:language');
  const displayName = (locale: string): string => {
    if (locale === PSEUDO_LOCALE) return 'Pseudo (QA)';
    try {
      const raw = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
      // Intl renders each language's endonym in its own casing — fr/es/pt are
      // lowercase ("français", "español", "português (Brasil)"). Capitalize the
      // first letter for a consistent, title-cased switcher list.
      const name = raw.charAt(0).toLocaleUpperCase(locale) + raw.slice(1);
      return previewLocales.includes(locale) ? `${name} (preview)` : name;
    } catch {
      return locale;
    }
  };

  return (
    <label className="language-switcher" title={label}>
      <GlobeIcon size={14} aria-hidden />
      <select value={i18n.language} onChange={(e) => setLocale(e.target.value)} aria-label={label}>
        {options.map((locale) => (
          <option key={locale} value={locale}>{displayName(locale)}</option>
        ))}
      </select>
    </label>
  );
}
