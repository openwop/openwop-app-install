/**
 * Media picker dialog (ADR 0206 B4) — the reusable browse/search/upload
 * selector other features embed to reference a media asset. OWNED by the media
 * feature (media owns media UX; the CMS editor imports this instead of growing
 * its own duplicate fetch — the Phase-B architecture ruling). Composes the
 * existing media client (`listAssets`/`uploadAsset`) + the shared `Modal`; no
 * new upload path, no bespoke CSS.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { ImageIcon, PlusIcon, SearchIcon } from '../../ui/icons/index.js';
import { absoluteServeUrl, listAssets, uploadAsset, type MediaAsset } from './mediaClient.js';

export function MediaPickerDialog({
  orgId,
  onSelect,
  onClose,
}: {
  orgId: string;
  /** Called with the chosen asset; the caller stores `asset.serveToken`. */
  onSelect: (asset: MediaAsset) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // MED-G1 — a failed read must not render as "no media yet" in a PICKER: the
  // user concludes the library is empty and re-uploads a duplicate.
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback((query: string) => {
    setLoadFailed(false);
    listAssets(orgId, query ? { q: query } : {})
      .then(setAssets)
      .catch(() => { setAssets(null); setLoadFailed(true); });
  }, [orgId]);

  // Debounced search — one request per pause, not per keystroke (rate-limit
  // fan-out discipline).
  useEffect(() => {
    const handle = setTimeout(() => load(q), q ? 250 : 0);
    return () => clearTimeout(handle);
  }, [q, load]);

  const upload = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const asset = await uploadAsset(orgId, file);
      toast.success(t('pickerUploaded', { name: asset.name }));
      onSelect(asset);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('pickerUploadFailed'));
    } finally {
      setBusy(false);
    }
  }, [orgId, onSelect, t]);

  return (
    <Modal onClose={onClose} label={t('pickerTitle')}>
      <div className="u-grid u-gap-2">
        <div className="u-flex u-gap-1 u-items-center">
          <SearchIcon size={14} aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('pickerSearchPlaceholder')}
            aria-label={t('pickerSearchPlaceholder')}
            className="u-flex-1"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="u-hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
          />
          <Button variant="quiet" className="u-w-auto" disabled={busy} onClick={() => fileRef.current?.click()}>
            <PlusIcon size={14} /> {t('pickerUpload')}
          </Button>
        </div>

        {loadFailed ? (
          <StateCard announce icon={<ImageIcon />} title={t('pickerLoadFailedTitle')} body={t('pickerLoadFailedBody')} action={<Button variant="secondary" size="sm" onClick={() => load(q)}>{t('common:retry')}</Button>} />
        ) : !assets ? <Skeleton /> : assets.length === 0 ? (
          <StateCard icon={<ImageIcon />} title={t('pickerEmptyTitle')} body={t('pickerEmpty')} />
        ) : (
          <div className="card-grid">
            {assets.map((a) => (
              <button
                key={a.assetId}
                type="button"
                className="surface-card u-gap-1 u-p-2"
                onClick={() => onSelect(a)}
                aria-label={t('pickerChooseAria', { name: a.name })}
              >
                <div className="media-thumb">
                  {a.contentType.startsWith('image/')
                    ? <img src={absoluteServeUrl(a.serveUrl)} alt="" className="media-thumb-img" />
                    : <ImageIcon aria-hidden />}
                </div>
                <span className="media-asset-name" title={a.name}>{a.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
