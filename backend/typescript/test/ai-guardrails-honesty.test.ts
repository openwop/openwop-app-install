/**
 * XCH-CORE-3 (LLM-EXCHANGE-AUDIT 2026-07-13): the guardrails node used to
 * fabricate an enforced-looking pass ({passed:true}) on hosts without
 * ctx.guardrails — a fail-open filter. Pin the honest contract: pass-throughs
 * are marked enforced:false + reason, real evaluations enforced:true, and
 * config.requireEnforcement turns the capability gap into a typed failure.
 *
 * TST-BNX-3. Red when: the pass-through claims `enforced:true`,
 * `requireEnforcement` is ignored, or a real evaluation loses `enforced:true`.
 */
import { describe, expect, it } from 'vitest';
import { guardrails } from '../../../packs/core.openwop.ai/index.mjs';

describe('core.openwop.ai.guardrails honesty contract (XCH-CORE-3)', () => {
  it('marks the no-capability pass-through as UNENFORCED', async () => {
    const r = await guardrails({ inputs: { text: 'hi' }, config: {} });
    expect(r.outputs).toMatchObject({ passed: true, violations: [], enforced: false, reason: 'host_capability_missing' });
  });

  it('fails typed when requireEnforcement is set and the host lacks the capability', async () => {
    await expect(guardrails({ inputs: { text: 'hi' }, config: { requireEnforcement: true } }))
      .rejects.toMatchObject({ code: 'HOST_CAPABILITY_MISSING' });
  });

  it('marks a real host evaluation as enforced', async () => {
    const ctx = {
      inputs: { text: 'hi' },
      config: { checks: ['pii'] },
      guardrails: { evaluate: async () => ({ passed: false, violations: [{ check: 'pii' }] }) },
    };
    const r = await guardrails(ctx);
    expect(r.outputs).toEqual({ enforced: true, passed: false, violations: [{ check: 'pii' }] });
  });
});
