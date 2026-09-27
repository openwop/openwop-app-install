/**
 * LaTeX edit modal for the `mathBlock` node (ADR 0334 2b-2) — a textarea with a
 * live KaTeX preview (`katex.render` into a ref; `throwOnError:false` shows the
 * source on a malformed formula). Used to insert a new math block or edit a
 * selected one; the editor node itself is an atom (no inline editing).
 */
import { Button } from '../../ui/Button.js';
import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import { Modal } from '../../ui/index.js';

export function MathEditModal({ initial, editing, onSave, onClose }: {
  initial: string;
  editing: boolean;
  onSave: (latex: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('document-editor');
  const [latex, setLatex] = useState(initial);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    try { katex.render(latex || '', el, { throwOnError: false, displayMode: true }); }
    catch { el.textContent = latex; }
  }, [latex]);
  return (
    <Modal onClose={onClose} label={t('mathTitle')} showClose>
      <div className="doc-math-editor">
        <label className="doc-math-editor__label" htmlFor="doc-math-latex">{t('mathLatex')}</label>
        <textarea id="doc-math-latex" className="cv-editor__input cv-editor__textarea" value={latex} autoFocus rows={4}
          aria-describedby="doc-math-preview" onChange={(e) => setLatex(e.target.value)} />
        <div id="doc-math-preview" className="doc-math-editor__preview" role="math" aria-label={latex || t('mathPreview')} ref={previewRef} />
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('mathCancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(latex.trim())} disabled={!latex.trim()}>
            {editing ? t('mathUpdate') : t('mathInsert')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
