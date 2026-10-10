/**
 * ADR 0773 G-10a (visual pass) — the one-line label a reviewer reads for a
 * suggested change. The server writes `summary` from what the head knows; an
 * added step with no name (a template's nodes carry none) falls back there to
 * its raw typeId, which reads as `Add feature.agent-knowledge.nodes.ingest`.
 * The palette catalog already holds the human label the ghost card shows, so
 * the review uses it too — one name for one step, on the canvas and in the list.
 */
import { catalogEntryByTypeId } from '../palette/catalogRegistry.js';
import type { SuggestedOp } from './suggestionModel.js';

/** What the reviewer can call each step: a suggested step by the name its
 *  ghost card shows, an existing step by its name on the sheet. */
export interface OpNameContext {
  ops: readonly SuggestedOp[];
  nodes: ReadonlyArray<{ id: string; name?: string | undefined }>;
}

function stepName(id: string, ctx: OpNameContext): string | undefined {
  for (const o of ctx.ops) {
    if (o.op.kind === 'addNode' && o.op.nodeId === id) return o.op.name ?? catalogEntryByTypeId(o.op.typeId)?.label;
  }
  return ctx.nodes.find((n) => n.id === id)?.name || undefined;
}

export function opSummary(o: SuggestedOp, ctx?: OpNameContext): string {
  const op = o.op;
  if (op.kind === 'addNode' && !op.name) {
    const label = catalogEntryByTypeId(op.typeId)?.label;
    if (label) return `Add ${label}`;
  }
  // The server names a connection's ends by node id. For a step the same
  // suggestion adds, that id is a generated `sg_…` token the reviewer has
  // never seen (read on production as `Connect sg_b0ebd1c33f_1 → sg_b0e…`).
  if (op.kind === 'addEdge' && ctx) {
    let text = o.summary;
    for (const id of [op.sourceNodeId, op.targetNodeId]) {
      const name = stepName(id, ctx);
      if (name) text = text.split(id).join(name);
    }
    return text;
  }
  return o.summary;
}
