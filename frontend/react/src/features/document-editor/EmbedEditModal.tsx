/**
 * Embed edit modal for the `embedBlock` node (ADR 0334 2b-3) — an HTML textarea
 * with a live `SandboxedArtifactFrame` preview (the same isolated iframe the node
 * uses, so preview == result). The HTML is never sanitised or injected as
 * innerHTML; isolation is the boundary. The preview starts static: the HTML being
 * edited may be a peer's, so its scripts run only after this author presses Run
 * (ADR 1017 D1). One consent covers this open of the modal, so the author's own
 * typing does not re-prompt on every keystroke.
 */
import { Button } from '../../ui/Button.js';
import { useId, useState } from 'react';
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
  // A fresh id per open of the modal: the consent key for its preview.
  const consentKey = useId();
  return (
    <Modal onClose={onClose} label={t('embedTitle')} showClose>
      <div className="doc-block-editor">
        <p id="doc-embed-note" className="doc-block-editor__note">{t('embedNote')}</p>
        <label className="doc-block-editor__label" htmlFor="doc-embed-html">{t('embedHtml')}</label>
        <textarea id="doc-embed-html" className="cv-editor__input cv-editor__textarea doc-block-editor__code" value={html}
          autoFocus rows={8} spellCheck={false} aria-describedby="doc-embed-note" onChange={(e) => setHtml(e.target.value)} />
        <div id="doc-embed-preview" className="doc-block-editor__preview">
          <SandboxedArtifactFrame body={html} title={t('embed')} consentKey={consentKey} />
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
