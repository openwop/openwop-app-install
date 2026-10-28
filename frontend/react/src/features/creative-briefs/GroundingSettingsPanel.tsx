/**
 * ADR 0945 Q1 — the client's edit-mode opt-in. Edit mode repaints the pixels
 * around the client's real product, so it is OFF per client until an admin of
 * that client turns it on (the server refuses anyone else). Composite product
 * shots need no opt-in. Shown only when product-grounded creative is on.
 * Loaded lazily from the briefs page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { getGroundingSettings, setGroundingSettings } from './creativeBriefsClient.js';
import { JudgeCheckPanel } from './JudgeCheckPanel.js';

export default function GroundingSettingsPanel({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('creative-briefs');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEnabled(null);
    setError(null);
    getGroundingSettings(orgId)
      .then((s) => { if (live) setEnabled(s.editModeEnabled); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error && e.message ? e.message : ''); });
    return () => { live = false; };
  }, [orgId]);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setEnabled((await setGroundingSettings(orgId, next)).editModeEnabled);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface-card u-p-2 u-grid u-gap-1">
      {enabled !== null ? (
        <CheckboxField
          label={t('editModeLabel')}
          help={t('editModeHelp')}
          checked={enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
      ) : null}
      {error !== null ? <Notice variant="warning" announce={error || t('editModeError')}>{error || t('editModeError')}</Notice> : null}
      <JudgeCheckPanel orgId={orgId} />
    </div>
  );
}
