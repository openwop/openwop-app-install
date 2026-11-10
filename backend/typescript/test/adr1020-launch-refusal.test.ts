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
      const err = new WorkflowFeatureRefusedError('campaign-channels', blockedBy, 'campaign-studio.channel.landing-page');
      const r = launchRefusalResult(err);
      expect(r?.isError).toBe(true);
      const body = parse(r);
      expect(body).toMatchObject({ error: 'forbidden', reason, feature: 'campaign-channels' });
      // A host sentence, never the thrower's own text, and none of its other details.
      expect(typeof body?.message).toBe('string');
      expect(body?.message).not.toBe(err.message);
      expect(String(body?.message).length).toBeGreaterThan(20);
      expect(body).not.toHaveProperty('workflowId');
    }
  });

  it('the budget hard cap and the plan run limit keep their code and reason', () => {
    // Realistic thrower messages (long enough that "a copy" and "a host sentence" differ on content, not length).
    const cases: Array<[OpenwopError, string, string]> = [
      [new OpenwopError('rate_limited', 'Workflow w has exhausted its daily budget (hard cap on).', 429, { workflowId: 'w', reason: 'workflow_budget_exhausted' }), 'rate_limited', 'workflow_budget_exhausted'],
      [new OpenwopError('rate_limited', 'Plan run limit of 10 reached for 2026-10.', 429, { reason: 'plan_run_limit_reached', limit: 10, month: '2026-10' }), 'rate_limited', 'plan_run_limit_reached'],
      [new OpenwopError('rate_limited', 'Plan run limit counter contended; retry after 2 s.', 429, { reason: 'plan_run_limit_contention', retryAfterS: 2 }), 'rate_limited', 'plan_run_limit_contention'],
      [new OpenwopError('service_unavailable', 'Plan run limit store unavailable; retry after 5 s.', 503, { reason: 'plan_run_limit_unavailable', retryAfterS: 5 }), 'service_unavailable', 'plan_run_limit_unavailable'],
    ];
    for (const [err, error, reason] of cases) {
      const r = launchRefusalResult(err);
      expect(r?.isError).toBe(true);
      const body = parse(r);
      expect(body).toMatchObject({ error, reason });
      // A host sentence, never the thrower's own text.
      expect(typeof body?.message).toBe('string');
      expect(body?.message).not.toBe(err.message);
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
