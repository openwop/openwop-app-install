/**
 * The `/` slash-command extension (ADR 0334 Phase 2) — a ProseMirror suggestion
 * plugin that mounts the accessible `SlashMenu` popup on `/`. Positioned manually
 * from the suggestion `clientRect` (no tippy dependency); closes on Escape,
 * click-away, or when the match breaks. Added ONLY to the editable surface (the
 * read-only renderer never loads it).
 */
import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { Suggestion } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import { SlashMenu } from './SlashMenu.js';
import type { SlashMenuHandle } from './SlashMenu.js';
import type { SlashItem } from './slashItems.js';
import { filterSlashItems } from './slashItems.js';

export interface SlashCommandOptions {
  items: SlashItem[];
  emptyLabel: string;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',
  addOptions() {
    return { items: [], emptyLabel: '' };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => filterSlashItems(options.items, query),
        command: ({ editor, range, props }) => { props.run(editor as Editor, range as Range); },
        render: () => {
          let component: ReactRenderer<SlashMenuHandle> | null = null;
          let el: HTMLDivElement | null = null;
          let closed = false;
          let onDocMouseDown: ((e: MouseEvent) => void) | null = null;

          const propsFor = (items: SlashItem[], command: (item: SlashItem) => void) => ({
            items, command, emptyLabel: options.emptyLabel, listId: 'doc-slash',
          });
          // Review of #1601 (F5): clamp to the viewport (a caret near the
          // bottom/right edge flips/pins the popup back on-screen) and track
          // the caret while the page scrolls (position:fixed would otherwise
          // detach the menu from the text).
          let latestRect: (() => DOMRect | null) | null = null;
          const position = (rect: DOMRect | null): void => {
            if (!el || !rect) return;
            const w = el.offsetWidth || 240;
            const h = el.offsetHeight || 200;
            const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - w - 8));
            let top = Math.round(rect.bottom + 6);
            if (top + h > window.innerHeight - 8) top = Math.max(8, Math.round(rect.top - h - 6));
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
          };
          const reposition = (): void => { position(latestRect?.() ?? null); };
          const teardown = (): void => {
            if (onDocMouseDown) { document.removeEventListener('mousedown', onDocMouseDown); onDocMouseDown = null; }
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            latestRect = null;
            el?.remove(); el = null;
            component?.destroy(); component = null;
          };

          return {
            onStart: (p) => {
              closed = false;
              component = new ReactRenderer(SlashMenu, {
                editor: p.editor,
                props: propsFor(p.items, (item) => p.command(item)),
              });
              el = document.createElement('div');
              el.className = 'doc-slash__popup';
              el.appendChild(component.element);
              document.body.appendChild(el);
              latestRect = p.clientRect ?? null;
              position(p.clientRect?.() ?? null);
              onDocMouseDown = (e: MouseEvent) => { if (el && !el.contains(e.target as Node)) { closed = true; teardown(); } };
              document.addEventListener('mousedown', onDocMouseDown);
              window.addEventListener('scroll', reposition, true);
              window.addEventListener('resize', reposition);
            },
            onUpdate: (p) => {
              if (closed) return;
              component?.updateProps(propsFor(p.items, (item) => p.command(item)));
              latestRect = p.clientRect ?? null;
              position(p.clientRect?.() ?? null);
            },
            onKeyDown: (p) => {
              if (closed) return false;
              if (p.event.key === 'Escape') { closed = true; teardown(); return true; }
              return component?.ref?.onKeyDown(p.event) ?? false;
            },
            onExit: () => { teardown(); },
          };
        },
      }),
    ];
  },
});
