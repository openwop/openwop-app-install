/**
 * Y.XmlFragment → ProseMirror JSON (ADR 0359 Phase 6 / OQ-2).
 *
 * The backend derive for `canvas.document`: the FE binds TipTap through
 * y-prosemirror, whose encoding is structural — XmlElement `nodeName` = the PM
 * node type, element attributes = `attrs`, XmlText deltas = text runs whose
 * delta attributes are the PM marks (`{ bold: {} }` ⇒ mark `bold`, attribute
 * value object = the mark's attrs). Decoding that back needs NO ProseMirror
 * schema and NO DOM, so this stays a ~60-line local converter instead of a
 * y-prosemirror backend dependency (the esbuild-boot dep-weight rule; parity is
 * pinned by test here and exercised live in the Phase 7 e2e pass).
 *
 * The result feeds the type's own validator before any host.canvas write —
 * a shape this converter gets wrong is SKIPPED, never persisted.
 */
import * as Y from 'yjs';

type Dict = Record<string, unknown>;
interface PmMark { type: string; attrs?: Dict }
/** Index-signed so a PM node IS a Dict (no laundering casts at the state seam). */
interface PmNode extends Dict { type: string; attrs?: Dict; content?: PmNode[]; text?: string; marks?: PmMark[] }

function marksOf(attributes: Dict | undefined): PmMark[] | undefined {
  if (!attributes) return undefined;
  const marks: PmMark[] = [];
  for (const [type, v] of Object.entries(attributes)) {
    if (v && typeof v === 'object' && Object.keys(v as Dict).length > 0) marks.push({ type, attrs: v as Dict });
    else marks.push({ type });
  }
  return marks.length > 0 ? marks : undefined;
}

function textNodes(xt: Y.XmlText): PmNode[] {
  const out: PmNode[] = [];
  for (const d of xt.toDelta() as { insert?: unknown; attributes?: Dict }[]) {
    if (typeof d.insert !== 'string' || d.insert.length === 0) continue;
    const marks = marksOf(d.attributes);
    out.push({ type: 'text', text: d.insert, ...(marks ? { marks } : {}) });
  }
  return out;
}

function elementNode(el: Y.XmlElement): PmNode {
  const attrsRaw = el.getAttributes() as Dict;
  const attrs = Object.keys(attrsRaw).length > 0 ? attrsRaw : undefined;
  const content: PmNode[] = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement) content.push(elementNode(child));
    else if (child instanceof Y.XmlText) content.push(...textNodes(child));
  }
  return {
    type: el.nodeName,
    ...(attrs ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

/** The fragment as a PM doc node; null when the fragment is EMPTY (a fresh /
 *  never-edited room must never clobber real host.canvas content). */
export function pmDocFromYFragment(fragment: Y.XmlFragment): PmNode | null {
  const content: PmNode[] = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) content.push(elementNode(child));
    else if (child instanceof Y.XmlText) content.push(...textNodes(child));
  }
  if (content.length === 0) return null;
  return { type: 'doc', content };
}

/** The `canvas.document` collab derive (registered via `collabDerive`):
 *  content from the room's fragment, everything else (title, …) preserved
 *  from the current host.canvas state. */
export function deriveDocumentState(ydoc: Y.Doc, current: Dict): Dict | null {
  const doc = pmDocFromYFragment(ydoc.getXmlFragment('doc'));
  if (!doc) return null;
  return { ...current, content: doc };
}
