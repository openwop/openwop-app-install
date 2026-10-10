/**
 * The Edit tab's page (ADR 0828 phase 4 layout): every section drawn as on the
 * site, edited and arranged where it is.
 *
 *  - Pointing at or focusing a section shows its outline, a drag handle in the
 *    left gutter and a toolbar: Edit, Move up, Move down, Duplicate, Delete.
 *  - Edit opens THAT section into its editing card in place (the caller's
 *    `renderEditor`); the sections around it stay drawn. One at a time.
 *  - "+" between sections adds a new one exactly there.
 *  - Sections reorder by dragging the handle, or with the keyboard: Space or
 *    Enter picks the section up, the arrows move it, Space or Enter drops it,
 *    and every step is announced.
 *
 * It renders inside the preview frame (a React portal), so the page keeps the
 * site's real breakpoints and the admin styles cannot reach it. dnd-kit works
 * within the frame's one document.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Button } from '../../ui/Button.js';
import { IconButton } from '../../ui/IconButton.js';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, GripVerticalIcon, PencilIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { RenderSection } from './SectionRenderer.js';
import { sectionLabel } from './sectionLabel.js';
import type { Section } from './cmsClient.js';

export interface CanvasHandlers {
  onEdit: (sectionId: string) => void;
  /** Close the open editor (Done, or Escape inside it). */
  onCloseEditor: () => void;
  onMove: (sectionId: string, dir: -1 | 1) => void;
  onReorder: (sectionId: string, overId: string) => void;
  onDuplicate: (sectionId: string) => void;
  onRemove: (sectionId: string) => void;
  /** Open the section picker to add a section at `index` (0 = top). */
  onInsertAt: (index: number) => void;
}

export function CmsCanvas({ sections, editingId, selectedId, structure, renderEditor, handlers }: {
  /** The sections as drawn (shared references and the preview locale resolved). */
  sections: Section[];
  editingId: string | null;
  selectedId: string | null;
  /** False on the translator surface: no moving, duplicating, deleting or adding. */
  structure: boolean;
  renderEditor: (sectionId: string) => ReactNode;
  handlers: CanvasHandlers;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number): string => {
    const s = sections.find((x) => x.sectionId === id);
    return s ? sectionLabel(s) || t(`sectionType_${s.type}`, { defaultValue: s.type }) : '';
  };
  const positionOf = (id: string | number): number => sections.findIndex((x) => x.sectionId === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('outlineDragStart', { label: nameOf(active.id), position: positionOf(active.id), count: sections.length }),
    onDragOver: ({ active, over }) => (over ? t('outlineDragOver', { label: nameOf(active.id), position: positionOf(over.id), count: sections.length }) : undefined),
    onDragEnd: ({ active, over }) => (over ? t('outlineDragEnd', { label: nameOf(active.id), position: positionOf(over.id), count: sections.length }) : undefined),
    onDragCancel: ({ active }) => t('outlineDragCancel', { label: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (over && active.id !== over.id) handlers.onReorder(String(active.id), String(over.id));
  };

  const insertPoint = (index: number, after: string): JSX.Element | null => (structure ? (
    <div className="cms-cv-insert">
      <Button
        variant="secondary"
        size="sm"
        aria-label={after ? t('canvasInsertAfter', { section: after }) : t('canvasInsertTop')}
        onClick={() => handlers.onInsertAt(index)}
      >
        <PlusIcon size={14} /> {t('canvasInsert')}
      </Button>
    </div>
  ) : null);

  const items = sections.map((s, i) => (
    <CanvasSection
      key={s.sectionId}
      section={s}
      index={i}
      count={sections.length}
      editing={s.sectionId === editingId}
      selected={s.sectionId === selectedId}
      structure={structure}
      name={nameOf(s.sectionId)}
      handlers={handlers}
      renderEditor={renderEditor}
      after={insertPoint(i + 1, nameOf(s.sectionId))}
    />
  ));

  return (
    <div className="cms-cv">
      {insertPoint(0, '')}
      {structure ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: { draggable: t('outlineDragInstructions') } }}>
          <SortableContext items={sections.map((s) => s.sectionId)} strategy={verticalListSortingStrategy}>
            {items}
          </SortableContext>
        </DndContext>
      ) : items}
    </div>
  );
}

function CanvasSection({ section: s, index: i, count, editing, selected, structure, name, handlers, renderEditor, after }: {
  section: Section;
  index: number;
  count: number;
  editing: boolean;
  selected: boolean;
  structure: boolean;
  name: string;
  handlers: CanvasHandlers;
  renderEditor: (sectionId: string) => ReactNode;
  after: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: s.sectionId, disabled: !structure || editing });
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Opening the editor moves focus to its first field (and scrolls it in).
  useEffect(() => {
    if (!editing) return;
    const card = cardRef.current;
    if (typeof card?.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
    card?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])')?.focus();
  }, [editing]);
  // Escape anywhere inside the open editor closes it (Done does too).
  const { onCloseEditor } = handlers;
  useEffect(() => {
    const card = cardRef.current;
    if (!editing || !card) return undefined;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onCloseEditor(); } };
    card.addEventListener('keydown', onKey);
    return () => card.removeEventListener('keydown', onKey);
  }, [editing, onCloseEditor]);

  return (
    <>
      <div
        ref={setNodeRef}
        className="cms-cv-section"
        data-section-id={s.sectionId}
        data-selected={selected ? 'true' : undefined}
        data-editing={editing ? 'true' : undefined}
        data-dragging={isDragging ? 'true' : undefined}
        style={{ transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined, transition }}
      >
        {editing ? (
          <div
            ref={cardRef}
            className="cms-cv-editor"
            role="group"
            aria-label={t('canvasEditingLabel', { section: name })}
          >
            {renderEditor(s.sectionId)}
          </div>
        ) : (
          <>
            {/* Sticky, zero-height chrome: the handle and toolbar stay in view
                while any part of a tall section is on screen. */}
            <div className="cms-cv-chrome">
              {structure ? (
                <span ref={setActivatorNodeRef} aria-label={t('outlineDragHandle', { label: name })} className="cms-cv-handle" {...attributes} {...listeners}>
                  <GripVerticalIcon size={16} />
                </span>
              ) : null}
              <div className="cms-cv-toolbar" role="toolbar" aria-label={t('canvasToolbarLabel', { section: name })}>
                <Button variant="primary" size="sm" data-edit-for={s.sectionId} aria-label={t('canvasEditAria', { section: name })} onClick={() => handlers.onEdit(s.sectionId)}>
                  <PencilIcon size={13} /> {t('canvasEdit')}
                </Button>
                {structure ? (
                  <>
                    <IconButton label={t('canvasMoveUpAria', { section: name })} icon={<ArrowUpIcon size={14} />} className="btn-ghost btn-sm" disabled={i === 0} onClick={() => handlers.onMove(s.sectionId, -1)} />
                    <IconButton label={t('canvasMoveDownAria', { section: name })} icon={<ArrowDownIcon size={14} />} className="btn-ghost btn-sm" disabled={i === count - 1} onClick={() => handlers.onMove(s.sectionId, 1)} />
                    <IconButton label={t('canvasDuplicateAria', { section: name })} icon={<CopyIcon size={14} />} className="btn-ghost btn-sm" onClick={() => handlers.onDuplicate(s.sectionId)} />
                    <IconButton label={t('canvasDeleteAria', { section: name })} icon={<TrashIcon size={14} />} className="btn-ghost btn-sm" onClick={() => handlers.onRemove(s.sectionId)} />
                  </>
                ) : null}
              </div>
            </div>
            <RenderSection section={s} mode="public" />
          </>
        )}
      </div>
      {after}
    </>
  );
}
