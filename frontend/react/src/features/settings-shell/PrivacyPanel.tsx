/**
 * Privacy panel (ADR 0396 P4) — the thin per-user opt-out layer (analytics /
 * crash reports / recent-files), server-authoritative. Org/cookie-layer
 * consent stays with the `consent` feature (composed, not moved).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { getPrefs, putPrefs, type PrivacyPrefs } from '../../client/settingsClient.js';

const KEYS: Array<keyof PrivacyPrefs> = ['analyticsOptOut', 'crashReportsOptOut', 'recentFilesOptOut'];

export function PrivacyPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [privacy, setPrivacy] = useState<PrivacyPrefs | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPrefs()
      .then((p) => { setPrivacy(p.privacy ?? {}); setLoaded(true); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoaded(true); });
  }, []);

  const onToggle = async (key: keyof PrivacyPrefs): Promise<void> => {
    // GRADE-UX 2026-07-17 — optimistic update with ROLLBACK on save failure.
    const prev = privacy;
    const next = { ...(privacy ?? {}), [key]: !(privacy?.[key] === true) };
    setPrivacy(next);
    setBusy(true); setError(null);
    try {
      await putPrefs({ privacy: next });
      toast.success(t('privacySaved'));
    } catch (e) {
      setPrivacy(prev);
      setError(e instanceof Error ? e.message : t('privacySaveFailed'));
    } finally { setBusy(false); }
  };

  if (!loaded) return <StateCard loading title={t('loading')} />;
  if (error && privacy === null) return <StateCard announce title={t('loadFailed')} body={error} />;

  return (
    <div className="u-grid u-gap-3">
      <p>{t('privacyHint')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {KEYS.map((key) => (
        <label key={key} className="action-bar">
          <input type="checkbox" checked={privacy?.[key] === true} disabled={busy} onChange={() => void onToggle(key)} />
          {t(`privacy_${key}`)}
        </label>
      ))}
    </div>
  );
}
