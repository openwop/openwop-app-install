// @vitest-environment jsdom
/**
 * ADR 1055 D5/D6 — applying an AI reply from the chat back onto the document.
 *
 * RED on `13fb94b5d`: the return handoff carried only `{from, to}`, and the apply
 * refused only an out-of-range position. After any edit in between, the reply
 * struck whatever text now sat at those offsets ("changed" case below applied).
 * The whole reply was inserted verbatim (a ```fence``` included), and the
 * suggestion carried no author, so it read exactly like a typed one.
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { documentExtensions } from '../documentSchema.js';
import { applyRefusal, plainRewriteText, selectionText } from '../aiApply.js';
import { AI_SUGGESTION_AUTHOR, applyAsSuggestion } from '../trackChanges.js';

function editorWith(text: string): Editor {
  return new Editor({ extensions: documentExtensions(), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
}

describe('applyRefusal (ADR 1055 D5)', () => {
  it('allows an apply over the exact text the user asked about', () => {
    const ed = editorWith('The cat sat.');
    const asked = selectionText(ed.state.doc, 5, 8);
    expect(asked).toBe('cat');
    expect(applyRefusal(ed.state.doc, 5, 8, asked, 'dog')).toBeNull();
    ed.destroy();
  });

  it('refuses when the text at the range changed meanwhile', () => {
    const ed = editorWith('The cat sat.');
    const asked = selectionText(ed.state.doc, 5, 8);
    ed.commands.insertContentAt(1, 'Oh. '); // a peer typed before the range
    expect(applyRefusal(ed.state.doc, 5, 8, asked, 'dog')).toBe('changed');
    ed.destroy();
  });

  it('refuses a target with no expected text, an out-of-range position, and an empty reply', () => {
    const ed = editorWith('The cat sat.');
    expect(applyRefusal(ed.state.doc, 5, 8, undefined, 'dog')).toBe('changed');
    expect(applyRefusal(ed.state.doc, 5, 999, 'cat', 'dog')).toBe('changed');
    expect(applyRefusal(ed.state.doc, 5, 8, 'cat', '')).toBe('empty');
    ed.destroy();
  });
});

describe('plainRewriteText (ADR 1055 D5)', () => {
  it('strips one wrapping code fence and trims, and leaves everything else alone', () => {
    expect(plainRewriteText('```\nBetter text.\n```')).toBe('Better text.');
    expect(plainRewriteText('```text\nLine one.\n\nLine two.\n```  ')).toBe('Line one.\n\nLine two.');
    expect(plainRewriteText('  Plain reply.  ')).toBe('Plain reply.');
    expect(plainRewriteText('Use `code` here.')).toBe('Use `code` here.');
  });
});

describe('AI suggestions are attributed (ADR 1055 D6)', () => {
  it('an applied reply is an insertion marked author "ai" beside the struck original', () => {
    const ed = editorWith('The cat sat.');
    expect(applyAsSuggestion(ed, 5, 8, 'dog')).toBe(true);
    const marks: { type: string; author: unknown; text: string }[] = [];
    ed.state.doc.descendants((n) => { if (n.isText) for (const m of n.marks) marks.push({ type: m.type.name, author: m.attrs.author, text: n.text ?? '' }); });
    expect(marks).toEqual([
      { type: 'deletion', author: AI_SUGGESTION_AUTHOR, text: 'cat' },
      { type: 'insertion', author: AI_SUGGESTION_AUTHOR, text: 'dog' },
    ]);
    expect(AI_SUGGESTION_AUTHOR).toBe('ai');
    ed.destroy();
  });
});
