/**
 * ADR 1055 D5 — the two decisions "Apply" makes when an AI reply comes back from
 * the chat, kept pure so they can be exercised without an editor surface.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** The ONE reading of a range's text, used both when the selection is staged
 *  and when the reply is applied, so the two can be compared. */
export function selectionText(doc: PMNode, from: number, to: number): string {
  if (from < 0 || to > doc.content.size || from > to) return '';
  return doc.textBetween(from, to, '\n', ' ').trim();
}

/** Why an apply was refused, or `null` when it may go ahead. */
export type ApplyRefusal = 'changed' | 'empty';

/** Refuse when the range no longer holds the text the user asked about (a peer,
 *  another tab, a restore), or when the reply has nothing to insert. A target
 *  staged before ADR 1055 carries no `expectedText`; it is refused, never
 *  applied blind. */
export function applyRefusal(doc: PMNode, from: number, to: number, expectedText: string | undefined, text: string): ApplyRefusal | null {
  if (!text) return 'empty';
  if (expectedText === undefined || selectionText(doc, from, to) !== expectedText) return 'changed';
  return null;
}

/** The reply as text to insert: one wrapping code fence, if the model added one,
 *  is removed, then the result is trimmed. Nothing else is rewritten. */
export function plainRewriteText(reply: string): string {
  const trimmed = reply.trim();
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(trimmed);
  return (fenced ? fenced[2]! : trimmed).trim();
}
