/**
 * ADR 0720 — what `contextEconomy().enabled` MEANS, pinned so the next reader does not
 * "fix" it the way this iteration nearly did.
 *
 * THE TRAP. The docstring used to say `enabled` is the "OR of any lever on", which the
 * code has never implemented (`enabled: master`). Reading the comment as the SSoT makes
 * the code look broken: a lever can be ON with the master OFF
 * (`lever = envBool(name) ?? master`), so `{ enabled:false, transcriptBudget:true }` is
 * reachable and looks like a projection reporting "disabled" while it truncates history.
 *
 * WHY THE CODE IS RIGHT — the CONSUMER's shape settles it. The env-governed projection
 * (`routes/featureToggles.ts`) emits this capability as
 *     { id:'context-economy', envVar:'OPENWOP_CONTEXT_ECONOMY', enabled, levers:[…] }
 * where EVERY lever carries its own `envVar` and `enabled`. So `enabled` describes the
 * env var named beside it, and a reader of that payload sees "master off, transcript on"
 * accurately. Nothing is concealed, so there is no dishonesty to fix — the SENTENCE was
 * wrong, not the behaviour, and ADR 0720 corrected the sentence.
 *
 * `test/context-economy-caching.test.ts` already pins the lever-on/master-off case on
 * adjacent lines. This file pins the MEANING, so the contract survives the next person
 * who reads the old comment somewhere else and reaches for the OR.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextEconomy } from '../src/host/contextEconomy.js';

const MASTER = 'OPENWOP_CONTEXT_ECONOMY';
const LEVERS = [
  'OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE',
  'OPENWOP_CONTEXT_ECONOMY_TOOL_DIET',
  'OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT',
  'OPENWOP_CONTEXT_ECONOMY_MEMORY',
  'OPENWOP_CONTEXT_ECONOMY_TRANSPORT',
] as const;
const ALL = [MASTER, ...LEVERS];

const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ALL) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ALL) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const leverValues = (): boolean[] => {
  const c = contextEconomy();
  return [c.providerCache, c.toolDiet, c.transcriptBudget, c.memoryBudget, c.transport];
};

describe('ADR 0720 — `enabled` is the MASTER switch, not "any lever on"', () => {
  it('leg 1: everything unset ⇒ a true no-op', () => {
    expect(contextEconomy().enabled).toBe(false);
    expect(leverValues()).toEqual([false, false, false, false, false]);
  });

  it('leg 2 (THE TRAP): a lever ON with the master OFF keeps `enabled` FALSE — deliberately', () => {
    // This is the combination that reads as a bug if you trust the old comment. It is
    // not: `enabled` answers "is OPENWOP_CONTEXT_ECONOMY set", and the projection
    // reports the lever separately, so the operator payload is complete.
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT = '1';
    const c = contextEconomy();
    expect(c.transcriptBudget, 'the lever is genuinely on').toBe(true);
    expect(c.enabled, '`enabled` describes the MASTER env var, not the union').toBe(false);
  });

  it('leg 3: every lever behaves that way, not just the transcript one', () => {
    for (const k of LEVERS) {
      for (const other of ALL) delete process.env[other];
      process.env[k] = '1';
      expect(contextEconomy().enabled, `${k}=1 must NOT flip enabled`).toBe(false);
    }
  });

  it('leg 4: the master ON enables and defaults every lever on', () => {
    process.env[MASTER] = '1';
    expect(contextEconomy().enabled).toBe(true);
    expect(leverValues()).toEqual([true, true, true, true, true]);
  });

  it('leg 5: an explicit lever OFF under a master ON overrides only that lever', () => {
    process.env[MASTER] = '1';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT = '0';
    const c = contextEconomy();
    expect(c.transcriptBudget).toBe(false);
    expect(c.enabled, 'the master is still what `enabled` reports').toBe(true);
    expect([c.providerCache, c.toolDiet, c.memoryBudget, c.transport]).toEqual([true, true, true, true]);
  });

  it('leg 6 (the ANSWER to "is anything happening?"): read the LEVERS, never `enabled`', () => {
    // The practical consequence of legs 2-3, stated as the rule a caller should follow.
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT = '1';
    const c = contextEconomy();
    const anythingActive = leverValues().some(Boolean);
    expect(anythingActive, 'something IS transforming context').toBe(true);
    expect(c.enabled, 'and `enabled` alone would not have told you').toBe(false);
  });
});
