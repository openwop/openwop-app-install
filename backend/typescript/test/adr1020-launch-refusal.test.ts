/**
 * ADR 1020 D5 (CS70WF-6) — a run start the host REFUSED keeps its code through the
 * campaign launcher tools: the feature gate, the hard-cap budget and the plan run
 * limit each become their own typed tool error; anything else stays the caller's
 * generic failure, so an unrelated error's text never reaches the model.
 *
 * Built from the REAL throwers (`WorkflowFeatureRefusedError`, and the
 * `OpenwopError` shapes `runStarter.ts` / `planRunLimit.ts` raise), not stand-ins.
 *
 * Red when: `launchRefusalResult` returns null for a known reason (the old
 * `dispatch_failed` collapse); it relays an OpenwopError with an unknown reason;
 * or it copies the error's own message (each case asserts the host sentence).
 */
import { describe, expect, it } from 'vitest';
import { launchRefusalResult } from '../src/host/agentToolKit.js';
import { WorkflowFeatureRefusedError } from '../src/host/workflowFeatureGate.js';
import { OpenwopError } from '../src/types.js';

const parse = (r: ReturnType<typeof launchRefusalResult>) => (r ? (JSON.parse(r.content) as Record<string, unknown>) : null);

describe('ADR 1020 D5 — launchRefusalResult', () => {
  it('the feature gate: plan, toggle and unresolved each keep their reason and the feature', () => {
    for (const [blockedBy, reason] of [['plan', 'not_entitled'], ['toggle', 'feature_disabled'], ['unresolved', 'feature_unavailable']] as const) {
      const r = launchRefusalResult(new WorkflowFeatureRefusedError('campaign-channels', blockedBy, 'campaign-studio.channel.landing-page'));
      expect(r?.isError).toBe(true);
      expect(parse(r)).toMatchObject({ error: 'forbidden', reason, feature: 'campaign-channels' });
    }
  });

  it('the budget hard cap and the plan run limit keep their code and reason', () => {
    const cases: Array<[OpenwopError, string, string]> = [
      [new OpenwopError('rate_limited', 'x', 429, { workflowId: 'w', reason: 'workflow_budget_exhausted' }), 'rate_limited', 'workflow_budget_exhausted'],
      [new OpenwopError('rate_limited', 'x', 429, { reason: 'plan_run_limit_reached', limit: 10, month: '2026-10' }), 'rate_limited', 'plan_run_limit_reached'],
      [new OpenwopError('rate_limited', 'x', 429, { reason: 'plan_run_limit_contention', retryAfterS: 2 }), 'rate_limited', 'plan_run_limit_contention'],
      [new OpenwopError('service_unavailable', 'x', 503, { reason: 'plan_run_limit_unavailable', retryAfterS: 5 }), 'service_unavailable', 'plan_run_limit_unavailable'],
    ];
    for (const [err, error, reason] of cases) {
      const body = parse(launchRefusalResult(err));
      expect(body).toMatchObject({ error, reason });
      // A host sentence, never the thrower's own text.
      expect(body?.message).not.toBe('x');
      expect(String(body?.message).length).toBeGreaterThan(20);
    }
  });

  it('anything else stays the caller\'s generic failure (null)', () => {
    expect(launchRefusalResult(new Error('db exploded: password=hunter2'))).toBeNull();
    expect(launchRefusalResult(new OpenwopError('internal_error', 'secret detail', 500, { reason: 'something_else' }))).toBeNull();
    expect(launchRefusalResult(new OpenwopError('rate_limited', 'no reason', 429))).toBeNull();
    expect(launchRefusalResult(undefined)).toBeNull();
  });
});
