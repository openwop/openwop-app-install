/**
 * ADR 0945 P2 — the judge check runs the fidelity judge on the caller's OWN
 * BYOK key and model (user decision 2026-10-27: "the user should be able to
 * specify the provider and model and we use that").
 *
 *  - SPEC: `resolveHeadlessAiForSpec` refuses a ref that is not this tenant's
 *    (IDOR), an unknown provider, and a provider that cannot take the input;
 *    a valid spec dispatches on exactly that provider, model and key.
 *  - EVAL: `runJudgeEval` sends only the live fixture cases, one at a time,
 *    through the production judge and outcome rule. A judge that answers like
 *    the fixture passes; a fooled judge does not; an unusable or unavailable
 *    judge stops the run inside the two-calls-per-case budget.
 * Breaks if a foreign ref is accepted, the chosen model is ignored, a ciOnly
 * case reaches a real model, a wrong judge passes, or a failure keeps spending.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ provider: string; model: string; apiKey: string }> = [];
vi.mock('../src/providers/dispatch.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/dispatch.js')>()),
  dispatchChat: async (req: { provider: string; model: string; apiKey: string }) => { sent.push({ provider: req.provider, model: req.model, apiKey: req.apiKey }); return { completion: 'ok' }; },
}));

import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets } from '../src/byok/secretResolver.js';
import { resolveHeadlessAiForSpec, type HeadlessDispatch } from '../src/host/headlessAi.js';
import { FIDELITY_ATTRIBUTES, JUDGE_EVAL_FIXTURE, LIVE_JUDGE_EVAL_CASES, runJudgeEval, summariseProviderError } from '../src/host/creativeFidelity/index.js';
import { OpenwopError } from '../src/types.js';

const T = 'tnt:judge-check';
const reply = (answers: Record<string, string>): string => JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: answers[attribute] ?? 'match', evidence: `checked ${attribute}` })) });

describe('a caller-chosen BYOK spec', () => {
  beforeEach(async () => {
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    await clearAllSecrets();
    initHostExtPersistence(await openStorage('memory://'));
    sent.length = 0;
  });
  afterAll(async () => { await clearAllSecrets(); process.env.OPENWOP_BYOK_EPHEMERAL = ''; });

  it('refuses a ref from another tenant, an unknown provider, and a provider without image input', async () => {
    await setSecret('theirs', 'KEY-B', { tenantId: 'tnt:other' });
    await setSecret('mine', 'KEY-A', { tenantId: T });
    await expect(resolveHeadlessAiForSpec({ tenantId: T }, { provider: 'anthropic', model: 'm', credentialRef: 'theirs' }, 'image')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(resolveHeadlessAiForSpec({ tenantId: T }, { provider: 'cohere', model: 'm', credentialRef: 'mine' }, 'image')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(resolveHeadlessAiForSpec({ tenantId: T }, { provider: 'anthropic', model: 'm', credentialRef: 'mine' }, 'audio')).rejects.toMatchObject({ httpStatus: 422 });
    expect(sent).toEqual([]);
  });

  it('dispatches on exactly the chosen provider, model and key, and says so', async () => {
    await setSecret('mine', 'KEY-A', { tenantId: T });
    const d = await resolveHeadlessAiForSpec({ tenantId: T }, { provider: 'openai', model: ' gpt-vision-x ', credentialRef: 'mine' }, 'image');
    expect(d).toMatchObject({ provider: 'openai', model: 'gpt-vision-x', route: 'byok-chosen' });
    expect(JSON.stringify(d)).not.toContain('KEY-A');
    await d.dispatch([{ role: 'user', content: 'hi' }], { maxTokens: 10 });
    expect(sent).toEqual([{ provider: 'openai', model: 'gpt-vision-x', apiKey: 'KEY-A' }]);
  });
});

describe('runJudgeEval', () => {
  /** A judge that answers each case the way the fixture says a good judge would.
   *  It finds the case by the order of the calls, which is the fixture order. */
  const faithful = (): HeadlessDispatch & { calls: number } => {
    const d = Object.assign((async () => { const c = LIVE_JUDGE_EVAL_CASES[d.calls]; d.calls += 1; return reply(c.ciJudge); }) as HeadlessDispatch, { calls: 0 });
    return d;
  };

  it('sends only the live cases, never a ciOnly one, and a faithful judge passes every case', async () => {
    expect(LIVE_JUDGE_EVAL_CASES.map((c) => c.id)).toEqual(['identity', 'colour-drift', 'logo-swap', 'extra-part']);
    expect(JUDGE_EVAL_FIXTURE.cases.some((c) => c.ciOnly)).toBe(true);
    const r = await runJudgeEval(faithful());
    expect(r.cases.map((c) => [c.id, c.outcome, c.passed])).toEqual([
      ['identity', 'pass', true], ['colour-drift', 'fail', true], ['logo-swap', 'fail', true], ['extra-part', 'needs_review', true],
    ]);
    expect(r).toMatchObject({ calls: 4, maxCalls: 8, completed: true, passed: true });
  });

  it('a fooled judge (always "match") does not pass, even where stage A saves the outcome', async () => {
    const r = await runJudgeEval(async () => reply({}));
    expect(r.completed).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.cases.find((c) => c.id === 'logo-swap')).toMatchObject({ judged: 'pass', passed: false });
  });

  it('an unusable judge stops after its one repair, inside the budget', async () => {
    let calls = 0;
    const r = await runJudgeEval(async () => { calls += 1; return 'not json'; });
    expect(calls).toBe(2);
    expect(r.cases).toEqual([expect.objectContaining({ id: 'identity', passed: false, error: 'judge_invalid' })]);
    expect(r).toMatchObject({ calls: 2, completed: false, passed: false });
  });

  it('a provider that does not answer stops the run on the first case, without retrying', async () => {
    let calls = 0;
    const r = await runJudgeEval(async () => { calls += 1; throw new Error('anthropic_529'); });
    expect(calls).toBe(1);
    expect(r.cases).toEqual([expect.objectContaining({ id: 'identity', error: 'provider_unavailable' })]);
    expect(r.completed).toBe(false);
  });

  // 2026-10-28: four prod runs stopped here and the log said only
  // `provider_unavailable`. The row now carries the provider's status and
  // codes, and never its message, which can echo the key or the prompt.
  it('a provider failure records its status and codes, never its message', async () => {
    const key = 'AIzaSyD3adb33fC0ffee0123456789abcdefGHIJ';
    const body = JSON.stringify({ error: { code: 429, message: `Quota exceeded for key ${key} on prompt SOURCE 1`, status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'RATE_LIMIT_EXCEEDED', metadata: { key } }] } });
    const r = await runJudgeEval(async () => { throw new Error(`google_429: ${body}`); });
    expect(r.cases[0]!.providerError).toEqual({ status: 429, codes: ['RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'] });
    expect(JSON.stringify(r)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain('Quota exceeded');
  });

  it('a timeout, a body-less failure and a host refusal each say what they were', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(summariseProviderError(timeout)).toEqual({ codes: ['timeout'] });
    expect(summariseProviderError(new Error('google_no_response_body'))).toEqual({ codes: ['google_no_response_body'] });
    expect(summariseProviderError(new OpenwopError('validation_error', 'nope', 422))).toEqual({ codes: ['validation_error'] });
    expect(summariseProviderError(new Error('something odd happened'))).toEqual({ codes: [] });
  });
});
