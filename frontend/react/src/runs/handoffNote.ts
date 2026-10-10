/**
 * ADR 0829 P3 — read a structured handoff record off a run event payload or a
 * run's metadata. Defensive by design: the record arrives over the wire, and on
 * a root run the metadata key is caller-writable, so anything that does not
 * parse as the bounded shape renders as nothing rather than as a half-note.
 * The backend owns normalization (`host/handoff/handoffRecord.ts`); this only
 * refuses to trust it blindly.
 */

/** The carrier key on `agent.handoff`, `node.suspended` and child-run metadata. */
export const HANDOFF_KEY = 'openwop-handoff';

export interface HandoffNote {
  intent: string;
  decisions: { summary: string; decidedBy?: string }[];
  openQuestions: string[];
  tried: { approach: string; droppedBecause?: string }[];
  confidence?: { value: number; basis?: string };
  producedBy: 'agent' | 'host' | 'human';
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim().length > 0 ? x : undefined);

/** The note under `openwop-handoff` in `container` (an event payload or run metadata), or null. */
export function readHandoffNote(container: unknown): HandoffNote | null {
  if (!isObj(container)) return null;
  const raw = container[HANDOFF_KEY];
  if (!isObj(raw)) return null;
  const intent = str(raw.intent);
  if (!intent) return null;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

  const decisions = list(raw.decisions).flatMap((d) => {
    if (!isObj(d)) return [];
    const summary = str(d.summary);
    if (!summary) return [];
    const decidedBy = str(d.decidedBy);
    return [{ summary, ...(decidedBy ? { decidedBy } : {}) }];
  });
  const openQuestions = list(raw.openQuestions).flatMap((q) => (str(q) ? [q as string] : []));
  const tried = list(raw.tried).flatMap((t) => {
    if (!isObj(t)) return [];
    const approach = str(t.approach);
    if (!approach) return [];
    const droppedBecause = str(t.droppedBecause);
    return [{ approach, ...(droppedBecause ? { droppedBecause } : {}) }];
  });
  const c = raw.confidence;
  const confidence = isObj(c) && typeof c.value === 'number' && Number.isFinite(c.value)
    ? { value: Math.min(1, Math.max(0, c.value)), ...(str(c.basis) ? { basis: c.basis as string } : {}) }
    : undefined;
  const producedBy = raw.producedBy === 'agent' || raw.producedBy === 'host' ? raw.producedBy : 'human';

  return { intent, decisions, openQuestions, tried, ...(confidence ? { confidence } : {}), producedBy };
}
