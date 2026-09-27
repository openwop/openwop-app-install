/**
 * Canvas framework — the template preview gallery (audit gap #5).
 *
 * A THIN ADAPTER over the shared `ui/TemplateGallery` (DESIGN.md §4.5 rule 14),
 * not a second gallery. It contributes the one genuinely canvas-specific thing:
 * each template is previewed through the type's SHARED Renderer (a synthesized
 * single-frame doc — no forked render path), so you see what you get before
 * adding. Search, category filtering, grid chrome, and the empty / no-match /
 * failed states now come from the shared component — this gallery gained them
 * without any work here, which is the point of having one.
 */
import type { ComponentType, JSX } from 'react';
import { TemplateGalleryDialog, type TemplateItem } from '../ui/TemplateGallery.js';
import type { FrameTemplateDto } from './canvasClient.js';

export function TemplateGallery({ templates, renderContent, Renderer, onUse, onClose, labels }: {
  templates: readonly FrameTemplateDto[];
  /** Synthesize a renderable doc (JSON) containing just this template's frame. */
  renderContent: (tpl: FrameTemplateDto) => string;
  Renderer: ComponentType<{ content: string; editPaths?: boolean }>;
  onUse: (tpl: FrameTemplateDto) => void;
  onClose: () => void;
  /** Only the title: the CTA's wording belongs to the shared gallery, so a
   *  `use` label here would be a prop that silently does nothing. */
  labels: { title: string };
}): JSX.Element {
  const byId = new Map(templates.map((tpl) => [tpl.id, tpl]));
  const items: TemplateItem[] = templates.map((tpl) => ({
    id: tpl.id,
    label: tpl.name,
    ...(tpl.description ? { description: tpl.description } : {}),
  }));

  return (
    <TemplateGalleryDialog
      title={labels.title}
      items={items}
      onClose={onClose}
      onUse={(id) => { const tpl = byId.get(id); if (tpl) onUse(tpl); }}
      renderPreview={(item) => {
        const tpl = byId.get(item.id);
        return tpl ? <Renderer content={renderContent(tpl)} /> : null;
      }}
    />
  );
}
