/**
 * RFC 0118 — core.dispatch fan-out REGISTRATION validation (host/workflowDefinitionValidation.ts).
 * The host advertises dispatch.fanOutSupported:true + joinModes:['wait-all'], so a parallel config
 * is ACCEPTED (the campaign-orchestration consumer's contract (2)); the negative conformance cases
 * are rejected. Honesty: only the honestly-honorable modes are accepted (no in-flight child
 * cancellation → quorum/first/race + fail-fast rejected).
 *
 * @see RFCS/0118-parallel-subworkflow-fan-out-and-join.md, docs/adr/0165-rfc-0118-parallel-fan-out-witness.md
 */
import { describe, it, expect } from 'vitest';
import { checkMappingCapability } from '../src/host/workflowDefinitionValidation.js';

const node = (config: Record<string, unknown>) => [{ nodeId: 'd', typeId: 'core.dispatch', config }];
const accept = (config: Record<string, unknown>) => expect(() => checkMappingCapability(node(config))).not.toThrow();
const reject = (config: Record<string, unknown>) => expect(() => checkMappingCapability(node(config))).toThrow();

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
    reject({ fanOutPolicy: 'broadcast' });
  });
  it('rejects joinPolicy present without fanOutPolicy:parallel', () => {
    reject({ fanOutPolicy: 'sequential', joinPolicy: { mode: 'wait-all' } });
  });
  it('rejects an unadvertised joinPolicy.mode (quorum/first/race need child cancellation)', () => {
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'quorum', quorum: 2 } });
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'first' } });
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'race' } });
  });
  it('rejects onChildFailure ∉ onChildFailureModes (fail-fast); accepts the advertised collect/absorb', () => {
    // RFC 0118 §seam amendment (openwop#789): the second join axis is gated by the advertised
    // `onChildFailureModes` (= ['collect','absorb']). fail-fast ∉ set → validation_error,
    // discoverably (vs the old undiscoverable hard-coded reject).
    reject({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'fail-fast' } });
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } });
    accept({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'absorb' } });
  });
});
