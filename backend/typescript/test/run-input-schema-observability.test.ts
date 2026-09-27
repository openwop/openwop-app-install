/**
 * RIC-1 (ADR 0197) — an uncompilable declared `inputSchema` must fail open
 * OBSERVABLY, not silently. Previously the `ajv.compile` catch set the validator
 * to null with an empty body, so a schema-bearing workflow whose schema Ajv
 * can't compile had its input guard SILENTLY dropped — invisible to the author
 * (who declared the schema) and the operator (who thinks inputs are validated).
 *
 * The fix keeps the fail-open contract (the run proceeds, `validateRunInputs`
 * returns null) but emits ONE warn per uncompilable schema so the dropped guard
 * is observable. This witness pins the warn AND the preserved fail-open, and
 * that a valid / schema-less run stays silent (no false alarms).
 *
 * The host logger is mocked here in isolation (this file never boots the app),
 * so the module-level logger in runInputValidation becomes the spy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/observability/logger.js', () => {
  const mk = (): Record<string, unknown> => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => mk() });
  return { createLogger: () => mk() };
});

import { validateRunInputs } from '../src/host/runInputValidation.js';

// An unresolvable `$ref` throws at `ajv.compile`. Each test below uses DISTINCT
// content because the fix de-dupes by schema CONTENT via a module-level set that
// persists across cases (so reusing content would cross-contaminate the counts).
const uncompilable = (tag: string): Record<string, unknown> => ({ $ref: `#/$defs/missing-${tag}` });
// A fresh object with the SAME content — simulates the ADR 0474 published-launch
// path, where `getRevision` JSON.parses a new `inputSchema` object per request.
const freshCopy = (o: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

beforeEach(() => { warn.mockReset(); });

describe('RIC-1 — uncompilable inputSchema fails open OBSERVABLY', () => {
  it('warns when a declared schema cannot compile, and still fails open (null)', () => {
    const errs = validateRunInputs(uncompilable('A'), { a: 1 });
    expect(errs).toBeNull(); // fail-open contract preserved
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/schema|uncompil/i),
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('warns at most ONCE per distinct schema CONTENT — even across fresh-deserialized objects (the published-launch path)', () => {
    const content = uncompilable('B');
    // Three DISTINCT objects, identical content — the WeakMap (object identity)
    // would miss every time; the content de-dupe must still warn exactly once.
    validateRunInputs(freshCopy(content), { a: 1 });
    validateRunInputs(freshCopy(content), { a: 2 });
    validateRunInputs(freshCopy(content), { a: 3 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn for a schema-less run or a valid, compilable schema', () => {
    expect(validateRunInputs(undefined, { a: 1 })).toBeNull();
    expect(validateRunInputs(null, { a: 1 })).toBeNull();
    validateRunInputs({ type: 'object', properties: { a: { type: 'number' } } }, { a: 1 });
    expect(warn).not.toHaveBeenCalled();
  });
});
