/**
 * Track-changes ("suggesting mode") for canvas.document (ADR 0334 6b-2).
 *
 * A TipTap extension wrapping a ProseMirror plugin. When suggesting mode is ON,
 * `appendTransaction` rewrites each user edit into tracked suggestions instead of
 * mutating the text: inserted text gets the `insertion` mark; deleted text is
 * RE-INSERTED (reconstructed from the pre-step doc — the architect's required
 * correction, since by append-time the content is already gone) carrying the
 * `deletion` mark, struck but never actually removed until accepted.
 *
 * Scope (6b-2 + 6b-3): any number of flat `ReplaceStep`s across the batch — i.e.
 * typing, Backspace/Delete, paste, type-over-selection, and multi-step text edits
 * WITHIN text blocks. Still out of scope (bail the batch → applied untracked):
 * cross-block deletions (open slices), non-`ReplaceStep` structural edits
 * (`ReplaceAroundStep`, splits/joins across blocks), and mark/format-change
 * tracking — these want a changeset + deletion-decoration rearchitecture. The
 * conversion rides the user's own history event (no `addToHistory:false`) so one
 * Cmd+Z reverts edit+conversion together (ADR 0334 undo-ownership).
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep, Mapping } from '@tiptap/pm/transform';
import type { Editor } from '@tiptap/core';
import type { MarkType, Node as PMNode, Fragment } from '@tiptap/pm/model';

export const trackChangesKey = new PluginKey<TrackState>('doc-track-changes');
/** Marks a transaction the plugin must not re-process (its own conversion + accept/reject). */
const SKIP = 'trackChangesSkip';

interface TrackState { suggesting: boolean }

export function isSuggesting(state: EditorState): boolean {
  return trackChangesKey.getState(state)?.suggesting ?? false;
}

export function toggleSuggesting(editor: Editor): void {
  const next = !isSuggesting(editor.state);
  editor.view.dispatch(editor.state.tr.setMeta(trackChangesKey, { suggesting: next }));
}

/**
 * Pure core (exported for tests): given the user transactions that just applied
 * to `newState`, return the follow-up transaction that converts the edit into
 * tracked suggestions, or null when the edit is out of v1 scope (applied as-is).
 */
export function buildTrackTransaction(
  newState: EditorState, transactions: readonly Transaction[], author: string,
): Transaction | null {
  const ins = newState.schema.marks.insertion;
  const del = newState.schema.marks.deletion;
  if (!ins || !del) return null;

  const changed = transactions.filter((t) => t.docChanged && !t.getMeta(SKIP));
  if (changed.length === 0) return null;

  // Flatten every step across the batch, pairing each with the doc BEFORE it
  // (6b-3 — generalised from 6b-2's single-step case to N flat ReplaceSteps, so
  // multi-step text edits are tracked too). Cross-block deletions (open slices)
  // and non-ReplaceStep structural edits are still out of scope → bail the batch.
  const steps: { step: ReplaceStep; docBefore: PMNode }[] = [];
  for (const t of changed) {
    for (let i = 0; i < t.steps.length; i++) {
      const s = t.steps[i]!;
      if (!(s instanceof ReplaceStep)) return null;
      const docBefore = t.docs[i]!;
      const deleted = docBefore.slice(s.from, s.to);
      if (deleted.openStart > 0 || deleted.openEnd > 0) return null; // cross-block → later
      steps.push({ step: s, docBefore });
    }
  }

  // Map each step's inserted-range start into FINAL (newState) coordinates by
  // composing the maps of the steps that follow it within the batch.
  const maps = steps.map((s) => s.step.getMap());
  const full = new Mapping(maps);
  interface Entry { at: number; insSize: number; deletedContent: Fragment; delSize: number }
  const entries: Entry[] = [];
  for (let j = 0; j < steps.length; j++) {
    const { step, docBefore } = steps[j]!;
    const insSize = step.slice.content.size;
    const deleted = docBefore.slice(step.from, step.to);
    const delSize = deleted.content.size;
    if (insSize === 0 && delSize === 0) continue;
    const at = full.slice(j + 1).map(step.from, 1); // after-this-step → final doc
    entries.push({ at, insSize, deletedContent: deleted.content, delSize });
  }
  if (entries.length === 0) return null;

  const tr = newState.tr;
  let lastCaret = 0;
  for (const e of entries) {
    const at = tr.mapping.map(e.at); // account for our own earlier re-insertions
    // 1. Mark the just-inserted range (present on newState at [at, at+insSize)).
    if (e.insSize > 0) tr.addMark(at, at + e.insSize, ins.create({ author }));
    // 2. Re-insert the deleted content BEFORE the insertion, carrying `deletion`
    //    (and never also `insertion` — deleting a pending insertion is a deletion).
    if (e.delSize > 0) {
      tr.insert(at, e.deletedContent);
      tr.removeMark(at, at + e.delSize, ins);
      tr.addMark(at, at + e.delSize, del.create({ author }));
    }
    // Caret: after a pure deletion sit left of the struck text (Backspace feel),
    // otherwise after the inserted text.
    lastCaret = e.delSize > 0 && e.insSize === 0 ? at : at + e.delSize + e.insSize;
  }
  try { tr.setSelection(TextSelection.create(tr.doc, Math.min(lastCaret, tr.doc.content.size))); } catch { /* keep default */ }
  tr.setMeta(SKIP, true);
  return tr.steps.length ? tr : null;
}

export const TrackChanges = Extension.create<{ author: string }>({
  name: 'trackChanges',
  addOptions() { return { author: '' }; },
  addProseMirrorPlugins() {
    const author = this.options.author;
    return [
      new Plugin<TrackState>({
        key: trackChangesKey,
        state: {
          init: () => ({ suggesting: false }),
          apply: (tr, value) => {
            const meta = tr.getMeta(trackChangesKey) as TrackState | undefined;
            return meta ? { suggesting: meta.suggesting } : value;
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!trackChangesKey.getState(newState)?.suggesting) return null;
          return buildTrackTransaction(newState, transactions, author);
        },
      }),
    ];
  },
});

// ── accept / reject ────────────────────────────────────────────────────────

interface Range { from: number; to: number }

/** All text ranges carrying `markType`, in document order. */
function markRanges(state: EditorState, markType: MarkType): Range[] {
  const out: Range[] = [];
  state.doc.descendants((node, pos) => {
    if (node.isText && markType.isInSet(node.marks)) out.push({ from: pos, to: pos + node.nodeSize });
  });
  return out;
}

/** The contiguous run of `markType` covering `pos` (or null). */
function markRangeAt(state: EditorState, pos: number, markType: MarkType): Range | null {
  for (const r of markRanges(state, markType)) {
    // adjacent same-mark text nodes are separate runs; merge by touching bounds
    if (pos >= r.from && pos <= r.to) {
      let { from, to } = r;
      const all = markRanges(state, markType);
      let extended = true;
      while (extended) {
        extended = false;
        for (const o of all) {
          if (o.from === to) { to = o.to; extended = true; }
          if (o.to === from) { from = o.from; extended = true; }
        }
      }
      return { from, to };
    }
  }
  return null;
}

type Resolvable = Range & { strip: boolean };

/** Build the accept/reject transaction over the given ranges: `strip` keeps text
 *  (drops the mark); otherwise the range's text is deleted. Pure (state → tr) so
 *  it is testable without a DOM; returns null when it would be a no-op. */
function buildResolve(state: EditorState, insRanges: Resolvable[], delRanges: Resolvable[]): Transaction | null {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del) return null;
  const tr = state.tr;
  tr.setMeta(SKIP, true);
  // Strip marks first (no position change), then delete ranges in reverse order.
  for (const r of insRanges) if (r.strip) tr.removeMark(r.from, r.to, ins);
  for (const r of delRanges) if (r.strip) tr.removeMark(r.from, r.to, del);
  const toDelete = [...insRanges, ...delRanges].filter((r) => !r.strip).sort((a, b) => b.from - a.from);
  for (const r of toDelete) tr.delete(tr.mapping.map(r.from), tr.mapping.map(r.to));
  return tr.docChanged ? tr : null;
}

function dispatch(editor: Editor, tr: Transaction | null): boolean {
  if (!tr) return false;
  editor.view.dispatch(tr);
  return true;
}

/** Accept: keep insertions (strip mark), remove deletions (delete text). Pure. */
export function buildAcceptAll(state: EditorState): Transaction | null {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del) return null;
  return buildResolve(state,
    markRanges(state, ins).map((r) => ({ ...r, strip: true })),
    markRanges(state, del).map((r) => ({ ...r, strip: false })));
}

/** Reject: remove insertions (delete text), keep deletions (strip mark). Pure. */
export function buildRejectAll(state: EditorState): Transaction | null {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del) return null;
  return buildResolve(state,
    markRanges(state, ins).map((r) => ({ ...r, strip: false })),
    markRanges(state, del).map((r) => ({ ...r, strip: true })));
}

export function acceptAllChanges(editor: Editor): boolean { return dispatch(editor, buildAcceptAll(editor.state)); }
export function rejectAllChanges(editor: Editor): boolean { return dispatch(editor, buildRejectAll(editor.state)); }

/**
 * Apply external text (e.g. an AI "improve selection" result, ADR 0334 5b-2) over
 * a range AS A TRACKED SUGGESTION: the old range is deletion-marked (struck, kept)
 * and `text` is inserted after it insertion-marked — so it lands exactly like a
 * type-over suggestion the user accepts/rejects via 6b-2, never silently
 * authoritative. Pure (state → tr); `text` is inserted as a single plain-text run
 * (multi-block parsing is a later refinement). Marked SKIP so the tracking plugin
 * doesn't re-process it.
 */
export function buildApplyAsSuggestion(
  state: EditorState, from: number, to: number, text: string, author: string,
): Transaction | null {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del || !text) return null;
  const size = state.doc.content.size;
  if (from < 0 || to > size || from > to) return null; // stale range → caller falls back
  const tr = state.tr;
  tr.setMeta(SKIP, true);
  if (to > from) tr.addMark(from, to, del.create({ author })); // old text → struck deletion
  tr.insertText(text, to);
  tr.removeMark(to, to + text.length, del);                    // the new run is not a deletion
  tr.addMark(to, to + text.length, ins.create({ author }));   // → insertion suggestion
  return tr.docChanged ? tr : null;
}

export function applyAsSuggestion(editor: Editor, from: number, to: number, text: string): boolean {
  return dispatch(editor, buildApplyAsSuggestion(editor.state, from, to, text, ''));
}

/** The suggestion (insertion or deletion) under the cursor, or null. */
function changeAt(state: EditorState): { kind: 'insertion' | 'deletion'; range: Range } | null {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del) return null;
  const pos = state.selection.head;
  const ri = markRangeAt(state, pos, ins);
  if (ri) return { kind: 'insertion', range: ri };
  const rd = markRangeAt(state, pos, del);
  if (rd) return { kind: 'deletion', range: rd };
  return null;
}

export function hasChangeAt(state: EditorState): boolean { return changeAt(state) !== null; }

/** Accept the single suggestion under the cursor. */
export function acceptChangeAt(editor: Editor): boolean {
  const c = changeAt(editor.state);
  if (!c) return false;
  return dispatch(editor, c.kind === 'insertion'
    ? buildResolve(editor.state, [{ ...c.range, strip: true }], [])
    : buildResolve(editor.state, [], [{ ...c.range, strip: false }]));
}

/** Reject the single suggestion under the cursor. */
export function rejectChangeAt(editor: Editor): boolean {
  const c = changeAt(editor.state);
  if (!c) return false;
  return dispatch(editor, c.kind === 'insertion'
    ? buildResolve(editor.state, [{ ...c.range, strip: false }], [])
    : buildResolve(editor.state, [], [{ ...c.range, strip: true }]));
}

/** Does the document contain any pending suggestion? */
export function hasAnyChange(state: EditorState): boolean {
  const ins = state.schema.marks.insertion, del = state.schema.marks.deletion;
  if (!ins || !del) return false;
  return markRanges(state, ins).length > 0 || markRanges(state, del).length > 0;
}
