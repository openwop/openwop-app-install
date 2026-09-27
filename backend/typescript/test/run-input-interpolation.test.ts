/**
 * Run-time `{{inputs.NAME}}` interpolation from the per-run variable bag
 * (Phase 1 of the reusable-workflow-templates redesign, ADR 0163 follow-on).
 */
import { describe, it, expect } from 'vitest';
import { interpolateRunInputs, hasInputTokens } from '../src/executor/runInputInterpolation.js';

describe('interpolateRunInputs', () => {
  const bag = { topic: 'AI ops', dates: 'July 5', count: 3 };

  it('resolves a token embedded in a string (e.g. a systemPrompt)', () => {
    expect(interpolateRunInputs('Research {{inputs.topic}} deeply', bag))
      .toBe('Research AI ops deeply');
  });

  it('resolves multiple tokens + non-string values coerced to string', () => {
    expect(interpolateRunInputs('{{inputs.dates}} x{{inputs.count}}', bag)).toBe('July 5 x3');
  });

  it('recurses objects and arrays; non-string leaves untouched', () => {
    const out = interpolateRunInputs(
      { systemPrompt: 'Plan {{inputs.dates}}', temperature: 0.2, tags: ['{{inputs.topic}}'] },
      bag,
    );
    expect(out).toEqual({ systemPrompt: 'Plan July 5', temperature: 0.2, tags: ['AI ops'] });
  });

  it('a missing variable collapses to empty (no literal token leaks to the model)', () => {
    expect(interpolateRunInputs('for {{inputs.absent}}!', bag)).toBe('for !');
  });

  it('an undefined bag returns the value unchanged (no-op)', () => {
    expect(interpolateRunInputs('{{inputs.topic}}', undefined)).toBe('{{inputs.topic}}');
  });

  it('hasInputTokens detects references anywhere in a config', () => {
    expect(hasInputTokens({ a: { b: 'x {{inputs.topic}}' } })).toBe(true);
    expect(hasInputTokens({ a: 'no tokens', n: 1 })).toBe(false);
  });
});
