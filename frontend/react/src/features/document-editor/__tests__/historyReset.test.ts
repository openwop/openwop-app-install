/**
 * Review-of-#1601 F3 — the external-seed history reset: rebuilding the plugin
 * state (drop-all → re-add) resets the ProseMirror history plugin, so undo
 * after a version restore cannot resurrect the pre-restore document. Tested at
 * the prosemirror-state level (the exact mechanism the surface uses).
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

describe('external-seed history reset (the DocumentEditorSurface mechanism)', () => {
  it('reconfigure-empty-then-back clears the undo stack; plain reconfigure would not', () => {
    let state = EditorState.create({ schema, plugins: [history()] });
    // One undoable edit.
    state = state.apply(state.tr.insertText('hello', 1));
    expect(undoDepth(state)).toBeGreaterThan(0);
    expect(undo(state)).toBe(true); // undoable before the reset

    // The surface's reset: drop all plugins, re-add the same instances.
    const reset = state.reconfigure({ plugins: [] }).reconfigure({ plugins: state.plugins });
    expect(reset.doc.textContent).toBe('hello'); // content survives
    expect(undoDepth(reset)).toBe(0); // history is fresh
    expect(undo(reset)).toBe(false); // nothing to undo — the restore is final
  });
});
