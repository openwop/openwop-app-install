/**
 * AvatarEditor — the profile-photo editor for an agent's dashboard, modelled on
 * the industry-standard avatar croppers (Slack / GitHub / Gravatar): pick or
 * drop an image, pan it under a round crop frame, zoom with a slider, then Save.
 * On save the visible crop is rasterised to a 256×256 JPEG `data:` URI and
 * handed back via `onSave`; "Remove photo" calls `onSave(null)`.
 *
 * Uses `react-easy-crop` for the pan/zoom gesture surface. Modal chrome
 * (backdrop sibling + focus trap + Esc + focus restore) mirrors
 * `chat/ArtifactPreviewModal.tsx` so a11y stays consistent across the app.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Cropper from 'react-easy-crop';
import type { Area, Point } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { ImageIcon, TrashIcon, XIcon } from '../ui/icons/index.js';

/** Exported edge of the cropped thumbnail, px (square). Small enough that the
 *  base64 string rides comfortably on the durable roster row. */
const OUTPUT_SIZE = 256;
/** Refuse absurd source files before we even decode them (raw bytes). */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function AvatarEditor({
  personaName,
  currentAvatarUrl,
  onSave,
  onCancel,
}: {
  personaName: string;
  currentAvatarUrl?: string | undefined;
  /** `string` data-URI to set the photo, `null` to remove it. */
  onSave: (avatarUrl: string | null) => void | Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  // Object URL of the freshly-picked source image (null until one is chosen).
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Focus trap + Esc-to-close + focus restore (the ArtifactPreviewModal recipe).
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const handle = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
      if (e.key === 'Tab') trapTab(e, dialogRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(handle);
      window.removeEventListener('keydown', onKey);
      const t = triggerRef.current;
      if (t instanceof HTMLElement) t.focus();
    };
  }, [onCancel]);

  // Revoke the object URL when it's replaced or the editor unmounts — without
  // this each re-pick leaks a blob URL for the page's lifetime.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  function acceptFile(file: File | undefined | null): void {
    setLocalError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLocalError(t('avatarErrorNotImage'));
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setLocalError(t('avatarErrorTooBig'));
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setImageSrc(url);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }

  async function onSaveClick(): Promise<void> {
    if (!imageSrc || !croppedAreaPixels) return;
    setSaving(true);
    setLocalError(null);
    try {
      const dataUrl = await cropToDataUrl(imageSrc, croppedAreaPixels, t);
      await onSave(dataUrl);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('avatarErrorProcess'));
      setSaving(false);
    }
  }

  return (
    <>
      <div onClick={onCancel} aria-hidden="true" className="modal-backdrop avatared-backdrop" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-editor-heading"
        className="avatared-dialog"
      >
        <div className="avatared-panel">
          <header className="u-flex u-items-center u-gap-2 u-pad-3-4 u-border-b">
            <h2 id="avatar-editor-heading" className="u-m-0 u-fs-16">{t('avatarPhotoHeading', { persona: personaName })}</h2>
            <button type="button" className="secondary u-ml-auto u-iflex u-items-center" onClick={onCancel} aria-label={t('avatarCloseEditor')}>
              <XIcon size={14} />
            </button>
          </header>

          <div className="u-p-4 u-flex u-flex-col u-gap-3">
            {imageSrc ? (
              <>
                {/* Crop stage — react-easy-crop fills this positioned box. */}
                <div className="avatared-crop-stage">
                  <Cropper
                    image={imageSrc}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    cropShape="round"
                    showGrid={false}
                    minZoom={1}
                    maxZoom={3}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={(_area, pixels) => setCroppedAreaPixels(pixels)}
                  />
                </div>
                <label className="u-flex u-items-center u-gap-2 u-fs-13 muted">
                  <span className="avatared-zoom-label">{t('avatarZoom')}</span>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.01}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    aria-label={t('avatarZoom')}
                    className="u-flex-1"
                  />
                </label>
              </>
            ) : (
              // Drop zone / picker — the initial state and the "replace" path.
              // The drag handlers are pointer-only by nature; the keyboard /
              // click path is the nested, label-associated file <input> below,
              // so the non-interactive-element-interactions rule is a false
              // positive here.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
              <label
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptFile(e.dataTransfer.files?.[0]); }}
                className="avatared-dropzone"
                style={{
                  border: `2px dashed ${dragOver ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: dragOver ? 'var(--color-surface-2)' : 'transparent',
                }}
              >
                {currentAvatarUrl ? (
                  <img src={currentAvatarUrl} alt="" className="avatared-current-thumb" />
                ) : (
                  <ImageIcon size={32} />
                )}
                <div className="u-fs-14 u-text">{t('avatarDropHint')}</div>
                <div className="u-fs-12">{t('avatarFormats')}</div>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => acceptFile(e.target.files?.[0])}
                  className="avatared-visually-hidden"
                />
              </label>
            )}

            {localError ? (
              <div role="alert" className="avatared-error">{localError}</div>
            ) : null}

            {/* Footer actions */}
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              {currentAvatarUrl ? (
                <button
                  type="button"
                  className="secondary u-iflex u-items-center u-gap-1-5 u-text-danger"
                  onClick={() => void onSave(null)}
                  disabled={saving}
                >
                  <TrashIcon size={13} /> {t('avatarRemovePhoto')}
                </button>
              ) : null}
              <div className="u-ml-auto u-flex u-gap-2">
                {imageSrc ? (
                  <button type="button" className="secondary" onClick={() => { setImageSrc(null); setCroppedAreaPixels(null); }} disabled={saving}>
                    {t('avatarChooseAnother')}
                  </button>
                ) : null}
                <button type="button" className="secondary" onClick={onCancel} disabled={saving}>{t('newCancel')}</button>
                <button type="button" className="primary" onClick={() => void onSaveClick()} disabled={saving || !imageSrc || !croppedAreaPixels}>
                  {saving ? t('avatarSaving') : t('avatarSavePhoto')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Draw the selected source-pixel region onto a square canvas and export a
 *  JPEG data-URI. `crop` is in natural-image pixels (react-easy-crop's
 *  `croppedAreaPixels`), so no extra scaling math is needed. */
async function cropToDataUrl(src: string, crop: Area, t: TFunction): Promise<string> {
  const image = await loadImage(src, t);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('avatarErrorUnsupported'));
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function loadImage(src: string, t: TFunction): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('avatarErrorLoad')));
    img.src = src;
  });
}

/** Trap Tab inside the dialog (same helper as ArtifactPreviewModal). */
function trapTab(e: KeyboardEvent, container: HTMLDivElement | null): void {
  if (!container) return;
  const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusables.length === 0) { e.preventDefault(); return; }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
