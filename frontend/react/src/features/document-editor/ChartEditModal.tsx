/**
 * Chart edit modal for the `chartBlock` node (ADR 0334 2b-3) — a JSON textarea
 * for the `interactive.chart` spec with a live `ChartRenderer` preview (the same
 * inline-SVG renderer the node uses, so preview == result; a malformed spec
 * degrades to an inert dump, never throws). Insert a new chart or edit a selected
 * one.
 */
import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/index.js';
import { ChartRenderer } from '../../chat/artifacts/ChartRenderer.js';

/** A minimal valid two-bar starter spec for a freshly-inserted chart. */
export const DEFAULT_CHART_SPEC = JSON.stringify({
  chartType: 'bar',
  data: {
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    datasets: [{ label: 'Revenue', data: [12, 19, 9, 22] }],
  },
}, null, 2);

export function ChartEditModal({ initial, editing, onSave, onClose }: {
  initial: string;
  editing: boolean;
  onSave: (spec: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('document-editor');
  const [spec, setSpec] = useState(initial || DEFAULT_CHART_SPEC);
  return (
    <Modal onClose={onClose} label={t('chartTitle')} showClose>
      <div className="doc-block-editor">
        <label className="doc-block-editor__label" htmlFor="doc-chart-spec">{t('chartSpec')}</label>
        <textarea id="doc-chart-spec" className="cv-editor__input cv-editor__textarea doc-block-editor__code" value={spec}
          autoFocus rows={8} spellCheck={false} aria-describedby="doc-chart-preview" onChange={(e) => setSpec(e.target.value)} />
        <div id="doc-chart-preview" className="doc-block-editor__preview">
          <ChartRenderer content={spec} />
        </div>
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('mathCancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(spec.trim())} disabled={!spec.trim()}>
            {editing ? t('mathUpdate') : t('mathInsert')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
