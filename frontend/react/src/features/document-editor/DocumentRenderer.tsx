/**
 * The `canvas.document` read-only renderer (ADR 0334 Phase 1) — the ONE renderer
 * for the chat card, the shared/public view, and the non-edit preview. It parses
 * the canvas content string, then renders the SAME closed schema through a
 * non-editable TipTap instance (no `dangerouslySetInnerHTML` — the doc renders
 * via the engine's own reconciler, so authored and rendered content can never
 * drift and no raw HTML is injected). The editor SURFACE replaces this in edit
 * mode (center-panel precedence); this is the read path.
 */
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { documentExtensions } from './documentSchema.js';
import { coerceDocument, EMPTY_DOC } from './documentDoc.js';

function parseContent(content: string): JSONContent {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Accept either the canvas state ({ title, content }) OR a bare PM doc
      // node (a future chat-card payload) — both round-trip to the doc node.
      if (obj.type === 'doc') return obj as JSONContent;
      return coerceDocument(obj).content;
    }
  } catch {
    // fall through to empty
  }
  return EMPTY_DOC;
}

export function DocumentRenderer({ content }: { content: string; editPaths?: boolean }): JSX.Element {
  const { t } = useTranslation('document-editor');
  const editor = useEditor({
    editable: false,
    extensions: documentExtensions(),
    content: parseContent(content),
    editorProps: { attributes: { class: 'doc-editor__content', 'aria-label': t('readAriaLabel') } },
  }, [content]);

  return (
    <div className="doc-editor doc-editor--read">
      {editor ? <EditorContent editor={editor} /> : <div aria-busy="true" />}
    </div>
  );
}
