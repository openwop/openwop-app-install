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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STRATEGY_TOGGLE_ID } from '../src/features/strategy/types.js';
import { STRATEGY_GATE_TOGGLE_ID } from '../src/features/strategy/activationApproval.js';
import { strategyFeature } from '../src/features/strategy/feature.js';

describe('ADR 0676 D3 — the cadence gate binds the right toggle', () => {
  it('leg (a): the exported id is the feature toggle, and it is the one the feature registers', () => {
    // Also the "declared, not graduated" leg: a graduated feature declares no default, so
    // `toggleDefault?.id` would be undefined and this reds — and a `featureId` naming a
    // graduated toggle makes the daemon skip every fire forever (the `kb-reindex` lane
    // asserts the ABSENCE of a featureId for exactly this reason). A separate leg (c) said
    // the same thing and was removed in /grade-tests wave 19 (probe w19g1-cg-featid).
    expect(STRATEGY_TOGGLE_ID).toBe('strategy');
    expect(strategyFeature.toggleDefault?.id, 'the job gates on the id the feature declares').toBe(STRATEGY_TOGGLE_ID);
  });

  it('leg (b): the gate resolves PER TENANT, so an opt-in strategy fires wherever it is on', () => {
    // ADR 0892 made strategy default-OFF. That is only safe because the daemon decides
    // per job tenant (`resolveOne(featureId, { tenantId })`): a workspace that enabled
    // strategy (globally, per-tenant override, or app migration 24) still fires.
    expect(strategyFeature.toggleDefault?.status).toBe('off');
    const daemon = readFileSync(new URL('../src/host/scheduleDaemon.ts', import.meta.url), 'utf8');
    expect(daemon, 'the cadence gate must resolve per tenant').toMatch(/resolveOne\(job\.featureId, \{ tenantId: job\.tenantId \}\)/);
    // The near-miss, asserted by NAME so the substitution cannot pass silently.
    expect(STRATEGY_TOGGLE_ID).not.toBe(STRATEGY_GATE_TOGGLE_ID);
  });

  it('leg (d): the cadence registrar actually passes featureId — the wiring, not just the constant', () => {
    // Comments stripped: a commented-out `// featureId: STRATEGY_TOGGLE_ID,` used to satisfy the
    // regex while the gate was inert (wave 19 probe w19g1-cg-wiring-comment). Ceiling: a source
    // pin — the behavioural witness (`applyCadenceConfig` → `getJob().featureId`) needs the chain
    // loader + registry + storage, a far heavier layer than this claim.
    const src = readFileSync(new URL('../src/features/strategy/cadence.ts', import.meta.url), 'utf8')
      .replace(/^\s*(\*|\/\/).*$/gm, '');
    // Mechanism-vs-wiring: legs (a)-(c) all pass with a correct constant that nothing uses.
    expect(src, 'registerJob must stamp the featureId or the gate is inert').toMatch(/featureId:\s*STRATEGY_TOGGLE_ID/);
  });
});
