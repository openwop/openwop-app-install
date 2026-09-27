/**
 * runLoopWithBumpFallback — the reasoning-bump degrade path (2026-07-14 board
 * incident: a free-tier Google key has ~zero quota on pro models, so the
 * class-bumped advisor turn 429'd while the tenant's selected flash tier
 * worked). Pins: fall back ONLY on model-availability codes, only when a
 * distinct fallback exists, exactly one extra attempt, and success/other
 * errors pass straight through.
 */
import { describe, it, expect, vi } from 'vitest';
import { runLoopWithBumpFallback, MODEL_FALLBACK_ERROR_CODES } from '../src/host/conversationToolLoop.js';

type R = { finalText: string; error?: { code: string; message: string } };
const ok: R = { finalText: 'answer' };
const err = (code: string): R => ({ finalText: '', error: { code, message: `${code} happened` } });

describe('runLoopWithBumpFallback', () => {
  it('falls back to the selected model when the bumped model is rate-limited', async () => {
    const runOnce = vi.fn(async (m: string) => (m === 'pro' ? err('provider_rate_limited') : ok));
    const { result, modelUsed } = await runLoopWithBumpFallback(runOnce, 'pro', 'flash');
    expect(result).toEqual(ok);
    expect(modelUsed).toBe('flash');
    expect(runOnce).toHaveBeenNthCalledWith(1, 'pro');
    expect(runOnce).toHaveBeenNthCalledWith(2, 'flash');
  });

  it('falls back when the bumped model is rejected (model_not_supported)', async () => {
    const runOnce = vi.fn(async (m: string) => (m === 'pro' ? err('model_not_supported') : ok));
    const { modelUsed } = await runLoopWithBumpFallback(runOnce, 'pro', 'flash');
    expect(modelUsed).toBe('flash');
  });

  it('returns the fallback failure as-is when both models fail (one extra attempt only)', async () => {
    const runOnce = vi.fn(async () => err('provider_rate_limited'));
    const { result, modelUsed } = await runLoopWithBumpFallback(runOnce, 'pro', 'flash');
    expect(result.error?.code).toBe('provider_rate_limited');
    expect(modelUsed).toBe('flash');
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('never falls back without a distinct fallback model', async () => {
    const runOnce = vi.fn(async () => err('provider_rate_limited'));
    await runLoopWithBumpFallback(runOnce, 'pro', null);
    await runLoopWithBumpFallback(runOnce, 'pro', 'pro');
    expect(runOnce).toHaveBeenCalledTimes(2); // one attempt each, no retries
  });

  it('never falls back on non-availability failures', async () => {
    const runOnce = vi.fn(async () => err('return_schema_violation'));
    const { modelUsed } = await runLoopWithBumpFallback(runOnce, 'pro', 'flash');
    expect(modelUsed).toBe('pro');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('passes a clean success straight through', async () => {
    const runOnce = vi.fn(async () => ok);
    const { result, modelUsed } = await runLoopWithBumpFallback(runOnce, 'pro', 'flash');
    expect(result).toEqual(ok);
    expect(modelUsed).toBe('pro');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('covers exactly the two availability codes', () => {
    expect([...MODEL_FALLBACK_ERROR_CODES].sort()).toEqual(['model_not_supported', 'provider_rate_limited']);
  });
});
