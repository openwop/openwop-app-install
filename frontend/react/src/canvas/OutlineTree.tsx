/**
 * Canvas framework — the recursive component-tree outline (the "layers" panel;
 * ADR 0310, extracted from the app-builder editor / ADR 0305 Phase B). Click a
 * row to select; rows are drag sources AND drop slots (drop inserts BEFORE the
 * row). Generic over the tree trait's node type — the type supplies `labelFor`
 * and `childrenOf`.
 *
 * Grade pass UX-CV-8 — a real WAI-ARIA `tree` widget: the container is
 * `role=tree`, nested lists are `role=group`, each row is a `role=treeitem`
 * carrying `aria-selected`/`aria-level`/`aria-posinset`/`aria-setsize` (and
 * `aria-expanded` when it has children — the outline is always expanded). One
 * roving `tabIndex=0` (the selected row, else the first), with Up/Down/Home/End
 * moving DOM focus across the visible treeitems and Enter/Space selecting.
 */
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TreeNodeBase } from './treeOps.js';
import { EyeOffIcon, LockIcon } from '../ui/icons/index.js';
import { MIME_ADD, MIME_MOVE } from './dnd.js';

const samePath = (a: number[] | null, b: number[] | null): boolean =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Does `path` resolve to a node in the tree? (Grade pass GC-CV — a non-null
 *  selPath that matches no rendered row would leave NO roving tab stop and make
 *  the tree unreachable by Tab; the root sanitizes it to null so the first-row
 *  fallback fires.) */
function pathExists<N extends TreeNodeBase>(nodes: N[], path: number[], childrenOf: (n: N) => N[] | undefined): boolean {
  let level: N[] | undefined = nodes;
  for (let i = 0; i < path.length; i++) {
    const node: N | undefined = level?.[path[i]!];
    if (!node) return false;
    if (i === path.length - 1) return true;
    level = childrenOf(node);
  }
  return path.length === 0 ? false : true;
}

/** A truncated content hint so sibling rows are distinguishable ("text — Welcome
 *  back" instead of five identical "text" rows — grade pass UX F12). */
export function contentHint(n: TreeNodeBase): string {
  const p = n.props ?? {};
  const v = [p.text, p.label, p.title, p.name].find((x) => typeof x === 'string' && x);
  return typeof v === 'string' ? ` — ${v.length > 24 ? `${v.slice(0, 24)}…` : v}` : '';
}

/** Roving-focus navigation + keyboard REORDER over the visible treeitems (DOM
 *  order = visible order for a fully-expanded tree), so the recursion needs no
 *  flattened model.
 *
 *  Reorder (a11y — the ARIA APG modifier+Arrow gesture) is checked FIRST: `Alt`+
 *  ArrowUp/Down moves the focused node among its siblings via `onReorder` and does
 *  NOT also navigate (the `altKey` guard disambiguates from plain-Arrow nav). A
 *  locked node, or a missing `onReorder`, falls through to no-op. */
function onTreeKeyDown(
  e: KeyboardEvent<HTMLDivElement>,
  here: number[],
  locked: boolean,
  onSelect: () => void,
  onReorder?: (fromPath: number[], dir: 'up' | 'down') => void,
): void {
  const key = e.key;
  // Reorder gesture first — Alt+Arrow, never falls through to navigation.
  if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    if (!onReorder || locked) return; // honest no-op: a locked node isn't movable
    e.preventDefault();
    onReorder(here, key === 'ArrowUp' ? 'up' : 'down');
    return;
  }
  if (key === 'Enter' || key === ' ') { e.preventDefault(); onSelect(); return; }
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
  const root = e.currentTarget.closest('[role="tree"]');
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const idx = items.indexOf(e.currentTarget);
  if (idx === -1) return;
  e.preventDefault();
  const next = key === 'ArrowDown' ? items[idx + 1]
    : key === 'ArrowUp' ? items[idx - 1]
    : key === 'Home' ? items[0]
    : items[items.length - 1];
  next?.focus();
}

export function OutlineTree<N extends TreeNodeBase>({ nodes, path, selPath, onSelect, dropPath, setDropPath, onDropRow, onReorder, labelFor, childrenOf, label, describedById }: {
  nodes: N[]; path: number[]; selPath: number[] | null; onSelect: (p: number[]) => void;
  dropPath: string | null; setDropPath: (p: string | null) => void;
  onDropRow: (dt: DataTransfer, rowPath: number[]) => void;
  /** Keyboard sibling-reorder (a11y — Alt+ArrowUp/Down). Omit to disable (nav-only).
   *  Cross-parent reparent stays drag-only; this closes the "reordering" a11y gap. */
  onReorder?: (fromPath: number[], dir: 'up' | 'down') => void;
  labelFor: (n: N) => string;
  childrenOf: (n: N) => N[] | undefined;
  /** Accessible name for the tree — supplied only at the root (path === []). */
  label?: string;
  /** id of a visually-hidden hint describing the reorder gesture (root only). */
  describedById?: string;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const isRoot = path.length === 0;
  // At the root, drop a selPath that resolves to no node so the first-row tab
  // stop still exists (GC-CV); deeper levels inherit the already-sanitized value.
  const effSel = isRoot && selPath !== null && !pathExists(nodes, selPath, childrenOf) ? null : selPath;
  return (
    <ul
      className="cv-editor__tree"
      role={isRoot ? 'tree' : 'group'}
      {...(isRoot && label ? { 'aria-label': label } : {})}
      {...(isRoot && describedById ? { 'aria-describedby': describedById } : {})}
    >
      {nodes.map((n, i) => {
        const here = [...path, i];
        const key = here.join('.');
        const selected = samePath(effSel, here);
        const children = childrenOf(n);
        // One roving tab stop: the selected row, or (nothing selected) the very
        // first row of the whole tree.
        const tabbable = selected || (effSel === null && here.length === 1 && here[0] === 0);
        return (
          <li key={i} role="none">
            <div
              role="treeitem"
              tabIndex={tabbable ? 0 : -1}
              aria-selected={selected}
              aria-level={here.length}
              aria-posinset={i + 1}
              aria-setsize={nodes.length}
              {...(children && children.length ? { 'aria-expanded': true } : {})}
              className={`cv-editor__tree-row${selected ? ' is-sel' : ''}${dropPath === key ? ' is-drop' : ''}${n.hidden ? ' is-hidden-node' : ''}`}
              onClick={() => onSelect(here)}
              onKeyDown={(e) => onTreeKeyDown(e, here, !!n.locked, () => onSelect(here), onReorder)}
              // ADR 0344 2b — a locked node is not a drag source (selection stays
              // allowed so the panel can unlock it).
              draggable={!n.locked}
              onDragStart={(e) => { e.dataTransfer.setData(MIME_MOVE, key); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => {
                const types = Array.from(e.dataTransfer.types);
                if (types.includes(MIME_ADD) || types.includes(MIME_MOVE)) { e.preventDefault(); setDropPath(key); }
              }}
              onDragLeave={() => { if (dropPath === key) setDropPath(null); }}
              onDrop={(e) => { e.preventDefault(); onDropRow(e.dataTransfer, here); }}
              onDragEnd={() => setDropPath(null)}
            >
              {labelFor(n)}{contentHint(n)}
              {/* ADR 0344 2b — non-color trait indicators (glyph + tooltip). */}
              {n.hidden ? <span className="cv-editor__tree-flag" title={t('nodeHidden')} role="img" aria-label={t('nodeHidden')}><EyeOffIcon size={11} /></span> : null}
              {n.locked ? <span className="cv-editor__tree-flag" title={t('nodeLocked')} role="img" aria-label={t('nodeLocked')}><LockIcon size={11} /></span> : null}
            </div>
            {children && children.length ? (
              <OutlineTree nodes={children} path={here} selPath={effSel} onSelect={onSelect} dropPath={dropPath} setDropPath={setDropPath} onDropRow={onDropRow} {...(onReorder ? { onReorder } : {})} labelFor={labelFor} childrenOf={childrenOf} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
