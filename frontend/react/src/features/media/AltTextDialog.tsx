/**
 * ADR 0363 P1 — the per-asset alt-text editor. Opened from a media asset card,
 * it edits the image's accessibility alt text with three affordances: type it by
 * hand, generate a proposal with AI (the vision seam), or mark the image
 * decorative (`alt=""`). Applies through the existing media PATCH. Composed from
 * shared `ui/` primitives (Modal focus-trap contract, Notice) — no bespoke chrome.
 */

import { Button } from '../../ui/Button.js';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { TextareaField, CheckboxField } from '../../ui/Field.js';
import { SparklesIcon, SaveIcon } from '../../ui/icons/index.js';
import { announce } from '../../ui/announce.js';
import { formatNumber } from '../../i18n/format.js';
import { generateAltText, updateAsset, absoluteServeUrl, type MediaAsset, type MediaAltTextSource } from './mediaClient.js';
import { assetAlt } from './MediaViews.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';

const MAX_ALT = 250;

export function AltTextDialog({
  orgId,
  asset,
  onClose,
  onSaved,
}: {
  orgId: string;
  asset: MediaAsset;
  onClose: () => void;
  onSaved: (updated: MediaAsset) => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  const [text, setText] = useState(asset.altText ?? '');
  const [decorative, setDecorative] = useState(asset.altTextSource === 'decorative');
  const [source, setSource] = useState<MediaAltTextSource>(asset.altTextSource ?? 'human');
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null); // status message (GRADE ALT-UX-2)
  const lockedId = useId();
  // ADR 1100 D8 — AI generation is the accessibility feature's (its route checks the
  // toggle AND the plan); typing and "decorative" are media's own and always offered.
  const a11y = useFeatureAccess('accessibility');
  const canGenerate = a11y.enabled && !a11y.locked && !a11y.loading;
  // Off: no button. Locked (plan) or still resolving: the button stays, disabled,
  // so the layout does not jump and a locked plan says why.
  const showGenerate = a11y.loading || a11y.enabled;

  const generate = async (): Promise<void> => {
    setBusy('generate');
    setError(null);
    setInfo(null);
    try {
      const { proposal } = await generateAltText(orgId, asset.assetId);
      if (proposal.altText === '') {
        setDecorative(true); // the model judged the image decorative
        setInfo(t('altGeneratedDecorative')); // explain WHY the checkbox flipped
        announce(t('altGeneratedDecorative')); // sr status (WCAG 4.1.3)
      } else {
        setDecorative(false);
        setText(proposal.altText);
        setSource('ai');
        setInfo(t('altGenerated'));
        announce(t('altGenerated'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('altGenerateError'));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    setError(null);
    try {
      const updated = decorative
        ? await updateAsset(orgId, asset.assetId, { altTextSource: 'decorative' })
        : await updateAsset(orgId, asset.assetId, { altText: text.trim(), altTextSource: source === 'decorative' ? 'human' : source });
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('altSaveError'));
    } finally {
      setBusy(null);
    }
  };

  const canSave = decorative || text.trim().length > 0;

  return (
    <Modal onClose={onClose} label={t('altDialogTitle', { name: asset.name })}>
      <div className="u-grid u-gap-3">
        {asset.contentType.startsWith('image/') ? (
          <div className="media-thumb">
            <img src={absoluteServeUrl(asset.serveUrl)} alt={assetAlt(asset)} className="media-thumb-img" />
          </div>
        ) : null}

        <p className="u-label-sm u-text-muted">{t(canGenerate || (a11y.loading && !a11y.locked) ? 'altDialogHelp' : 'altDialogHelpNoAi')}</p>
        <p className="u-label-sm u-text-muted">{t('altPlacedNote')}</p>

        <TextareaField
          label={t('altTextLabel')}
          help={t('altCharCount', { n: formatNumber(text.length), max: formatNumber(MAX_ALT) })}
          value={text}
          maxLength={MAX_ALT}
          rows={3}
          disabled={decorative || busy !== null}
          onChange={(e) => { setText(e.target.value); setSource('human'); }}
          placeholder={t('altTextPlaceholder')}
        />

        <CheckboxField
          label={t('altDecorativeLabel')}
          checked={decorative}
          disabled={busy !== null}
          onChange={(e) => setDecorative(e.target.checked)}
        />

        {error ? <Notice variant="error">{error}</Notice> : info ? <Notice variant="info">{info}</Notice> : null}

        <div className="action-bar u-justify-between">
          {showGenerate ? (
            <span className="u-grid u-gap-1">
              <Button variant="secondary" disabled={!canGenerate || decorative || busy !== null} aria-busy={busy === 'generate'} aria-describedby={a11y.locked ? lockedId : undefined} onClick={() => void generate()}>
                <SparklesIcon aria-hidden /> {busy === 'generate' ? t('altGenerating') : t('altGenerate')}
              </Button>
              {a11y.locked ? <span id={lockedId} className="u-label-sm u-text-muted">{t('altGenerateLocked')}</span> : null}
            </span>
          ) : <span aria-hidden="true" />}
          <span className="u-flex u-gap-2">
            <Button variant="secondary" onClick={onClose}>{t('common:cancel')}</Button>
            <Button variant="primary" disabled={!canSave || busy !== null} aria-busy={busy === 'save'} onClick={() => void save()}>
              <SaveIcon aria-hidden /> {busy === 'save' ? t('common:saving') : t('common:save')}
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
