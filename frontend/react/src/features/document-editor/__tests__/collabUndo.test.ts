/**
 * Per-user undo across two collaborating editors (COLLAB-UNDO-1, ADR 0335's
 * undo-ownership rule): when B edits text A typed, A's undo must remove only A's
 * text and leave B's exactly as B typed it.
 *
 * Why this needs a patch: y-prosemirror 1.3.7 writes a ProseMirror edit into the
 * Y.Text by diffing old and new strings with lib0 `simpleDiff`, which does not
 * know where the caret was. When B types "b" before A's "alpha", the diff is
 * ambiguous and it credits B with A's "a" instead, so A's undo deletes B's
 * character ("bet replieda", the e2e red at collab.spec.ts:185). The fix is
 * `frontend/react/patches/y-prosemirror+1.3.7.patch` (applied by the postinstall
 * `patch-package`): the sync plugin records where the local edit started and
 * diffs with lib0 `simpleDiffStringWithCursor` at that offset. 1.3.7 is the
 * newest 1.x, so there is no upstream release to take.
 *
 * Known limitation, pinned below (user decision 2026-11-08 13:07Z): when B
 * SPLITS a paragraph in the middle of A's text and types, the text after the
 * split moves into a new Y.XmlText that B's transaction created. A's undo cannot
 * reach those characters, so A's tail survives. This is structural (a split is a
 * delete plus re-insert in Yjs), not a diff choice.
 *
 * Sabotage (each witnessed red against the UNPATCHED y-prosemirror, i.e. with the
 * patch reverted in node_modules): positions 1/no-split and 1/split go red
 * ("bet replieda"); the bold case goes red ("la", not "al"). The limitation pin
 * goes red if the split behaviour changes either way. The other cases are controls
 * the patch must not break: an end-of-text append (position 17), repeated
 * characters, an insert B deletes again, B's own undo, and single-user sync.
 *
 * Probe ceiling: the patch lives in untracked node_modules, so the sabotage-probe
 * runner cannot revert it; the unpatched reds above are the recorded manual
 * witness (docs/steward/COLLAB-UNDO-INVESTIGATION.md). Runner-witnessed (wave 97):
 * dropping `yUndoPlugin()` from `collabExtension` reds every undo case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { undo } from 'y-prosemirror';
import { collabExtension } from '../collabExtension.js';
import { documentExtensions } from '../documentSchema.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Two editors on two Y.Docs, updates forwarded synchronously with a remote origin. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const awarenessA = new Awareness(a);
  const awarenessB = new Awareness(b);
  const mount = (doc: Y.Doc, awareness: Awareness) =>
    new Editor({
      element: document.createElement('div'),
      extensions: [...documentExtensions({ history: false }), collabExtension(doc, awareness)],
    });
  const A = mount(a, awarenessA);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'peer');
  const forwardA = (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(b, u, 'peer');
  };
  const forwardB = (u: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(a, u, 'peer');
  };
  a.on('update', forwardA);
  b.on('update', forwardB);
  const B = mount(b, awarenessB);
  cleanups.push(() => {
    a.off('update', forwardA);
    b.off('update', forwardB);
    A.destroy();
    B.destroy();
    awarenessA.destroy();
    awarenessB.destroy();
    a.destroy();
    b.destroy();
  });
  return { A, B };
}

function type(editor: Editor, text: string) {
  for (const char of text) editor.commands.insertContent(char);
}

describe('collaborative undo keeps the other user\'s text (COLLAB-UNDO-1)', () => {
  it.each([
    { position: 1, split: false },
    { position: 1, split: true },
    { position: 17, split: true },
  ])('B types at position $position (split=$split); A undo leaves exactly "beta replied"', ({ position, split }) => {
    const { A, B } = pair();
    type(A, 'alpha wrote this');
    expect(B.getText()).toBe('alpha wrote this');
    B.commands.setTextSelection(position);
    if (split) B.commands.splitBlock();
    type(B, 'beta replied');
    expect(A.getText()).toContain('beta replied');
    expect(undo(A.state)).toBe(true);
    expect(A.getText().trim()).toBe('beta replied');
    expect(B.getText()).toBe(A.getText());
  });

  it('KNOWN LIMITATION: B splits inside A\'s text; A undo keeps A\'s moved tail', () => {
    // COLLAB-UNDO-1 known limitation (user decision 2026-11-08 13:07Z). If this
    // starts passing as "beta replied", the limitation is gone: update the TODO
    // row and turn this into a case of the table above.
    const { A, B } = pair();
    type(A, 'alpha wrote this');
    B.commands.setTextSelection(4);
    B.commands.splitBlock();
    type(B, 'beta replied');
    expect(undo(A.state)).toBe(true);
    expect(A.getText().trim()).toBe('beta repliedha wrote this');
    expect(B.getText()).toBe(A.getText());
  });

  it('repeated characters: B inserts inside A\'s "aaaa"; A undo leaves B\'s one "a"', () => {
    const { A, B } = pair();
    type(A, 'aaaa');
    B.commands.setTextSelection(3);
    B.commands.insertContent('a');
    expect(A.getText()).toBe('aaaaa');
    expect(undo(A.state)).toBe(true);
    expect(A.getText()).toBe('a');
    expect(B.getText()).toBe('a');
  });

  it('B types then deletes its own character; A undo empties the document', () => {
    const { A, B } = pair();
    type(A, 'alpha');
    B.commands.setTextSelection(1);
    B.commands.insertContent('a');
    B.commands.deleteRange({ from: 1, to: 2 });
    expect(A.getText()).toBe('alpha');
    expect(undo(A.state)).toBe(true);
    expect(A.getText()).toBe('');
    expect(B.getText()).toBe('');
  });

  it('B types bold "al" before A\'s "alpha"; A undo keeps exactly B\'s bold "al"', () => {
    const { A, B } = pair();
    type(A, 'alpha');
    B.commands.setTextSelection(1);
    B.commands.setMark('bold');
    type(B, 'al');
    expect(undo(A.state)).toBe(true);
    expect(A.getText()).toBe('al');
    expect(B.getText()).toBe('al');
    expect(A.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'al', marks: [{ type: 'bold' }] }] }],
    });
  });

  it('B\'s undo removes only B\'s prepended text', () => {
    const { A, B } = pair();
    type(A, 'alpha wrote this');
    B.commands.setTextSelection(1);
    type(B, 'beta ');
    undo(B.state);
    expect(A.getText()).toBe('alpha wrote this');
    expect(B.getText()).toBe('alpha wrote this');
  });

  it('one user typing, deleting and inserting still syncs exactly', () => {
    const { A, B } = pair();
    type(A, 'hello world');
    A.commands.deleteRange({ from: 6, to: 7 });
    A.commands.setTextSelection(3);
    A.commands.insertContent('l');
    expect(A.getText()).toBe('hellloworld');
    expect(B.getText()).toBe('hellloworld');
  });
});
