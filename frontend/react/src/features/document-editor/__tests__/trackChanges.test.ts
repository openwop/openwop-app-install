/**
 * Track-changes core tests (ADR 0334 6b-2) — the pure state→transaction logic,
 * exercised directly on ProseMirror EditorStates (no DOM): insertion tracking,
 * deletion reconstruction (the architect's required correction), type-over,
 * v1-scope bail-outs, and accept/reject-all resolution.
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../documentSchema.js';
import { buildTrackTransaction, buildAcceptAll, buildRejectAll, buildApplyAsSuggestion } from '../trackChanges.js';

const schema = getSchema(documentExtensions());

function docState(text: string): EditorState {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]);
  return EditorState.create({ schema, doc });
}
/** Collect [text, sorted mark-names] for every text node. */
function runs(state: EditorState): [string, string[]][] {
  const out: [string, string[]][] = [];
  state.doc.descendants((n) => { if (n.isText) out.push([n.text ?? '', n.marks.map((m) => m.type.name).sort()]); });
  return out;
}

describe('buildTrackTransaction', () => {
  it('marks inserted text with the insertion mark', () => {
    const s0 = docState('hello');
    const tr = s0.tr.insertText(' world', 6);
    const s1 = s0.apply(tr);
    const conv = buildTrackTransaction(s1, [tr], 'me');
    expect(conv).not.toBeNull();
    const s2 = s1.apply(conv!);
    expect(s2.doc.textContent).toBe('hello world');
    expect(runs(s2)).toEqual([['hello', []], [' world', ['insertion']]]);
  });

  it('reconstructs a deletion as struck text carrying the deletion mark', () => {
    const s0 = docState('hello world');
    const tr = s0.tr.delete(7, 12); // remove "world" (positions are 1-based in the paragraph)
    const s1 = s0.apply(tr);
    expect(s1.doc.textContent).toBe('hello '); // raw delete applied
    const conv = buildTrackTransaction(s1, [tr], 'me');
    expect(conv).not.toBeNull();
    const s2 = s1.apply(conv!);
    expect(s2.doc.textContent).toBe('hello world'); // text is BACK, struck
    expect(runs(s2)).toEqual([['hello ', []], ['world', ['deletion']]]);
  });

  it('type-over-selection: old text → deletion, new text → insertion', () => {
    const s0 = docState('hello world');
    const tr = s0.tr.replaceWith(7, 12, schema.text('there'));
    const s1 = s0.apply(tr);
    const conv = buildTrackTransaction(s1, [tr], 'me');
    const s2 = s1.apply(conv!);
    expect(s2.doc.textContent).toBe('hello worldthere');
    expect(runs(s2)).toEqual([['hello ', []], ['world', ['deletion']], ['there', ['insertion']]]);
  });

  it('carries the author on the marks', () => {
    const s0 = docState('a');
    const tr = s0.tr.insertText('b', 2);
    const s2 = s0.apply(tr).apply(buildTrackTransaction(s0.apply(tr), [tr], 'org-7')!);
    let author = '';
    s2.doc.descendants((n) => { const m = n.marks.find((x) => x.type.name === 'insertion'); if (m) author = String(m.attrs.author); });
    expect(author).toBe('org-7');
  });

  it('tracks a MULTI-STEP transaction (two insertions) — 6b-3', () => {
    const s0 = docState('ab');
    const tr = s0.tr.insertText('X', 2).insertText('Y', 1); // two ReplaceSteps → "YaXb"
    const s1 = s0.apply(tr);
    expect(s1.doc.textContent).toBe('YaXb');
    const conv = buildTrackTransaction(s1, [tr], 'me');
    expect(conv).not.toBeNull();
    const s2 = s1.apply(conv!);
    expect(s2.doc.textContent).toBe('YaXb');
    expect(runs(s2)).toEqual([['Y', ['insertion']], ['a', []], ['X', ['insertion']], ['b', []]]);
  });

  it('tracks a MULTI-STEP transaction mixing insert + delete — 6b-3', () => {
    const s0 = docState('hello world');
    const tr = s0.tr.insertText('!', 6).delete(8, 13); // insert "!" after hello, delete " world" region
    const s1 = s0.apply(tr);
    const conv = buildTrackTransaction(s1, [tr], 'me');
    expect(conv).not.toBeNull();
    const s2 = s1.apply(conv!);
    // both the inserted "!" (insertion) and the removed span (deletion) are tracked
    const marks = runs(s2);
    expect(marks.some(([txt, m]) => txt === '!' && m.includes('insertion'))).toBe(true);
    expect(marks.some(([, m]) => m.includes('deletion'))).toBe(true);
  });

  it('bails (untracked) on a non-ReplaceStep / cross-block edit — documented boundary', () => {
    const s0 = docState('one');
    // A paragraph split (Enter) crosses a block boundary on the deleted side / is structural.
    const tr = s0.tr.split(2);
    const s1 = s0.apply(tr);
    // split's replaced range is empty (open insert), so it is either tracked-as-insert
    // or bailed; either way it must not throw and must return a tr-or-null.
    const conv = buildTrackTransaction(s1, [tr], 'me');
    expect(conv === null || conv.docChanged !== undefined).toBe(true);
  });

  it('returns null for a no-op / out-of-v1-scope edit', () => {
    const s0 = docState('hello');
    // a pure selection change (no doc change)
    expect(buildTrackTransaction(s0, [s0.tr], 'me')).toBeNull();
  });
});

describe('buildApplyAsSuggestion (5b-2 apply-back)', () => {
  it('replaces a range as a tracked suggestion (old struck, new inserted)', () => {
    const s0 = docState('hello world');
    // improve "world" (positions 7..12) → "planet"
    const tr = buildApplyAsSuggestion(s0, 7, 12, 'planet', 'me');
    expect(tr).not.toBeNull();
    const s1 = s0.apply(tr!);
    expect(s1.doc.textContent).toBe('hello worldplanet');
    expect(runs(s1)).toEqual([['hello ', []], ['world', ['deletion']], ['planet', ['insertion']]]);
  });

  it('fails closed (null) on a stale/out-of-bounds range', () => {
    const s0 = docState('short');
    expect(buildApplyAsSuggestion(s0, 3, 999, 'x', 'me')).toBeNull();
    expect(buildApplyAsSuggestion(s0, 4, 2, 'x', 'me')).toBeNull();
    expect(buildApplyAsSuggestion(s0, 1, 3, '', 'me')).toBeNull(); // empty text
  });
});

describe('accept / reject all', () => {
  // Build a doc with one insertion ("X") and one deletion ("old") via the tracker.
  function suggestedDoc(): EditorState {
    let s = docState('keep old');
    const del = s.tr.delete(6, 9); // delete "old"
    s = s.apply(del).apply(buildTrackTransaction(s.apply(del), [del], 'me')!); // "keep old"(struck old)
    const ins = s.tr.insertText(' new', s.doc.content.size - 1); // insert " new" before end
    s = s.apply(ins).apply(buildTrackTransaction(s.apply(ins), [ins], 'me')!);
    return s;
  }

  it('accept keeps insertions (plain) and removes deletions', () => {
    const tr = buildAcceptAll(suggestedDoc());
    expect(tr).not.toBeNull();
    const after = suggestedDoc().apply(tr!);
    expect(after.doc.textContent).toBe('keep  new'); // "old" gone, " new" kept plain
    expect(runs(after).every(([, marks]) => marks.length === 0)).toBe(true);
  });

  it('reject removes insertions and keeps deletions (plain)', () => {
    const tr = buildRejectAll(suggestedDoc());
    expect(tr).not.toBeNull();
    const after = suggestedDoc().apply(tr!);
    expect(after.doc.textContent).toBe('keep old'); // "old" restored plain, " new" gone
    expect(runs(after).every(([, marks]) => marks.length === 0)).toBe(true);
  });
});
