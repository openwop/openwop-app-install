/**
 * ADR 0489 D1 — the FIRST shipped `already-satisfied` checkpoint.
 *
 * The three-valued verdict landed with full unit + sabotage coverage and then sat
 * UNREACHABLE: every shipped checkpoint only ever returned pass-or-fail, so the
 * adaptive behaviour had no live path at all. Same "built but never invoked"
 * shape as DATA-T1. This pins the arm now that one exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const byok = vi.hoisted(() => ({ listStoredRefs: vi.fn() }));
vi.mock('../lib/byokClient.js', () => byok);

const { registerKeysWalkthroughActions, KEYS_WALKTHROUGH_CHECKPOINT_IDS } = await import('../walkthroughActions.js');
const { getWalkthroughCheckpoint, __resetWalkthroughRegistryForTests, narrowCheckpointVerdict } =
  await import('../../walkthroughs/actionRegistry.js');

const CP = 'byok.provider-configured';

beforeEach(() => {
  vi.clearAllMocks();
  __resetWalkthroughRegistryForTests();
  registerKeysWalkthroughActions();
});

describe('ADR 0489 D1 — byok.provider-configured', () => {
  it('is declared in the pack\'s checkpoint ids (so coverage can pin it)', () => {
    expect([...KEYS_WALKTHROUGH_CHECKPOINT_IDS]).toContain(CP);
    expect(getWalkthroughCheckpoint(CP)).toBeTruthy();
  });

  it('returns ALREADY-SATISFIED when a provider is already connected', async () => {
    byok.listStoredRefs.mockResolvedValue(['byok:openai:abc']);
    const verdict = narrowCheckpointVerdict(await getWalkthroughCheckpoint(CP)!.evaluate());
    expect(typeof verdict).toBe('object');
    expect(verdict).toMatchObject({ satisfied: true });
    expect((verdict as { because: string }).because).toMatch(/already connected/i);
  });

  it('PASSES (teaches the step) when no provider is connected', async () => {
    byok.listStoredRefs.mockResolvedValue([]);
    expect(narrowCheckpointVerdict(await getWalkthroughCheckpoint(CP)!.evaluate())).toBeNull();
  });

  it('a FAILED read passes rather than cancelling — cannot-check is not "no key"', async () => {
    // A checkpoint that killed a tutorial because a read blipped would be exactly
    // the dishonesty this engine refuses everywhere else.
    byok.listStoredRefs.mockRejectedValue(new Error('network'));
    expect(narrowCheckpointVerdict(await getWalkthroughCheckpoint(CP)!.evaluate())).toBeNull();
  });

  it('NEVER returns a failure verdict — this checkpoint cannot cancel a walkthrough', async () => {
    for (const refs of [[], ['a'], ['a', 'b']]) {
      byok.listStoredRefs.mockResolvedValue(refs);
      const v = narrowCheckpointVerdict(await getWalkthroughCheckpoint(CP)!.evaluate());
      expect(typeof v === 'string', `refs=${JSON.stringify(refs)} produced a cancelling verdict`).toBe(false);
    }
  });
});
