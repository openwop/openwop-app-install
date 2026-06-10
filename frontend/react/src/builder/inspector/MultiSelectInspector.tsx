/**
 * Inspector mode for a multi-node selection: batch arrange / duplicate /
 * delete actions (single-node config is ambiguous across heterogeneous
 * kinds, so we expose batch ops instead).
 */

import { useBuilderStore } from '../store/builderStore.js';

export function MultiSelectInspector({ ids }: { ids: string[] }) {
  const cloneNodes = useBuilderStore.getState().cloneNodes;
  const alignNodes = useBuilderStore.getState().alignNodes;
  const removeNodes = useBuilderStore.getState().removeNodes;
  const deleteAll = () => removeNodes(ids); // one undo entry; clears selection
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{ids.length} nodes selected</h3>
      <p className="muted builder-inspector-desc">
        Batch actions apply to every selected node. Select a single node to edit
        its configuration.
      </p>

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">Arrange</div>
      <div className="form-row builder-inspector-btn-row">
        <button className="secondary" onClick={() => alignNodes(ids, 'left')}>
          Align left
        </button>
        <button className="secondary" onClick={() => alignNodes(ids, 'top')}>
          Align top
        </button>
      </div>
      <div className="form-row builder-inspector-btn-row">
        <button
          className="secondary"
          disabled={ids.length < 3}
          aria-label="Distribute horizontally"
          onClick={() => alignNodes(ids, 'distribute-h')}
        >
          Distribute ↔
        </button>
        <button
          className="secondary"
          disabled={ids.length < 3}
          aria-label="Distribute vertically"
          onClick={() => alignNodes(ids, 'distribute-v')}
        >
          Distribute ↕
        </button>
      </div>
      <div className="muted builder-inspector-help">
        Distribute evens out the gaps between three or more nodes.
      </div>

      <div className="builder-inspector-divider" />
      <button className="secondary" onClick={() => cloneNodes(ids)}>
        Duplicate all ({ids.length})
      </button>
      <button className="secondary u-mt-2" onClick={deleteAll}>
        Delete all ({ids.length})
      </button>
    </aside>
  );
}
