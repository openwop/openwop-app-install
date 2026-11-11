/**
 * ADR 1055 — the editor surface as a whole (DE87CD-7 / DE87UX-21): the parts the
 * pure-helper tests cannot see.
 *
 *  - D2: a stored document holding an unknown node opens with its good content
 *    and a visible, announced notice (RED on `13fb94b5d`: the editor opened
 *    blank).
 *  - D5: a pending AI apply lands only over the text it was asked about; a
 *    changed range is refused with a VISIBLE notice, not only a screen-reader
 *    line; a pending apply for another document is left alone; and in a collab
 *    session nothing is consumed until the room has synced and seeded.
 *  - DE87UX-3: turning suggesting mode on announces "on".
 *
 * Sabotage: drop the peek-first branch → the other-document case red; drop the
 * collab readiness gate → the collab case red; restore the inverted ternary →
 * the suggesting case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ pathname: '/document-editor/c1' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}(${String(o.count)})` : k) }) }));
vi.mock('../../comments/CommentsPanel.js', () => ({ CommentsPanel: () => null }));
vi.mock('../../media/MediaPickerDialog.js', () => ({ MediaPickerDialog: () => null }));

import { DocumentEditorSurface } from '../DocumentEditorSurface.js';
import { stagePendingApply, peekPendingApply, stageReturnTarget, getReturnTarget, __resetReturnTarget } from '../../../chat/returnTarget.js';
import type { CollabState } from '../../../canvas/useCollab.js';
import type { DocumentDoc } from '../documentDoc.js';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docOf = (...content: unknown[]): DocumentDoc => ({ title: 'T', content: { type: 'doc', content } as DocumentDoc['content'] });

function mount(doc: DocumentDoc, opts: { canvasId?: string; collab?: CollabState } = {}) {
  const onAnnounce = vi.fn();
  const utils = render(
    <DocumentEditorSurface orgId="o1" canvasId={opts.canvasId ?? 'c1'} doc={doc} onDocChange={vi.fn()} onAnnounce={onAnnounce}
      {...(opts.collab ? { collab: opts.collab } : {})} />,
  );
  return { onAnnounce, ...utils };
}

const editorText = (): string => document.querySelector('.doc-editor__content')?.textContent ?? '';

beforeEach(() => { __resetReturnTarget(); });
afterEach(() => { cleanup(); __resetReturnTarget(); });

describe('DocumentEditorSurface (ADR 1055)', () => {
  it('opens a document holding an unknown node with its good content and a notice', async () => {
    mount(docOf(para('keep me'), { type: 'notARealNode' }));
    await act(async () => {});
    expect(editorText()).toContain('keep me');
    expect(screen.getByText('repairedOnOpen(1)')).toBeTruthy();
  });

  it('applies a pending reply over the exact text it was asked about, as a suggestion', async () => {
    // "The cat sat." — `cat` is positions 5..8 in the doc.
    stagePendingApply({ canvasId: 'c1', from: 5, to: 8, expectedText: 'cat', text: 'dog' });
    const { onAnnounce } = mount(docOf(para('The cat sat.')));
    await act(async () => {});
    expect(onAnnounce).toHaveBeenCalledWith('aiApplied');
    expect(document.querySelector('ins.doc-ins[data-author="ai"]')?.textContent).toBe('dog');
    expect(document.querySelector('del.doc-del')?.textContent).toBe('cat');
    expect(peekPendingApply()).toBeNull();
  });

  it('refuses a reply whose range now holds other text, with a visible notice', async () => {
    stagePendingApply({ canvasId: 'c1', from: 5, to: 8, expectedText: 'cat', text: 'dog' });
    mount(docOf(para('The bat sat.')));
    await act(async () => {});
    expect(screen.getByText('aiApplyChanged')).toBeTruthy();
    expect(document.querySelector('ins.doc-ins')).toBeNull();
  });

  it('leaves a pending apply for another document alone', async () => {
    stagePendingApply({ canvasId: 'other', from: 5, to: 8, expectedText: 'cat', text: 'dog' });
    mount(docOf(para('The cat sat.')));
    await act(async () => {});
    expect(peekPendingApply()?.canvasId).toBe('other');
    expect(document.querySelector('ins.doc-ins')).toBeNull();
  });

  it('in a collab session, consumes nothing until the room has synced and seeded', async () => {
    const ydoc = new Y.Doc();
    let resolveSeed: (won: boolean) => void = () => {};
    const seed = new Promise<boolean>((r) => { resolveSeed = r; });
    const base = { enabled: true as const, ydoc, awareness: new Awareness(ydoc), connected: true, failed: false, claimSeed: () => seed };
    stagePendingApply({ canvasId: 'c1', from: 5, to: 8, expectedText: 'cat', text: 'dog' });
    const doc = docOf(para('The cat sat.'));
    const { rerender, onAnnounce } = mount(doc, { collab: { ...base, synced: false } });
    await act(async () => {});
    expect(peekPendingApply()).not.toBeNull(); // not synced: untouched
    rerender(<DocumentEditorSurface orgId="o1" canvasId="c1" doc={doc} onDocChange={vi.fn()} onAnnounce={onAnnounce} collab={{ ...base, synced: true }} />);
    await act(async () => {});
    expect(peekPendingApply()).not.toBeNull(); // synced, seed pending: untouched
    await act(async () => { resolveSeed(true); await seed; });
    expect(editorText()).toContain('dog');
    expect(onAnnounce).toHaveBeenCalledWith('aiApplied');
  });

  it('announces suggesting mode ON when it is turned on', async () => {
    const { onAnnounce } = mount(docOf(para('x')));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'suggestMode' }));
    expect(onAnnounce).toHaveBeenCalledWith('suggestOn');
  });

  // DE87UX-4 — back from the chat WITHOUT applying: the staged target is stale.
  it('clears a staged Apply target for this document when it comes back with nothing to apply', async () => {
    stageReturnTarget({ label: 'T', returnPath: '/document-editor/c1', canvasId: 'c1', from: 1, to: 2, expectedText: 'x', agentId: 'a' });
    mount(docOf(para('x')));
    await act(async () => {});
    expect(getReturnTarget()).toBeNull();
  });

  // DE87UX-1/26 — arrow keys move one tab stop across ENABLED buttons only.
  it('arrows across the toolbar skip a disabled button and keep one tab stop', async () => {
    mount(docOf(para('x')), { canvasId: '' }); // unsaved: the Comment button is disabled
    await act(async () => {});
    const toolbar = screen.getByRole('toolbar');
    const enabled = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const disabled = toolbar.querySelector<HTMLButtonElement>('button:disabled');
    expect(disabled).not.toBeNull();
    enabled[0]!.focus();
    for (let i = 0; i < enabled.length; i++) fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(enabled[0]); // wrapped round, never stuck on the disabled one
    expect(Array.from(toolbar.querySelectorAll('button')).filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  // DE87UX-2 — Accept decides its scope from the live selection at click time.
  it('accepts only the suggestion under the cursor, not every suggestion', async () => {
    const two = docOf({ type: 'paragraph', content: [
      { type: 'text', text: 'aa', marks: [{ type: 'insertion', attrs: { author: '' } }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'bb', marks: [{ type: 'insertion', attrs: { author: '' } }] },
    ] });
    mount(two);
    await act(async () => {});
    // Put the caret inside "aa" (doc positions 1..3) through the editor DOM.
    const ins = document.querySelectorAll('ins.doc-ins');
    expect(ins).toHaveLength(2);
    const range = document.createRange();
    range.setStart(ins[0]!.firstChild!, 1); range.collapse(true);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    fireEvent.click(screen.getByRole('button', { name: 'acceptChange' }));
    expect(document.querySelectorAll('ins.doc-ins')).toHaveLength(1);
    expect(document.querySelector('ins.doc-ins')?.textContent).toBe('bb');
  });
});

