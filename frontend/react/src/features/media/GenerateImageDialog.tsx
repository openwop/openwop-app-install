/**
 * Generate-image dialog (ADR 0401 P1) — the ONE shared AI-image affordance
 * every `mediaRef` surface opens (slides image block, app-builder image,
 * drawings image object — all via `MediaRefWidget`). Owned by media (media
 * owns media UX, the MediaPickerDialog precedent): prompt + provider/model/
 * size, BYOK-gated with an honest-off state when no image provider has a
 * stored key, dispatching through the host route (the ONE ADR 0115 dispatch —
 * never a client-side provider call). On success the minted LIBRARY asset is
 * handed to the caller, which stores its serve URL on the doc.
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/index.js';
import { KeyIcon, SparklesIcon } from '../../ui/icons/index.js';
import { absoluteServeUrl, generateImageAssets, listImageProviders, type ImageProviderOption, type MediaAsset } from './mediaClient.js';

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

export function GenerateImageDialog({
  orgId,
  onSelect,
  onClose,
}: {
  orgId: string;
  /** Called with the minted library asset; the caller stores `asset.serveUrl`. */
  onSelect: (asset: MediaAsset) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  const [providers, setProviders] = useState<ImageProviderOption[] | null>(null);
  const [provider, setProvider] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [size, setSize] = useState<string>(SIZES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** MED2-B3 — the provider read FAILED: distinct from `[]` (genuinely none). */
  const [providersFailed, setProvidersFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<MediaAsset | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProvidersFailed(false);
    listImageProviders(orgId)
      .then((p) => { if (!cancelled) { setProviders(p); setProvider((cur) => cur || (p[0]?.provider ?? '')); } })
      // UX_UPGRADE-media R2 (MED2-B3) — a FAILED read is not an empty one.
      // `setProviders([])` sent this straight into the "No image provider
      // connected — add an OpenAI or Google API key" card, a claim about the
      // WORKSPACE that the read never established. And the `error` Notice that
      // was set alongside it lives INSIDE the else-branch below, so the same
      // catch guaranteed it could never render: the real reason was dead code.
      // The user opens /providers, finds their key present, comes back, and is
      // told the same thing again. This is MED-G1's exact family, in a file
      // created 15 days before R1 declared that family closed.
      .catch(() => { if (!cancelled) setProvidersFailed(true); });
    return () => { cancelled = true; };
  }, [orgId, t, reload]);

  const generate = async (): Promise<void> => {
    if (busy || !prompt.trim() || !provider) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const assets = await generateImageAssets(orgId, {
        prompt: prompt.trim(), provider, size,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setResult(assets[0] ?? null);
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('generateFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} label={t('generateDialogTitle')} showClose>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0"><SparklesIcon size={16} aria-hidden /> {t('generateDialogTitle')}</h2>
        {providersFailed ? (
          <StateCard
            announce
            icon={<KeyIcon size={20} />}
            title={t('generateLoadFailedTitle')}
            body={t('generateLoadFailedBody')}
            action={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>}
          />
        ) : providers === null ? <Skeleton /> : providers.length === 0 ? (
          // Honest-off: no image provider has a stored key for this workspace.
          <StateCard
            icon={<KeyIcon size={20} />}
            title={t('generateNoProviderTitle')}
            body={t('generateNoProviderBody')}
            action={<Link className="inline-link" to="/providers">{t('generateOpenProviders')}</Link>}
          />
        ) : (
          <>
            <label className="field">
              <span className="field-label">{t('generatePrompt')}</span>
              <textarea rows={3} value={prompt} maxLength={4000} placeholder={t('generatePromptPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="u-flex u-gap-2 u-wrap">
              <label className="field u-m-0">
                <span className="field-label">{t('generateProvider')}</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
                </select>
              </label>
              <label className="field u-m-0">
                <span className="field-label">{t('generateSize')}</span>
                <select value={size} onChange={(e) => setSize(e.target.value)}>
                  {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="field u-m-0 u-flex-1">
                <span className="field-label">{t('generateModel')}</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('generateModelPlaceholder')} maxLength={200} />
              </label>
            </div>
            {error ? <Notice variant="error">{error}</Notice> : null}
            {result ? (
              <figure className="surface-card u-p-2 u-m-0 u-grid u-gap-2">
                <img src={absoluteServeUrl(result.serveUrl)} alt={t('generateResultAlt')} className="media-thumb-img" />
                <figcaption className="u-fs-13 muted">{result.name}</figcaption>
              </figure>
            ) : null}
            <div className="action-bar">
              {result ? (
                <>
                  <Button variant="accent-solid" onClick={() => onSelect(result)}>{t('generateUseImage')}</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void generate()}>{t('generateRetry')}</Button>
                </>
              ) : (
                <Button variant="accent-solid" disabled={busy || !prompt.trim()} onClick={() => void generate()}>
                  {busy ? t('generating') : t('generateAction')}
                </Button>
              )}
              <Button variant="quiet" onClick={onClose}>{t('common:cancel')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
