/**
 * ADR 0725 D3 — RFC 0185 §C on the major-2 read: undeclared keys on a
 * closed+hatched def are CARRIED under `vendor.openwop-app`, never dropped;
 * an unhatched def is left alone (its residue is a writer defect the audit
 * ratchet gates); the step is idempotent (fan-out runs the projection twice).
 */
import { describe, expect, it } from 'vitest';
import { carryPlanFor, carryVendorKeys, VENDOR_CARRY_KEY } from '../src/storage/vendorKeyCarry.js';
import { projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import { corpusInterruptKinds, kindCarryingTypes, projectInterruptKind } from '../src/storage/interruptKindProjection.js';

describe('ADR 0725 — vendor-key carry', () => {
  it('reads the plan from the vendored schema: hatched defs carry, unhatched do not, nested closed sub-defs are planned', () => {
    expect(carryPlanFor('conversation.opened')?.hatched).toBe(true);
    expect(carryPlanFor('run.failed')?.nested.get('error')?.hatched, '`_errorObject` is closed + hatched').toBe(true);
    expect(carryPlanFor('compensation.requested'), 'unhatched + flat: nothing to carry').toBeNull();
    expect(carryPlanFor('no.such.type')).toBeNull();
  });

  it('moves every undeclared top-level key into ONE box and leaves declared keys in place', () => {
    const out = carryVendorKeys('conversation.opened', { conversationId: 'c1', initialTurn: { messageId: 'm0' }, participants: [], capabilities: ['multi-turn'] }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['conversationId', VENDOR_CARRY_KEY]);
    expect(out[VENDOR_CARRY_KEY]).toEqual({ initialTurn: { messageId: 'm0' }, participants: [], capabilities: ['multi-turn'] });
  });

  it('carries inside a nested closed+hatched sub-object (run.failed.error enrichment)', () => {
    const out = carryVendorKeys('run.failed', { error: { code: 'x', message: 'y', category: 'provider', userMessage: 'Try again' }, failedNodeId: 'n1' }) as any;
    expect(out.error).toEqual({ code: 'x', message: 'y', [VENDOR_CARRY_KEY]: { category: 'provider', userMessage: 'Try again' } });
    expect(out.failedNodeId).toBe('n1');
  });

  it('is idempotent and returns the SAME reference when there is nothing to carry', () => {
    const once = carryVendorKeys('conversation.opened', { conversationId: 'c1', extra: 1 });
    const twice = carryVendorKeys('conversation.opened', once);
    expect(twice).toBe(once);
    const idle = { conversationId: 'c1' };
    expect(carryVendorKeys('conversation.opened', idle)).toBe(idle);
  });

  it('does NOT touch an unhatched def — the residue stays visible to the ratchet instead of vanishing into a box the def forbids', () => {
    const p = { compensationId: 'c', effectId: 'e', attempt: 1, orderingModel: 'lifo', extra: true };
    expect(carryVendorKeys('compensation.requested', p)).toBe(p);
  });

  it('runs LAST in the composed projection: seats (ids, aliases, owner echo) before the box, and the fan-out\'s second pass is a no-op', () => {
    const first = projectV2Payload('artifact.created', { artifactTypeId: 'deck', versionId: 'v3', registeredBy: 'host' }, { runId: 'r1', nodeId: 'n1' }) as Record<string, unknown>;
    expect(first.artifactType, 'alias ran first — a seated rename is not boxed').toBe('deck');
    expect(first[VENDOR_CARRY_KEY]).toEqual({ registeredBy: 'host' });
    expect(projectV2Payload('artifact.created', first, { runId: 'r1', nodeId: 'n1' })).toBe(first);
  });
});

describe('ADR 0725 — interrupt kinds onto the corpus enum', () => {
  it('reads the enum from the vendored schema (non-vacuous) and leaves a corpus kind alone', () => {
    expect(corpusInterruptKinds().has('approval')).toBe(true);
    for (const t of ['node.suspended', 'interrupt.resolved', 'approval.granted', 'approval.overridden', 'approval.requested']) expect(kindCarryingTypes().has(t), `${t} carries the kind enum`).toBe(true);
    expect(kindCarryingTypes().has('run.started')).toBe(false);
    const p = { interruptId: 'i', kind: 'approval' };
    expect(projectInterruptKind('node.suspended', p)).toBe(p);
  });
  it('`conversation` is the conversation.start seat; a host-only kind becomes `custom` with the spelling CARRIED, and the composed projection boxes it once', () => {
    expect((projectInterruptKind('node.suspended', { interruptId: 'i', kind: 'conversation' }) as any).kind).toBe('conversation.start');
    const out = projectV2Payload('node.suspended', { interruptId: 'a'.repeat(32), kind: 'walkthrough-step' }, { runId: 'r1', nodeId: 'n1' }) as any;
    expect(out.kind).toBe('custom');
    expect(out[VENDOR_CARRY_KEY]).toEqual({ kind: 'walkthrough-step' });
    expect(projectV2Payload('node.suspended', out, { runId: 'r1', nodeId: 'n1' }), 'idempotent').toBe(out);
    expect(projectInterruptKind('run.started', { kind: 'timer' }), 'only interrupt-carrying types').toEqual({ kind: 'timer' });
  });
});
