/**
 * ADR 0676 D3 (`SPWF-8`) — strategy cadence jobs are gated on the `strategy` toggle at
 * FIRE time, not only on the route.
 *
 * Born red: `requireFeatureEnabled` runs only on GET/PUT `/strategy/cadence`
 * (`routes.ts`), so a tenant could disable `strategy` and the cadence kept running its
 * chains — billing a BYOK LLM call per entry, weekly.
 *
 * The filed cause was WRONG and that is why leg (c) exists. The per-tenant fire-time gate
 * ALREADY existed (`scheduleDaemon.ts:109-127`) and is opt-in ("Absent featureId ⇒
 * ungated"); strategy simply never opted in while `insights-suite` and `knowledge-sync`
 * both did. "No gate exists" would have invited building a SECOND gate beside the working
 * one.
 *
 * Leg (b) is the non-vacuity leg and it guards a specific near-miss: the only EXPORTED
 * toggle constant in this feature used to be `STRATEGY_GATE_TOGGLE_ID =
 * 'strategy-approval-gate'`, whose default is `status:'off'`. An implementer reaching for
 * the exported symbol would have stopped EVERY strategy cadence job for EVERY tenant,
 * silently (one `log.info`). Leg (b) turns red on that substitution; legs (a) and (c) do not.
 */
import { describe, expect, it } from 'vitest';
import { STRATEGY_TOGGLE_ID } from '../src/features/strategy/types.js';
import { STRATEGY_GATE_TOGGLE_ID } from '../src/features/strategy/activationApproval.js';
import { strategyFeature } from '../src/features/strategy/feature.js';

describe('ADR 0676 D3 — the cadence gate binds the right toggle', () => {
  it('leg (a): the exported id is the feature toggle, and it is the one the feature registers', () => {
    expect(STRATEGY_TOGGLE_ID).toBe('strategy');
    expect(strategyFeature.toggleDefault?.id, 'the job gates on the id the feature declares').toBe(STRATEGY_TOGGLE_ID);
  });

  it('leg (b): the gating toggle is DEFAULT-ON, so a tenant that never touched it still fires', () => {
    // `getEffectiveConfig` returns the code-registered default when no override row
    // exists, so `status` here IS what a fresh tenant resolves.
    expect(strategyFeature.toggleDefault?.status, 'a default-off toggle would stop every cadence job for every tenant').toBe('on');
    // The near-miss, asserted by NAME so the substitution cannot pass silently.
    expect(STRATEGY_TOGGLE_ID).not.toBe(STRATEGY_GATE_TOGGLE_ID);
  });

  it('leg (c): the toggle is DECLARED (not graduated) — a featureId naming a graduated toggle makes the daemon skip every fire forever', () => {
    // The `kb-reindex` lane asserts the ABSENCE of a featureId for exactly this reason
    // (`kb-reindex-scheduled-drain.test.ts:120-123`). Strategy may carry one only because
    // it declares a default; if the toggle were ever graduated, this leg goes red and the
    // `featureId` must be removed in the same change.
    expect(strategyFeature.toggleDefault, 'a graduated feature declares no default').toBeTruthy();
    expect(strategyFeature.toggleDefault?.id).toBe('strategy');
  });

  it('leg (d): the cadence registrar actually passes featureId — the wiring, not just the constant', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/features/strategy/cadence.ts', import.meta.url), 'utf8');
    // Mechanism-vs-wiring: legs (a)-(c) all pass with a correct constant that nothing uses.
    expect(src, 'registerJob must stamp the featureId or the gate is inert').toMatch(/featureId:\s*STRATEGY_TOGGLE_ID/);
  });
});
