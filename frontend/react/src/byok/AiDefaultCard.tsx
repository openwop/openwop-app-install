/**
 * Default AI provider for media (ADR 0110 Phase 3) — binds {provider, model, credentialRef}
 * used when KB media → text (image OCR / audio transcription) needs a multimodal model the
 * managed provider doesn't offer. Composes the shared form primitives + the already-loaded
 * BYOK `refs`; the key value never touches the FE, only the ref.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../ui/Field.js';
import { Notice } from '../ui/index.js';
import { getAiDefault, setAiDefault, clearAiDefault, type HeadlessAiDefault } from './lib/byokClient.js';

const PROVIDERS: ReadonlyArray<HeadlessAiDefault['provider']> = ['google', 'anthropic', 'openai'];

export function AiDefaultCard({ refs }: { refs: readonly string[] }): JSX.Element {
  const { t } = useTranslation('byok');
  const [provider, setProvider] = useState<HeadlessAiDefault['provider']>('google');
  const [model, setModel] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [existing, setExisting] = useState<HeadlessAiDefault | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ variant: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    void getAiDefault().then((d) => {
      setExisting(d);
      if (d) { setProvider(d.provider); setModel(d.model); setCredentialRef(d.credentialRef); }
    }).catch(() => undefined);
  }, []);

  const hasRefs = refs.length > 0;
  const canSave = hasRefs && model.trim().length > 0 && credentialRef.length > 0 && !busy;
  // Audio transcription only works on Google (Gemini); images work on any of the three.
  const audioWarn = provider !== 'google';

  async function save(): Promise<void> {
    setBusy(true); setNotice(null);
    try {
      const saved = await setAiDefault({ provider, model: model.trim(), credentialRef });
      setExisting(saved);
      setNotice({ variant: 'success', msg: t('aiDefaultSaved') });
    } catch (err) {
      setNotice({ variant: 'error', msg: err instanceof Error ? err.message : t('aiDefaultError') });
    } finally { setBusy(false); }
  }

  async function clear(): Promise<void> {
    setBusy(true); setNotice(null);
    try {
      await clearAiDefault();
      setExisting(null); setModel(''); setCredentialRef('');
      setNotice({ variant: 'success', msg: t('aiDefaultCleared') });
    } catch (err) {
      setNotice({ variant: 'error', msg: err instanceof Error ? err.message : t('aiDefaultError') });
    } finally { setBusy(false); }
  }

  return (
    <section className="surface-card u-mt-4">
      <h2 className="u-fs-16 u-m-0 u-mb-1">{t('aiDefaultTitle')}</h2>
      <p className="field-help u-mb-2">{t('aiDefaultIntro')}</p>

      {!hasRefs ? (
        <Notice variant="info">{t('aiDefaultNoKeys')}</Notice>
      ) : (
        <>
          <SelectField label={t('aiDefaultProvider')} help={t('aiDefaultProviderHelp')} value={provider} onChange={(e) => setProvider(e.target.value as HeadlessAiDefault['provider'])}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{t(`provider_${p}`)}</option>)}
          </SelectField>
          {audioWarn ? <Notice variant="warning">{t('aiDefaultAudioWarn')}</Notice> : null}
          <TextField label={t('aiDefaultModel')} help={t('aiDefaultModelHelp')} value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-3.1-flash-lite" />
          <SelectField label={t('aiDefaultKey')} help={t('aiDefaultKeyHelp')} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)}>
            <option value="">{t('aiDefaultKeyPlaceholder')}</option>
            {refs.map((r) => <option key={r} value={r}>{r}</option>)}
          </SelectField>

          <div className="u-flex u-gap-2 u-mt-2">
            <button type="button" className="btn-primary" disabled={!canSave} onClick={() => void save()}>{t('aiDefaultSave')}</button>
            {existing ? <button type="button" className="btn-ghost" disabled={busy} onClick={() => void clear()}>{t('aiDefaultClear')}</button> : null}
          </div>
        </>
      )}
      {notice ? <div className="u-mt-2"><Notice variant={notice.variant}>{notice.msg}</Notice></div> : null}
    </section>
  );
}
