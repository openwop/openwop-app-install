/**
 * ADR 0105 trip-wire (grade-code ATOOL-1) — the security invariant that a
 * heartbeat/scheduled chat node's tool bindings are WORKFLOW SUB-RUNS ONLY: a
 * binding MUST carry a string `workflowId`, and anything without one (notably a
 * native/builtin tool id) is DROPPED. This pins the structural guarantee that
 * makes the "ungated heartbeat path" a non-gap, so a future edit that lets native
 * tools into the heartbeat surface fails loudly here.
 */
import { describe, expect, it } from 'vitest';
import { validateToolBindings } from '../src/bootstrap/nodes.js';

describe('validateToolBindings — ADR 0105 invariant (workflow-bound tools only)', () => {
  it('keeps a well-formed workflow binding', () => {
    const out = validateToolBindings([
      { workflowId: 'wf.summarize', name: 'summarize', description: 'Summarize a doc' },
    ]);
    expect(out).toEqual([{ workflowId: 'wf.summarize', name: 'summarize', description: 'Summarize a doc' }]);
  });

  it('DROPS a binding with no workflowId (a native/builtin tool id cannot enter)', () => {
    const out = validateToolBindings([
      // shaped like a native-tool spec — a tool name/id but NO workflowId
      { name: 'crm.field.update', toolId: 'openwop:crm.field.update', description: 'native tool' },
      { id: 'openwop:knowledge.search', name: 'search', description: 'native tool' },
    ]);
    expect(out).toEqual([]); // both rejected — no workflowId
  });

  it('drops a binding whose workflowId is not a string', () => {
    expect(validateToolBindings([{ workflowId: 123, name: 'x', description: 'd' }])).toEqual([]);
    expect(validateToolBindings([{ workflowId: null, name: 'x', description: 'd' }])).toEqual([]);
  });

  it('drops a binding with a missing/invalid name or description (same untrusted surface)', () => {
    expect(validateToolBindings([{ workflowId: 'wf', description: 'd' }])).toEqual([]); // no name
    expect(validateToolBindings([{ workflowId: 'wf', name: 'has space', description: 'd' }])).toEqual([]); // name regex
    expect(validateToolBindings([{ workflowId: 'wf', name: 'ok', description: 42 }])).toEqual([]); // non-string desc
  });

  it('ignores non-object entries and keeps only the valid ones from a mixed array', () => {
    const out = validateToolBindings([
      null,
      'nope',
      42,
      { name: 'native-only', description: 'no workflowId' }, // dropped
      { workflowId: 'wf.ok', name: 'ok', description: 'kept' }, // kept
    ]);
    expect(out).toEqual([{ workflowId: 'wf.ok', name: 'ok', description: 'kept' }]);
  });
});
