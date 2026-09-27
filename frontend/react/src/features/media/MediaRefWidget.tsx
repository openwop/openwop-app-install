/**
 * The `mediaRef` property widget (ADR 0328 Phase 2 / research C1) — a canvas
 * property field that stores a host media-asset serve URL, picked via the
 * shared MediaPickerDialog (browse / search / upload). Attached per-definition
 * through the ADR 0310 `propertyWidgets` seam (the ScreenRefWidget precedent):
 * the CORE never imports this feature. The stored value stays a plain string
 * URL, so validators, renderers, and the exporters' host-asset-only embed
 * policy (`assetTokenFromUrl`) are untouched.
 *
 * ADR 0342 Phase 0 (DS-06): a manual-URL entry rides beside the picker so a
 * field that migrates from a raw string prop (app-builder `image.src`) keeps
 * external-URL capability. Renderers stay the safety gate (scheme allowlists);
 * the widget itself never rewrites or fetches the value.
 */
import { Button } from '../../ui/Button.js';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PropertyWidgetProps } from '../../canvas/types.js';
import { ImageIcon, LinkIcon, SparklesIcon, WandIcon, XIcon } from '../../ui/icons/index.js';
import { MediaPickerDialog } from './MediaPickerDialog.js';
import { GenerateImageDialog } from './GenerateImageDialog.js';
import { EditImageDialog } from './EditImageDialog.js';

export function MediaRefWidget({ def, value, onChange, orgId }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('media');
  const [open, setOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [draftUrl, setDraftUrl] = useState('');
  const urlToggleRef = useRef<HTMLButtonElement>(null);
  const url = typeof value === 'string' ? value : '';

  // Keyboard users entered via the toggle button — put them back on it when the
  // inline editor unmounts, instead of dropping focus to <body>.
  const closeUrlEditor = (): void => {
    setEditingUrl(false);
    requestAnimationFrame(() => urlToggleRef.current?.focus());
  };
  const commitUrl = (): void => {
    const trimmed = draftUrl.trim();
    onChange(trimmed || undefined);
    closeUrlEditor();
  };

  return (
    <div className="cv-mediaref">
      {url && !editingUrl ? (
        <span className="cv-mediaref__preview">
          {/* Decorative thumbnail of the chosen asset; the field label names it. */}
          <img src={url} alt="" aria-hidden className="cv-mediaref__thumb" />
          <Button
            variant="quiet" size="sm"
            aria-label={t('clearImage', { field: def.label ?? def.name })}
            title={t('clearImage', { field: def.label ?? def.name })}
            onClick={() => onChange(undefined)}
          >
            <XIcon size={13} aria-hidden />
          </Button>
        </span>
      ) : null}
      {editingUrl ? (
        <span className="cv-mediaref__url action-bar">
          <input
            className="cv-editor__input"
            type="url"
            value={draftUrl}
            placeholder={t('imageUrlPlaceholder')}
            aria-label={t('imageUrl', { field: def.label ?? def.name })}
            autoFocus
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitUrl(); }
              if (e.key === 'Escape') closeUrlEditor();
            }}
          />
          <Button variant="secondary" size="sm" onClick={commitUrl}>{t('applyUrl')}</Button>
          <Button variant="quiet" size="sm" onClick={closeUrlEditor}>{t('cancelUrl')}</Button>
        </span>
      ) : (
        <>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <ImageIcon size={13} aria-hidden /> {url ? t('replaceImage') : t('chooseImage')}
          </Button>
          <Button
            ref={urlToggleRef}
            variant="quiet" size="sm"
            title={t('useImageUrl')}
            onClick={() => { setDraftUrl(url); setEditingUrl(true); }}
          >
            <LinkIcon size={13} aria-hidden /> {t('useImageUrl')}
          </Button>
          {/* ADR 0401 — the ONE image-gen affordance, reaching every mediaRef
              surface through this widget (slides / app-builder / drawings). */}
          <Button variant="quiet" size="sm" title={t('generateImage')} onClick={() => setGenOpen(true)}>
            <SparklesIcon size={13} aria-hidden /> {t('generateImage')}
          </Button>
          {url ? (
            <Button variant="quiet" size="sm" title={t('editImageAi')} onClick={() => setEditOpen(true)}>
              <WandIcon size={13} aria-hidden /> {t('editImageAi')}
            </Button>
          ) : null}
        </>
      )}
      {open ? (
        <MediaPickerDialog
          orgId={orgId}
          onSelect={(asset) => { onChange(asset.serveUrl); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {genOpen ? (
        <GenerateImageDialog
          orgId={orgId}
          onSelect={(asset) => { onChange(asset.serveUrl); setGenOpen(false); }}
          onClose={() => setGenOpen(false)}
        />
      ) : null}
      {editOpen ? (
        <EditImageDialog
          orgId={orgId}
          imageUrl={url}
          onSelect={(asset) => { onChange(asset.serveUrl); setEditOpen(false); }}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
    </div>
  );
}
