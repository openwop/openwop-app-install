/**
 * The two host defects the corpus steward's suite 2.45.15 witness wave found at
 * major 2: the v2 `run` section of `configurable` was ignored by the executor,
 * and `/prompts:render` answered an unbound required variable with a VENDOR code
 * where the v2 OpenAPI names `validation_error`. The executor halves are driven
 * end to end in `run-timeout.test.ts`; this file pins the two seams.
 *
 * Breaks it (round-1 probes, witnessed): dropping the v1 flat read
 * (8fw2g2-rro-flat), dropping the `typeof section === 'object'` guard
 * (rro-typeof — reds on the ABSENT-section leg, where `undefined[key]` throws),
 * and mapping `prompt_variable_unresolved` to any other v2 code (rro-v2code).
 * The `run: 7` leg pins that a scalar section is never returned as the option
 * value (8fw2g2-rro-scalar-r2).
 */
import { describe, expect, it } from 'vitest';
import { runOption } from '../src/host/runOptions.js';
import { v2ErrorCode } from '../src/middleware/protocolVersion.js';

describe('runOption — one read for both majors', () => {
  it('reads the v1 flat key', () => {
    expect(runOption({ runTimeoutMs: 5 }, 'runTimeoutMs')).toBe(5);
  });
  it('reads the v2 closed run section', () => {
    expect(runOption({ version: 1, run: { recursionLimit: 3, escalationThreshold: 0.4 } }, 'recursionLimit')).toBe(3);
    expect(runOption({ version: 1, run: { escalationThreshold: 0.4 } }, 'escalationThreshold')).toBe(0.4);
  });
  it('the flat key wins when both are present (only a v1 bag can carry it)', () => {
    expect(runOption({ runTimeoutMs: 5, run: { runTimeoutMs: 9 } }, 'runTimeoutMs')).toBe(5);
  });
  it('absent, null, or a non-object section reads undefined', () => {
    expect(runOption(undefined, 'runTimeoutMs')).toBeUndefined();
    expect(runOption({ version: 1 }, 'runTimeoutMs')).toBeUndefined();
    expect(runOption({ version: 1, run: null }, 'runTimeoutMs')).toBeUndefined();
    expect(runOption({ version: 1, run: 7 }, 'runTimeoutMs')).toBeUndefined();
  });
});

describe('v2 error code for an unbound required prompt variable', () => {
  it('is the registered validation_error, never a vendor code (errors.md)', () => {
    expect(v2ErrorCode('prompt_variable_unresolved')).toBe('validation_error');
  });
});
