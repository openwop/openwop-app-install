/**
 * collabExtension tests (ADR 0335 Phase 2a-ii) — the y-prosemirror TipTap binding.
 * Mounts a real editor with StarterKit(history:false) + collabExtension over a
 * Y.Doc and asserts the y-sync plugin installs and the shared XmlFragment binds
 * (an edit lands in the Y.Doc). The live multi-client sync is a browser/e2e
 * concern (the backend room + the useCollab seam are tested separately).
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPluginKey } from 'y-prosemirror';
import { collabExtension, COLLAB_FRAGMENT } from '../collabExtension.js';

function mount(ydoc: Y.Doc): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ history: false }), collabExtension(ydoc, new Awareness(ydoc))],
  });
}

describe('collabExtension', () => {
  it('installs the y-sync plugin (per-user history, not prosemirror-history)', () => {
    const ydoc = new Y.Doc();
    const editor = mount(ydoc);
    const hasYSync = editor.state.plugins.some((p) => (p as { key?: string }).key === (ySyncPluginKey as { key: string }).key);
    expect(hasYSync).toBe(true);
    editor.destroy();
  });

  it('binds the editor to the shared Y.XmlFragment — an edit reaches the Y.Doc', () => {
    const ydoc = new Y.Doc();
    const editor = mount(ydoc);
    editor.commands.insertContent('hello crdt');
    expect(ydoc.getXmlFragment(COLLAB_FRAGMENT).toString()).toContain('hello crdt');
    editor.destroy();
  });
});
