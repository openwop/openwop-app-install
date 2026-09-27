/**
 * Embed edit modal for the `embedBlock` node (ADR 0334 2b-3) — an HTML textarea
 * with a live `SandboxedArtifactFrame` preview (the same isolated iframe the node
 * uses, so preview == result). The HTML is never sanitised or injected as
 * innerHTML — isolation is the boundary (no same-origin, no network egress).
 */
import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/index.js';
import { SandboxedArtifactFrame } from '../../chat/artifacts/SandboxedArtifactFrame.js';


export function EmbedEditModal({ initial, editing, onSave, onClose }: {
  initial: string;
  editing: boolean;
  onSave: (html: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('document-editor');
  // Default embed content is USER-FACING copy → catalog key (check-i18n; the
  // pre-existing #1658 violation fixed in passing during the §7 program).
  const [html, setHtml] = useState(initial || t('embedDefaultHtml'));
  return (
    <Modal onClose={onClose} label={t('embedTitle')} showClose>
      <div className="doc-block-editor">
        <p className="doc-block-editor__note">{t('embedNote')}</p>
        <label className="doc-block-editor__label" htmlFor="doc-embed-html">{t('embedHtml')}</label>
        <textarea id="doc-embed-html" className="cv-editor__input cv-editor__textarea doc-block-editor__code" value={html}
          autoFocus rows={8} spellCheck={false} aria-describedby="doc-embed-preview" onChange={(e) => setHtml(e.target.value)} />
        <div id="doc-embed-preview" className="doc-block-editor__preview">
          <SandboxedArtifactFrame body={html} title={t('embed')} />
        </div>
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('mathCancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(html)} disabled={!html.trim()}>
            {editing ? t('mathUpdate') : t('mathInsert')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
