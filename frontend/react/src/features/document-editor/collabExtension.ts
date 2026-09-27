/**
 * y-prosemirror TipTap binding for canvas.document (ADR 0335 Phase 2a-ii).
 *
 * Wraps the three y-prosemirror ProseMirror plugins as ONE TipTap extension so
 * the DocumentEditorSurface can add it (and configure StarterKit's `history:
 * false`) when a collab session is live:
 *   - `ySyncPlugin(yXmlFragment)` — binds the editor doc to a `Y.XmlFragment`
 *     (the CRDT is the source of truth; the `content` prop is NOT set when collab
 *     is on);
 *   - `yCursorPlugin(awareness)` — renders remote carets/selections as decorations;
 *   - `yUndoPlugin()` — PER-USER undo/redo (supersedes StarterKit `history` while
 *     collab is on — a global history would let one user undo another's edits,
 *     the ADR 0335 undo-ownership correction to ADR 0334).
 *
 * The fragment key is fixed (`'doc'`) so every client + the backend snapshot
 * agree on the shared root.
 */
import { Extension } from '@tiptap/core';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undo, redo } from 'y-prosemirror';
import type { Doc as YDoc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export const COLLAB_FRAGMENT = 'doc';

export function collabExtension(ydoc: YDoc, awareness: Awareness): Extension {
  return Extension.create({
    name: 'collab',
    addProseMirrorPlugins() {
      return [
        ySyncPlugin(ydoc.getXmlFragment(COLLAB_FRAGMENT)),
        yCursorPlugin(awareness),
        yUndoPlugin(),
      ];
    },
    // StarterKit `history` is OFF in collab mode, and yUndoPlugin supplies
    // commands but NO keymap — without these, Ctrl+Z is dead in a live session
    // (the ADR 0359 Phase 7 e2e finding). Same trio TipTap's official
    // Collaboration extension binds.
    addKeyboardShortcuts() {
      return {
        'Mod-z': () => undo(this.editor.state),
        'Mod-y': () => redo(this.editor.state),
        'Shift-Mod-z': () => redo(this.editor.state),
      };
    },
  });
}
