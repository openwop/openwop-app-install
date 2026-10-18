/**
 * Per-node credential picker. Renders a dropdown of stored credentialRefs
 * (filtered to the refs that name an optional provider) plus a "Manage keys" link
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
import { refNamesProvider } from '../../byok/lib/credentialRef.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';

interface Props {
  /** Associates the control with ConfigInput's <label htmlFor> (A11Y-3). */
  id?: string | undefined;
  value: string | undefined;
  onChange(next: string | undefined): void;
  /** When set, shows only the refs that NAME this provider, by the backend's rule:
   *  `openai`, `openai:prod`, `openai-work` and the BYOK wizard's `byok:openai`. */
  providerFilter?: string | undefined;
  required?: boolean | undefined;
}

export function CredentialPickerInput({ value, onChange, providerFilter, required, id }: Props): JSX.Element {
  const { t } = useTranslation('builder');
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  // EMPTY-ON-FAIL-1 (ADR 0779 D7) — a failed read is NOT "no keys stored". The
  // catch used to set `refs` to [] and render the "No keys stored yet — manage keys
  // to add" alert, with the real error demoted to a muted footnote. `error` is now
  // the failed state, checked BEFORE loading and empty.
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listStoredRefs()
      .then((list) => { if (!cancelled) { setRefs(list); setError(null); } })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const visible = (refs ?? []).filter((r) => {
    if (!providerFilter) return true;
    // CRED-PICKER-REF-1: a `<provider>:` prefix test hid the wizard's `byok:<provider>`
    // key and `<provider>-<label>` keys, then said none were stored (the KEYS-REF-1
    // rule, which the Keys page already dropped).
    return refNamesProvider(r, providerFilter);
  });

  if (error !== null) {
    return (
      <Notice variant="error">
        <div className="u-fs-12">
          {t('credentialsLoadFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={() => { setError(null); setRefs(null); setAttempt((n) => n + 1); }}>
            {t('common:retry')}
          </Button>
          <div className="muted u-fs-11">{error}</div>
        </div>
      </Notice>
    );
  }
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
      </div>
    );
  }

  return (
    <div className="u-flex u-gap-1-5 u-items-center">
      <select
        {...(id ? { id } : {})}
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
