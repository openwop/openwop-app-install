/**
 * Real-time voice provider settings (ADR 0141 RT-3) — tenant-wide admin config: pick the
 * speech-to-speech provider (OpenAI Realtime / Gemini Live) + the BYOK key it uses, or `off`
 * for the recorded-voice fallback. Lives on the Keys page (the BYOK key it references is set
 * there). The key value never leaves the host; this stores only the credentialRef.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRealtimeConfig, setRealtimeConfig, type RealtimeProviderId } from '../chat/voice/voiceClient.js';
import { Notice } from '../ui/Notice.js';
import { SelectField } from '../ui/Field.js';

const PROVIDERS: Array<{ id: RealtimeProviderId | 'off'; brand?: string }> = [
  { id: 'off' },
  { id: 'openai-realtime', brand: 'OpenAI Realtime' },
  { id: 'gemini-live', brand: 'Gemini Live' },
];

export function RealtimeVoiceSettings({ storedRefs }: { storedRefs: readonly string[] }): JSX.Element {
  const { t } = useTranslation('byok');
  const [provider, setProvider] = useState<RealtimeProviderId | 'off'>('off');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void getRealtimeConfig().then((c) => { if (!live) return; setProvider(c.provider); setCredentialRef(c.credentialRef ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const needsKey = provider !== 'off';
      await setRealtimeConfig({ provider, ...(needsKey && credentialRef ? { credentialRef } : {}) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const needsKey = provider !== 'off';
  return (
    <section className="surface-card u-flex u-flex-col u-gap-3" aria-labelledby="rt-voice-h">
      <h2 id="rt-voice-h" className="u-fs-16 u-fw-600 u-m-0">{t('rtTitle')}</h2>
      <p className="muted u-fs-13 u-m-0">{t('rtDesc')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {saved ? <Notice variant="success">{t('rtSaved')}</Notice> : null}
      <div className="u-flex u-gap-3 u-flex-wrap u-items-end">
        <SelectField label={t('rtProvider')} value={provider} onChange={(e) => setProvider(e.target.value as RealtimeProviderId | 'off')} className="u-flex-1">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.brand ?? t('rtProviderOff')}</option>)}
        </SelectField>
        {needsKey ? (
          <SelectField label={t('rtKey')} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} className="u-flex-1">
            <option value="">{t('rtKeySelect')}</option>
            {storedRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
          </SelectField>
        ) : null}
      </div>
      {needsKey && storedRefs.length === 0 ? <p className="muted u-fs-12 u-m-0">{t('rtNoKeys')}</p> : null}
      {provider === 'gemini-live' ? <Notice variant="warning">{t('rtGeminiAssurance')}</Notice> : null}
      <div className="action-bar">
        <button type="button" className="btn-primary btn-sm" disabled={busy || (needsKey && !credentialRef)} onClick={() => void save()}>
          {busy ? t('rtSaving') : t('rtSave')}
        </button>
      </div>
    </section>
  );
}
