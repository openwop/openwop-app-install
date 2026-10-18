/**
 * ADR 0151 Phase 1 — `sanitizeTitle` (OQ-5): a misbehaving free model degrades to the
 * placeholder, never worse. Pure + deterministic; covers quote-stripping, the "Title:"
 * preamble, newline collapse, the length cap (on a word boundary where possible), and
 * garbage→null. The last block witnesses the WIRING: `generateTitle` runs the model's raw
 * completion through `sanitizeTitle` before it can reach the session store (the CLAUDE.md
 * "model output reaches durable state only through validation" rule — without it a raw
 * completion was written verbatim with every test green, grade-tests w28 `gap-sanitize-wiring`).
 *
 * Sabotage: drop the `lastSpace` branch → the cap case reds (mid-word clip); drop the
 * preamble / quote / collapse / sentinel rule → its case reds; `return completion` instead of
 * `return sanitizeTitle(completion)` → the wiring case reds.
 */
import { describe, it, expect, vi } from 'vitest';

// The managed dispatch is the provider seam `resolveHeadlessAi` closes over for text
// (no BYOK opt-in in this process). Stub it to return a chatty, quoted completion.
const managed = vi.hoisted(() => ({ completion: '' }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...original,
    dispatchManagedChat: vi.fn(async (): Promise<import('../src/providers/managedProvider.js').ManagedDispatchResult> => (
      { provider: 'openwop-free', model: 'openwop-free', completion: managed.completion }
    )),
  };
});

import { generateTitle, sanitizeTitle } from '../src/features/chat-autotitle/titleGenerator.js';

describe('ADR 0151 — sanitizeTitle', () => {
  it('returns a clean short title unchanged', () => {
    expect(sanitizeTitle('Refactor the auth middleware')).toBe('Refactor the auth middleware');
  });

  it('strips wrapping straight + smart quotes and backticks', () => {
    expect(sanitizeTitle('"Deploy pipeline"')).toBe('Deploy pipeline');
    expect(sanitizeTitle('“Deploy pipeline”')).toBe('Deploy pipeline');
    expect(sanitizeTitle('`Deploy pipeline`')).toBe('Deploy pipeline');
  });

  it('drops a leading "Title:" / "Title -" preamble', () => {
    expect(sanitizeTitle('Title: Plan the migration')).toBe('Plan the migration');
    expect(sanitizeTitle('title - Plan the migration')).toBe('Plan the migration');
  });

  it('collapses newlines and whitespace runs', () => {
    expect(sanitizeTitle('Plan\n  the   migration')).toBe('Plan the migration');
  });

  it('hard-caps length on a word boundary', () => {
    // 84 chars; the 60-char clip ends mid-word ("…hiring plan f"), the last space is at 58.
    const long = 'Discuss the quarterly revenue forecast and the hiring plan for engineering next year';
    expect(sanitizeTitle(long)).toBe('Discuss the quarterly revenue forecast and the hiring plan');
    // "where possible": no usable space ⇒ the hard 60-char clip.
    expect(sanitizeTitle('a'.repeat(70))).toBe('a'.repeat(60));
  });

  it('returns null for empty / sentinel / too-short garbage', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle('NONE')).toBeNull();
    expect(sanitizeTitle('New chat')).toBeNull();
    expect(sanitizeTitle('untitled')).toBeNull();
    expect(sanitizeTitle('x')).toBeNull();
  });
});

describe('ADR 0151 — generateTitle sanitizes the model completion (wiring)', () => {
  it('a chatty, quoted completion comes back cleaned; a sentinel comes back null', async () => {
    managed.completion = 'Title: "Plan\n the   migration"';
    expect(await generateTitle('user:t', 'plan the migration', 'sure')).toBe('Plan the migration');
    managed.completion = 'NONE';
    expect(await generateTitle('user:t', 'x', 'y')).toBeNull();
  });
});
