/**
 * Per-node credential picker. Renders a dropdown of stored credentialRefs
 * (filtered by an optional `<provider>:` prefix) plus a "Manage keys" link
 * that opens the /keys page in a new tab.
 *
 * The empty/no-keys state surfaces a clear CTA so the user understands
 * they need to register a key first — better than rendering a disabled
 * dropdown with no hint why.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listStoredRefs } from '../../byok/lib/byokClient.js';

interface Props {
  value: string | undefined;
  onChange(next: string | undefined): void;
  /** When set, filters the picker to refs starting with `<providerFilter>:`. */
  providerFilter?: string | undefined;
  required?: boolean | undefined;
}

export function CredentialPickerInput({ value, onChange, providerFilter, required }: Props): JSX.Element {
  const { t } = useTranslation('builder');
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listStoredRefs()
      .then((list) => { if (!cancelled) setRefs(list); })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setRefs([]);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const visible = (refs ?? []).filter((r) => {
    if (!providerFilter) return true;
    return r.startsWith(`${providerFilter}:`) || r === providerFilter;
  });

  if (refs === null) {
    return <div className="muted u-fs-12">{t('loadingCredentials')}</div>;
  }
  if (visible.length === 0) {
    return (
      <div>
        <div className="alert info u-fs-12 u-pad-6x10">
          {t('noKeysStored', { provider: providerFilter ? `${providerFilter} ` : '' })}{' '}
          <Link to="/keys" target="_blank" rel="noopener noreferrer">{t('manageKeys')}</Link> {t('manageKeysToAdd')}
        </div>
        {error && <div className="muted u-fs-11">{error}</div>}
      </div>
    );
  }

  return (
    <div className="u-flex u-gap-1-5 u-items-center">
      <select
        value={value ?? ''}
        required={required}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="u-flex-1"
      >
        <option value="">{required ? t('pickKey') : t('noneOption')}</option>
        {visible.map((ref) => (
          <option key={ref} value={ref}>{ref}</option>
        ))}
      </select>
      <Link
        to="/keys"
        target="_blank"
        rel="noopener noreferrer"
        className="muted u-fs-11 u-nowrap"
        title={t('manageTitle')}
      >
        {t('manage')}
      </Link>
    </div>
  );
}
