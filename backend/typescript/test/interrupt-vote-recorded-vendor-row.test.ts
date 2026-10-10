/**
 * `interrupt.vote.recorded` (a quorum gate's partial vote, routes/interrupts.ts)
 * is in no corpus codemap row, no payload schema and no registered org: it
 * borrowed the protocol's `interrupt.` family without being a type in it. It is
 * moved onto this host's registered vendor org the way ADR 0749 R2 moved
 * `ui.a2ui-surface` — the STORED spelling on an era-3 log and the major-2 read
 * are `openwop-app.interrupt-vote-recorded`; the v1 wire and every host-internal
 * emitter keep `interrupt.vote.recorded`.
 */
import { describe, expect, it } from 'vitest';
import { toContractVocabulary, toStorageVocabulary } from '../src/storage/eventEra.js';

const V1 = 'interrupt.vote.recorded';
const V2 = 'openwop-app.interrupt-vote-recorded';

describe('interrupt.vote.recorded rides the host vendor row', () => {
  it('an era-3 log stores the vendor spelling and the v1 read inverts it; an era-2 log keeps the v1 spelling', () => {
    expect(toStorageVocabulary(V1, 3)).toBe(V2);
    expect(toStorageVocabulary(V1, 2)).toBe(V1);
    expect(toContractVocabulary(V2, 3, 1)).toBe(V1);
    expect(toContractVocabulary(V1, 2, 1)).toBe(V1);
    expect(toContractVocabulary(V1, 2, 2)).toBe(V2);
    // An era-3 row written verbatim before the row existed is forwarded too.
    expect(toContractVocabulary(V1, 3, 2)).toBe(V2);
  });
});
