/**
 * collabExtension tests (ADR 0335 Phase 2a-ii) — the y-prosemirror TipTap binding.
 * Mounts a real editor with StarterKit(undoRedo:false) + collabExtension over a
 * Y.Doc and asserts the y-sync plugin binds the shared XmlFragment (an edit lands
 * in the Y.Doc) and the PER-USER y-undo plugin is installed (a global history
 * would let one user undo another's edits — the ADR 0335 undo-ownership rule).
 * The live multi-client sync is a browser/e2e concern (the backend room + the
 * useCollab seam are tested separately).
 *
 * Sabotage (wave 14): drop `ySyncPlugin(...)` → both cases red; bind a different
 * fragment name → case 2 red; drop `yUndoPlugin()` → case 1 red.
 *
 * Was BLOCKED-ON-PRODUCT (wave 14) as `it.fails`; FIXED in `documentSchema.ts`,
 * which now passes `{ undoRedo: false }`. What it pinned: the collab path builds its
 * extensions with `documentExtensions({ history: false })`
 * (DocumentEditorSurface.tsx:80), but StarterKit v3 has no `history` option — it
 * is `undoRedo` — so the GLOBAL undo/redo plugin is still installed next to
 * yUndoPlugin, breaking the ADR 0335 undo-ownership rule. The last case is the
 * witness.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPluginKey, yUndoPluginKey } from 'y-prosemirror';
import { undo as coreUndo } from '@tiptap/pm/history';
import { collabExtension, COLLAB_FRAGMENT } from '../collabExtension.js';
import { documentExtensions } from '../documentSchema.js';

function mount(ydoc: Y.Doc): Editor {
  return new Editor({
    element: document.createElement('div'),
    // StarterKit v3 names its history `undoRedo` (`history` is not an option and
    // was silently ignored here — a tsc error in this file until wave 14).
    extensions: [StarterKit.configure({ undoRedo: false }), collabExtension(ydoc, new Awareness(ydoc))],
  });
}

describe('collabExtension', () => {
  it('installs the y-sync plugin (per-user history, not prosemirror-history)', () => {
    const ydoc = new Y.Doc();
    const editor = mount(ydoc);
    try {
      expect(ySyncPluginKey.getState(editor.state)?.type).toBe(ydoc.getXmlFragment(COLLAB_FRAGMENT));
      // Per-user undo: the y-undo plugin owns an UndoManager over the shared type.
      expect(yUndoPluginKey.getState(editor.state)?.undoManager).toBeInstanceOf(Y.UndoManager);
    } finally { editor.destroy(); }
  });

  it('binds the editor to the shared Y.XmlFragment — an edit reaches the Y.Doc', () => {
    const ydoc = new Y.Doc();
    const editor = mount(ydoc);
    try {
      editor.commands.insertContent('hello crdt');
      expect(ydoc.getXmlFragment(COLLAB_FRAGMENT).toString()).toContain('hello crdt');
    } finally { editor.destroy(); }
  });

  // The ADR 0335 witness — see header. Built exactly as the collab path builds it.
  it('the collab extension set carries NO core undo/redo next to yUndoPlugin (ADR 0335)', () => {
    const ydoc = new Y.Doc();
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [...documentExtensions({ history: false }), collabExtension(ydoc, new Awareness(ydoc))],
    });
    try {
      expect(yUndoPluginKey.getState(editor.state)?.undoManager).toBeInstanceOf(Y.UndoManager);
      expect(editor.extensionManager.extensions.map((e) => e.name)).not.toContain('undoRedo');
      // Behaviorally: a local edit must not be undoable by the global history.
      editor.commands.insertContent('mine');
      expect(coreUndo(editor.state)).toBe(false);
    } finally { editor.destroy(); }
  });
});
