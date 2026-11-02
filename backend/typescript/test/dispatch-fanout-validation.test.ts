/**
 * RFC 0118 — core.dispatch fan-out REGISTRATION validation (host/workflowDefinitionValidation.ts).
 * The host advertises dispatch.fanOutSupported:true + joinModes:['wait-all'], so a parallel config
 * is ACCEPTED (the campaign-orchestration consumer's contract (2)); the negative conformance cases
 * are rejected. Honesty: only the honestly-honorable modes are accepted (no in-flight child
 * cancellation → quorum/first/race + fail-fast rejected).
 *
 * TST-CVH-22. Each refusal is asserted by its error CODE and a message fragment
 * naming the refused value, so a different (earlier) refusal cannot stand in for
 * it. Red when: an unknown fanOutPolicy, joinPolicy without parallel, an
 * unadvertised join mode or `onChildFailure:'fail-fast'` is accepted, or an
 * advertised policy (`reject`) is no longer accepted.
 *
 * @see RFCS/0118-parallel-subworkflow-fan-out-and-join.md, docs/adr/0165-rfc-0118-parallel-fan-out-witness.md
 */
import { describe, it, expect } from 'vitest';
import { checkMappingCapability } from '../src/host/workflowDefinitionValidation.js';
import { OpenwopError } from '../src/types.js';

const node = (config: Record<string, unknown>) => [{ nodeId: 'd', typeId: 'core.dispatch', config }];
const accept = (config: Record<string, unknown>) => expect(() => checkMappingCapability(node(config))).not.toThrow();
function reject(config: Record<string, unknown>, code: string, message: RegExp): void {
  let caught: unknown;
  try { checkMappingCapability(node(config)); } catch (err) { caught = err; }
  if (!(caught instanceof OpenwopError)) throw new Error(`expected an OpenwopError refusal for ${JSON.stringify(config)}, got ${String(caught)}`);
  expect(caught.code).toBe(code);
  expect(caught.message).toMatch(message);
}

describe('RFC 0118 — core.dispatch fan-out registration validation', () => {
  it('ACCEPTS fanOutPolicy:parallel + wait-all/collect (consumer contract 2)', () => {
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } });
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'absorb' } });
    accept({ fanOutPolicy: 'parallel', maxConcurrency: 3 });
    accept({}); // default sequential — pre-RFC-0118 config stays valid
    accept({ fanOutPolicy: 'sequential' });
    accept({ fanOutPolicy: 'reject' });
  });
  it('rejects an unknown fanOutPolicy (capability_not_provided)', () => {
    reject({ fanOutPolicy: 'broadcast' }, 'capability_not_provided', /fanOutPolicy='broadcast'/);
  });
  it('rejects joinPolicy present without fanOutPolicy:parallel', () => {
    reject({ fanOutPolicy: 'sequential', joinPolicy: { mode: 'wait-all' } }, 'validation_error', /joinPolicy is meaningful only when fanOutPolicy is 'parallel'/);
  });
  it('rejects an unadvertised joinPolicy.mode (quorum/first/race need child cancellation)', () => {
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'quorum', quorum: 2 } }, 'validation_error', /joinPolicy\.mode='quorum' is not one of/);
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'first' } }, 'validation_error', /joinPolicy\.mode='first' is not one of/);
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'race' } }, 'validation_error', /joinPolicy\.mode='race' is not one of/);
  });
  it('rejects onChildFailure ∉ onChildFailureModes (fail-fast); accepts the advertised collect/absorb', () => {
    // RFC 0118 §seam amendment (openwop#789): the second join axis is gated by the advertised
    // `onChildFailureModes` (= ['collect','absorb']). fail-fast ∉ set → validation_error,
    // discoverably (vs the old undiscoverable hard-coded reject).
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'fail-fast' } }, 'validation_error', /onChildFailure='fail-fast' is not one of/);
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } });
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'absorb' } });
  });
});
