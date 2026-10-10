/**
 * openwop#1692 — the approval-reject tail (`interrupt.resolved` → `node.failed`
 * → `run.failed`) against the corpus's v2 defs, read from the PACKAGE (see
 * `corpusSchema.ts`), not from hand-listed keys.
 *
 * The v2 defs are `additionalProperties: false`, so every emitted key must be
 * declared, and `action` / `decision` are enums. `interrupt.resolved`'s `nodeId`
 * rides the envelope and is projected in on a major-2 read
 * (`envelopeIdProjection.ts`), which is why this checks declared keys + enum
 * values rather than running the full def.
 */
import { expect } from 'vitest';
import { corpusSchema } from './corpusSchema.js';
import type { EventRecord } from '../../src/types.js';

interface StringProp { enum?: string[] }
interface ClosedDef { additionalProperties?: boolean; properties: Record<string, StringProp> }

function defV2(name: string): ClosedDef {
  const doc = corpusSchema('v2/run-event-payloads.schema.json') as { $defs: Record<string, ClosedDef> };
  return doc.$defs[name]!;
}

function assertDeclared(defName: string, payload: Record<string, unknown>): void {
  const def = defV2(defName);
  expect(def.additionalProperties, `the v2 ${defName} def is closed; if it opened, this check is weaker than it reads`).toBe(false);
  for (const key of Object.keys(payload)) {
    expect(Object.keys(def.properties), `${defName} emitted undeclared key '${key}'`).toContain(key);
  }
}

export function assertResolvedPayloadDeclared(payload: Record<string, unknown>): void {
  assertDeclared('interruptResolved', payload);
  const def = defV2('interruptResolved');
  for (const key of ['action', 'decision'] as const) {
    if (payload[key] !== undefined) expect(def.properties[key]!.enum).toContain(payload[key]);
  }
}

/**
 * The three terminal events of a rejected gate, in EXACTLY this order, each
 * once, with the gate's node named on `node.failed` and as `run.failed`'s
 * `failedNodeId`. Returns the `interrupt.resolved` payload for path-specific
 * assertions.
 */
export function assertRejectTail(events: readonly EventRecord[], gateNodeId: string): Record<string, unknown> {
  const tail = events.filter((e) => e.type === 'interrupt.resolved' || e.type === 'node.failed' || e.type === 'run.failed');
  expect(tail.map((e) => e.type), 'order: interrupt.resolved → node.failed → run.failed').toEqual(['interrupt.resolved', 'node.failed', 'run.failed']);
  const [resolved, nodeFailed, runFailed] = tail as [EventRecord, EventRecord, EventRecord];
  expect(nodeFailed.nodeId).toBe(gateNodeId);
  const nf = nodeFailed.payload as Record<string, unknown>;
  expect(nf).toMatchObject({ nodeId: gateNodeId, error: { code: 'approval_rejected', retryable: false } });
  assertDeclared('nodeFailed', nf);
  const rf = runFailed.payload as Record<string, unknown>;
  expect(rf).toMatchObject({ failedNodeId: gateNodeId, error: { code: 'approval_rejected' } });
  assertDeclared('runFailed', rf);
  const rp = resolved.payload as Record<string, unknown>;
  assertResolvedPayloadDeclared(rp);
  return rp;
}
