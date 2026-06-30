/**
 * Inspector mode for a multi-node selection: batch arrange / duplicate /
 * delete actions (single-node config is ambiguous across heterogeneous
 * kinds, so we expose batch ops instead).
 */

import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';

export function MultiSelectInspector({ ids }: { ids: string[] }) {
  const { t } = useTranslation('builder');
  const cloneNodes = useBuilderStore.getState().cloneNodes;
  const alignNodes = useBuilderStore.getState().alignNodes;
  const removeNodes = useBuilderStore.getState().removeNodes;
  const deleteAll = () => removeNodes(ids); // one undo entry; clears selection
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{t('nodesSelected', { count: ids.length })}</h3>
      <p className="muted builder-inspector-desc">
        {t('multiSelectDesc')}
      </p>

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('arrange')}</div>
      <div className="form-row builder-inspector-btn-row">
        <button className="secondary" onClick={() => alignNodes(ids, 'left')}>
          {t('alignLeft')}
        </button>
        <button className="secondary" onClick={() => alignNodes(ids, 'top')}>
          {t('alignTop')}
        </button>
      </div>
      <div className="form-row builder-inspector-btn-row">
        <button
          className="secondary"
          disabled={ids.length < 3}
          aria-label={t('distributeHorizontally')}
          onClick={() => alignNodes(ids, 'distribute-h')}
        >
          {t('distribute')} ↔
        </button>
        <button
          className="secondary"
          disabled={ids.length < 3}
          aria-label={t('distributeVertically')}
          onClick={() => alignNodes(ids, 'distribute-v')}
        >
          {t('distribute')} ↕
        </button>
      </div>
      <div className="muted builder-inspector-help">
        {t('distributeHelp')}
      </div>

      <div className="builder-inspector-divider" />
      <button className="secondary" onClick={() => cloneNodes(ids)}>
        {t('duplicateAll', { count: ids.length })}
      </button>
      <button className="secondary u-mt-2" onClick={deleteAll}>
        {t('deleteAll', { count: ids.length })}
      </button>
    </aside>
  );
}
