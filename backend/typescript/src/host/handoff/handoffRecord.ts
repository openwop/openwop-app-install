/**
 * ADR 0829 — the structured handoff record: what the receiver of a piece of
 * work needs (intent, decisions and who made them, open questions, what was
 * tried, confidence), stamped ONCE on the event that carries the transfer.
 *
 * Pure. Core code builds and normalizes records here and never imports the
 * feature package. Always on since 2026-10-07 (maintainer decision): the
 * `structured-handoffs` toggle was removed, so every transfer carries a record.
 *
 * Every carrier key is `openwop-handoff`, which matches the corpus extension
 * hatch `^(openwop-|x-|vendor\.)` on `agentHandoff` and `nodeSuspended`, and
 * `storage/vendorKeyCarry.ts` passes a hatch-matching key through unboxed — so
 * the record reads identically on the v1 and v2 projections.
 *
 * @see docs/adr/0829-structured-handoff-record.md
 */
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { neutralizeUntrusted, fenceUntrustedItems } from '../untrustedContent.js';

/** The carrier key on `agent.handoff`, `node.suspended` and child-run metadata. */
export const HANDOFF_KEY = 'openwop-handoff';

export const HANDOFF_LIMITS = {
  intent: 500,
  item: 300,
  sourceRef: 512,
  decidedBy: 256,
  listItems: 20,
  serializedBytes: 8 * 1024,
} as const;

export interface HandoffDecision {
  summary: string;
  /** Opaque, per the `interrupt.md` `decidedBy` convention. */
  decidedBy?: string;
  /** An eventId or a host URL naming where the decision was made. */
  sourceRef?: string;
}

export interface HandoffTried {
  approach: string;
  droppedBecause?: string;
}

export interface HandoffRecordV1 {
  v: 1;
  intent: string;
  decisions: HandoffDecision[];
  openQuestions: string[];
  tried: HandoffTried[];
  confidence?: { value: number; basis?: string };
  producedBy: 'agent' | 'host' | 'human';
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

function str(x: unknown, max: number): string | undefined {
  if (typeof x !== 'string') return undefined;
  const t = x.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function list<T>(x: unknown, each: (v: unknown) => T | undefined): T[] {
  if (!Array.isArray(x)) return [];
  const out: T[] = [];
  for (const v of x) {
    if (out.length >= HANDOFF_LIMITS.listItems) break;
    const n = each(v);
    if (n !== undefined) out.push(n);
  }
  return out;
}

/**
 * Normalize untrusted input (a supervisor's output, a person's draft) into a
 * `HandoffRecordV1`, or null when it has no usable `intent`. Truncates, drops
 * over-count items and malformed entries, redacts secrets, and enforces the
 * serialized cap by dropping list items from the end (never by cutting JSON).
 */
export function normalizeHandoffRecord(input: unknown, producedBy: HandoffRecordV1['producedBy']): HandoffRecordV1 | null {
  if (!isObj(input)) return null;
  const intent = str(input.intent, HANDOFF_LIMITS.intent);
  if (intent === undefined) return null;

  const decisions = list<HandoffDecision>(input.decisions, (d) => {
    if (!isObj(d)) return undefined;
    const summary = str(d.summary, HANDOFF_LIMITS.item);
    if (summary === undefined) return undefined;
    const decidedBy = str(d.decidedBy, HANDOFF_LIMITS.decidedBy);
    const sourceRef = str(d.sourceRef, HANDOFF_LIMITS.sourceRef);
    return { summary, ...(decidedBy ? { decidedBy } : {}), ...(sourceRef ? { sourceRef } : {}) };
  });
  const openQuestions = list<string>(input.openQuestions, (q) => str(q, HANDOFF_LIMITS.item));
  const tried = list<HandoffTried>(input.tried, (t) => {
    if (!isObj(t)) return undefined;
    const approach = str(t.approach, HANDOFF_LIMITS.item);
    if (approach === undefined) return undefined;
    const droppedBecause = str(t.droppedBecause, HANDOFF_LIMITS.item);
    return { approach, ...(droppedBecause ? { droppedBecause } : {}) };
  });

  let confidence: HandoffRecordV1['confidence'];
  if (isObj(input.confidence) && typeof input.confidence.value === 'number' && Number.isFinite(input.confidence.value)) {
    const value = Math.min(1, Math.max(0, input.confidence.value));
    const basis = str(input.confidence.basis, HANDOFF_LIMITS.item);
    confidence = { value, ...(basis ? { basis } : {}) };
  }

  const record: HandoffRecordV1 = stripSecretsFromPersisted({
    v: 1,
    intent,
    decisions,
    openQuestions,
    tried,
    ...(confidence ? { confidence } : {}),
    producedBy,
  });
  return fitToCap(record);
}

/** Drop list items from the end, longest list first, until the record fits. */
function fitToCap(r: HandoffRecordV1): HandoffRecordV1 {
  const size = (x: HandoffRecordV1) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  while (size(r) > HANDOFF_LIMITS.serializedBytes) {
    const lists = [r.decisions, r.openQuestions, r.tried] as unknown[][];
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length === 0) break; // intent ≤ 500 chars: unreachable in practice
    longest.pop();
  }
  return r;
}

/**
 * The host fallback for a supervisor → worker transfer when the supervisor
 * gave no record (ADR 0829 D3). Thin and honest: intent names the worker,
 * confidence comes from the decision; lists empty. A conforming next-worker
 * decision has no `reason` (only `terminate` does), so `reason` is read only
 * tolerantly, for a non-conforming supervisor that sends one anyway.
 */
export function hostDispatchRecord(decision: Obj, workerId: string): HandoffRecordV1 {
  const reason = str(decision.reason, HANDOFF_LIMITS.intent);
  const c = decision.confidence;
  const record = normalizeHandoffRecord({
    intent: reason ?? `Dispatched to ${workerId}`,
    ...(typeof c === 'number' ? { confidence: { value: c, basis: 'supervisor decision confidence' } } : {}),
  }, 'host');
  // intent is always non-empty above, so normalize cannot return null.
  return record as HandoffRecordV1;
}

/**
 * The record for the supervisor's own escalation to a person (confidence-floor
 * breach, ADR 0829 D3). Built from what the supervisor decided, so the person
 * sees the intended next step and why the host stopped.
 */
export function confidenceFloorRecord(decision: Obj, confidence: number, floor: number, supplied?: unknown): HandoffRecordV1 {
  const fromSupervisor = supplied === undefined ? null : normalizeHandoffRecord(supplied, 'agent');
  const base = fromSupervisor ?? hostDispatchRecord(decision, describeDecision(decision));
  return {
    ...base,
    confidence: { value: Math.min(1, Math.max(0, confidence)), basis: `below the escalation floor ${floor}` },
  };
}

function describeDecision(decision: Obj): string {
  const ids = Array.isArray(decision.nextWorkerIds) ? decision.nextWorkerIds.filter((x) => typeof x === 'string') : [];
  return ids.length > 0 ? ids.join(', ') : String(decision.kind ?? 'the next step');
}

/**
 * The supervisor's per-worker record input, from `handoffs[workerId]` on its
 * output (ADR 0829 D3). Outside `decision`: every orchestrator-decision
 * variant is closed.
 */
export function suppliedHandoff(supervisorPayload: Obj, workerId: string): Obj | undefined {
  const h = supervisorPayload.handoffs;
  if (!isObj(h)) return undefined;
  const entry = h[workerId];
  return isObj(entry) ? entry : undefined;
}

const AGENT_ID_RE = /^[A-Za-z0-9._~:-]{3,128}$/;
/** `toAgentId` only when the supervisor named one that is a valid agent id. The host never infers it. */
export function namedTargetAgent(supplied: Obj | undefined): string | undefined {
  const t = supplied?.toAgentId;
  return typeof t === 'string' && AGENT_ID_RE.test(t) ? t : undefined;
}

const PRODUCERS: ReadonlySet<string> = new Set(['agent', 'host', 'human']);

/**
 * ADR 0829 P2 — the record a run was CREATED with (`run.metadata["openwop-handoff"]`,
 * stamped by `core.dispatch` on the child run). Re-normalized on read: root-run
 * metadata is caller-writable (`POST /v1/runs`), so the key is untrusted input
 * regardless of who claims to have produced it. `producedBy` is kept as a claim
 * when it is one of the three values, never as a verified fact.
 */
export function readHandoffRecord(metadata: unknown): HandoffRecordV1 | undefined {
  if (!isObj(metadata)) return undefined;
  const raw = metadata[HANDOFF_KEY];
  if (!isObj(raw)) return undefined;
  const claimed = typeof raw.producedBy === 'string' && PRODUCERS.has(raw.producedBy) ? (raw.producedBy as HandoffRecordV1['producedBy']) : 'human';
  return normalizeHandoffRecord(raw, claimed) ?? undefined;
}

/**
 * ADR 0829 D5 — the record as the RECEIVING agent sees it: one fenced block of
 * neutralized lines, through the single fencing seam (`host/untrustedContent.ts`).
 * Another model wrote this text, so it is data the agent may use, never
 * instructions. Deterministic (no nonce), so replay builds the same prompt.
 */
export function handoffPromptBlock(r: HandoffRecordV1): string {
  const n = neutralizeUntrusted;
  const items: string[] = [
    'Handoff note from the participant who passed you this work:',
    `- Intent: ${n(r.intent)}`,
    ...r.decisions.map((d) => `- Decided: ${n(d.summary)}${d.decidedBy ? ` (by ${n(d.decidedBy)})` : ''}`),
    ...r.openQuestions.map((q) => `- Open question: ${n(q)}`),
    ...r.tried.map((t) => `- Tried: ${n(t.approach)}${t.droppedBecause ? ` (dropped: ${n(t.droppedBecause)})` : ''}`),
    ...(r.confidence ? [`- Their confidence: ${r.confidence.value.toFixed(2)}${r.confidence.basis ? ` (${n(r.confidence.basis)})` : ''}`] : []),
  ];
  return fenceUntrustedItems(items);
}
