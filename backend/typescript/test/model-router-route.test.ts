/**
 * ADR 0130 Phase 1 / ADR 0714 D1+D3 — the pure per-turn model-routing selector.
 *
 * Breaks if a rule stops matching (threshold, attachment, exact conversationKind),
 * if an attachment turn is routed to a non-`vision-input` target on ANY lane (rule,
 * cooldown, fallback), if cooldown stickiness stops applying inside its window or
 * keeps applying after it, or if the selector stops being a pure function of its
 * inputs (every case below pins an EXACT decision, so a non-deterministic or
 * clock-reading selector reds them — the replay/fork property ADR 0130 relies on).
 * Exact means `toEqual` with the `ruleIndex` (ADR 1016's preview answer), and the
 * threshold and cooldown window are pinned at their boundaries.
 *
 * ADR 1016 D4/D5 added: a target is eligible only if this conversation can call
 * it (its own `dispatchProvider`, a model the catalog lists, vision judged per
 * MODEL), and the fallback is optional (none ⇒ null, the turn keeps its model).
 *
 * Red when (probe-witnessed, w107): the dispatch-provider check, the unlisted
 * (`null`) check, the per-model probe argument, the vision check, the fallback
 * filter, the no-fallback guard, the cooldown eligibility or window, the
 * threshold comparison, the attachment or conversationKind match, or `ruleIndex`
 * is broken.
 */
import { describe, it, expect } from 'vitest';
import { routeTurn, type ModelRouterConfig, type CapabilityProbe } from '../src/features/model-router/routeTurn.js';

// ADR 0714 D3 — `vision-input` is the RFC 0031 §C canonical id `eligible()` actually
// checks. This fixture advertised the NON-canonical `vision` long after the production
// code was corrected away from it (routeTurn.ts:108-111 records that correction), so
// NOTHING was vision-eligible here: every rule was filtered and each attachment turn
// landed on the then-unfiltered fallback. The suite's own assertion checked the stale
// id, so it PASSED on a target that was non-vision by the production predicate — the
// test certified the defect it is named for.
const probe: CapabilityProbe = (provider) => (provider === 'anthropic' || provider === 'google' ? ['vision-input', 'tools'] : ['tools']);

const config: ModelRouterConfig = {
  rules: [
    { when: { kind: 'tokensOver', threshold: 8000 }, target: { provider: 'anthropic', model: 'big' } },
    { when: { kind: 'attachment' }, target: { provider: 'openai', model: 'no-vision' } }, // intentionally non-vision
    { when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } },
  ],
  fallback: { provider: 'anthropic', model: 'default' }, // vision-capable
  cooldownMs: 60_000,
};

describe('routeTurn', () => {
  it('matches a threshold rule', () => {
    const d = routeTurn({ tokenEstimate: 9000 }, config, probe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'anthropic', model: 'big' }, ruleIndex: 0 });
    // `tokensOver` is strict: exactly the threshold does not match.
    expect(routeTurn({ tokenEstimate: 8000 }, config, probe, 0)).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 2 });
  });

  it('falls through to the always rule for a small turn', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 2 });
  });

  it('skips non-vision RULES for an attachment turn and lands on the vision-capable fallback', () => {
    // NAME NARROWED (ADR 0714 D3): this proves the RULE lanes are filtered, which is all
    // this fixture can show — its fallback is vision-capable. The universal claim the old
    // name made ("NEVER routes an attachment turn to a non-vision target") is pinned by
    // the dedicated describe block below, on a fixture where the fallback is NOT.
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, config, probe, 0);
    expect(d).toEqual({ reason: 'fallback', target: { provider: 'anthropic', model: 'default' } });
    expect(probe(d!.target.provider, d!.target.model)).toContain('vision-input'); // the invariant, stated
  });

  it('applies cooldown stickiness when the sticky target is still eligible', () => {
    const d = routeTurn({ tokenEstimate: 9000 }, config, probe, 1000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d).toEqual({ reason: 'cooldown', target: { provider: 'google', model: 'sticky' } });
  });

  it('drops a sticky target that is no longer eligible (attachment + sticky non-vision)', () => {
    const d = routeTurn({ hasAttachment: true }, config, probe, 1000, { lastTarget: { provider: 'openai', model: 'no-vision' }, lastAtMs: 0 });
    // sticky non-vision is ineligible for an attachment turn → the vision fallback
    expect(d).toEqual({ reason: 'fallback', target: { provider: 'anthropic', model: 'default' } });
    expect(probe(d!.target.provider, d!.target.model)).toContain('vision-input');
  });

  it('expires cooldown after the window', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 70_000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 2 });
    // The window is half-open: at exactly cooldownMs it has already expired,
    // and one ms before it the sticky target still holds.
    expect(routeTurn({ tokenEstimate: 100 }, config, probe, 60_000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 }))
      .toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 2 });
    expect(routeTurn({ tokenEstimate: 100 }, config, probe, 59_999, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 }))
      .toEqual({ reason: 'cooldown', target: { provider: 'google', model: 'sticky' } });
  });
});

describe('routeTurn — attachment rule genuinely fires (CHAT-FIRST-PORT A8)', () => {
  // `vision-input` is the RFC 0031 §C canonical id the eligibility gate now checks
  // (corrected from the non-canonical `vision`). anthropic advertises it here.
  const visionProbe: CapabilityProbe = (p) => (p === 'anthropic' ? ['vision-input', 'tools'] : ['tools']);
  const cfg: ModelRouterConfig = {
    rules: [
      { when: { kind: 'attachment' }, target: { provider: 'anthropic', model: 'vision-model' } },
      { when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } },
    ],
    fallback: { provider: 'anthropic', model: 'default' },
  };
  it('an attachment turn routes THROUGH the attachment rule to the vision target', () => {
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, cfg, visionProbe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'anthropic', model: 'vision-model' }, ruleIndex: 0 });
  });
  it('a text-only turn skips the attachment rule (falls to the always rule)', () => {
    const d = routeTurn({ tokenEstimate: 100 }, cfg, visionProbe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 1 });
  });
});

describe('ADR 0714 D1 — the FALLBACK is capability-filtered too, not just the rules', () => {
  // The lane that escaped: `eligible()` guarded the cooldown target and every rule, and
  // the fallback `return` was unfiltered — so an attachment turn on a tenant whose
  // fallback is text-only routed to a non-vision target, and `maybeStampModelRoute` then
  // froze that decision into `run.metadata.modelRoute`, which `:fork` replays verbatim.
  const probe: CapabilityProbe = (p) => (p === 'anthropic' ? ['vision-input', 'tools'] : ['tools']);
  // `minimax` is the real-world instance: it is in CHAT_BYOK_PROVIDERS (so `asTarget`
  // accepts it as a fallback) but has NO entry in PROVIDER_CAPABILITIES, so its probe
  // returns []. This config is persistable through the product's own admin editor.
  const nonVisionFallback: ModelRouterConfig = {
    rules: [{ when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } }],
    fallback: { provider: 'minimax', model: 'text-only' },
  };

  it('an ATTACHMENT turn whose only fallback is non-vision yields NO decision (never an ineligible one)', () => {
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, nonVisionFallback, probe, 0);
    expect(d, 'null = do not route; the caller keeps the run\'s explicit model').toBeNull();
  });

  it('CONTROL: the SAME config without an attachment still routes normally', () => {
    // Proves the refusal is caused by the attachment invariant and not by a broken config
    // — without this leg, a selector that returned null unconditionally would pass above.
    const d = routeTurn({ tokenEstimate: 100 }, nonVisionFallback, probe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 0 });
  });

  it('CONTROL: an attachment turn WITH a vision-capable fallback still routes to it', () => {
    // The other polarity: the filter must not refuse a fallback that IS eligible.
    const cfg: ModelRouterConfig = { ...nonVisionFallback, fallback: { provider: 'anthropic', model: 'vision' } };
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, cfg, probe, 0);
    expect(d).toEqual({ reason: 'fallback', target: { provider: 'anthropic', model: 'vision' } });
  });
});

describe('routeTurn — conversationKind rule (ADR 0130 Phase 6, the board model-tier)', () => {
  const cfg = {
    rules: [{ when: { kind: 'conversationKind' as const, value: 'group' as const }, target: { provider: 'anthropic', model: 'strong' } }],
    fallback: { provider: 'minimax', model: 'small' },
  };
  // ADR 0714 D3 — canonical id; this block's turns are text-only, so eligibility is a
  // no-op here, but a fixture must never re-teach the stale spelling.
  const probe = (): readonly string[] => ['vision-input'];

  it('a group (board/multi-agent) conversation routes to the rule target', () => {
    const d = routeTurn({ tokenEstimate: 10, conversationKind: 'group' }, cfg, probe, 0);
    expect(d).toEqual({ target: { provider: 'anthropic', model: 'strong' }, reason: 'rule', ruleIndex: 0 });
  });

  it('a 1:1 turn (no conversationKind) falls through to the fallback', () => {
    const d = routeTurn({ tokenEstimate: 10 }, cfg, probe, 0);
    expect(d).toEqual({ target: { provider: 'minimax', model: 'small' }, reason: 'fallback' });
  });

  it('a channel does not match a group rule (exact kind match)', () => {
    const d = routeTurn({ tokenEstimate: 10, conversationKind: 'channel' }, cfg, probe, 0);
    expect(d).toEqual({ target: { provider: 'minimax', model: 'small' }, reason: 'fallback' });
  });
});

describe('ADR 1016 D4/D5 — only a listed model of the conversation\'s own provider; the fallback is optional', () => {
  // A per-MODEL probe, as `listedModelCapabilities` answers: `null` = not in the catalog.
  const catalog: Record<string, readonly string[]> = {
    'anthropic/strong': ['vision-input', 'tools'],
    'anthropic/text-only': ['tools'],
    'openai/cheap': ['vision-input', 'tools'],
  };
  const probe: CapabilityProbe = (p, m) => catalog[`${p}/${m}`] ?? null;
  const cfg: ModelRouterConfig = {
    rules: [
      { when: { kind: 'tokensOver', threshold: 1000 }, target: { provider: 'openai', model: 'cheap' } },
      { when: { kind: 'tokensOver', threshold: 1000 }, target: { provider: 'anthropic', model: 'strong' } },
      { when: { kind: 'always' }, target: { provider: 'anthropic', model: 'typo-model' } },
    ],
  };

  it('skips a rule for ANOTHER provider and takes the next rule this conversation can call', () => {
    // An anthropic-keyed conversation: the openai rule would 422 every turn
    // (explicit_ref_wrong_provider) — it is skipped, never chosen.
    const d = routeTurn({ tokenEstimate: 5000, dispatchProvider: 'anthropic' }, cfg, probe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'anthropic', model: 'strong' }, ruleIndex: 1 });
  });

  it('CONTROL: an openai-keyed conversation takes the openai rule', () => {
    const d = routeTurn({ tokenEstimate: 5000, dispatchProvider: 'openai' }, cfg, probe, 0);
    expect(d).toEqual({ reason: 'rule', target: { provider: 'openai', model: 'cheap' }, ruleIndex: 0 });
  });

  it('never routes to a model the catalog does not list (probe null)', () => {
    // Only the `always` rule matches a short turn, and its model is unlisted.
    expect(routeTurn({ tokenEstimate: 10, dispatchProvider: 'anthropic' }, cfg, probe, 0)).toBeNull();
  });

  it('with NO fallback, a turn no rule matches keeps its own model (null)', () => {
    const noFallback: ModelRouterConfig = { rules: [{ when: { kind: 'attachment' }, target: { provider: 'anthropic', model: 'strong' } }] };
    expect(routeTurn({ tokenEstimate: 10, dispatchProvider: 'anthropic' }, noFallback, probe, 0)).toBeNull();
  });

  it('judges vision per MODEL: an attachment turn skips a text-only model of a vision provider', () => {
    const c: ModelRouterConfig = {
      rules: [{ when: { kind: 'attachment' }, target: { provider: 'anthropic', model: 'text-only' } }],
      fallback: { provider: 'anthropic', model: 'strong' },
    };
    const d = routeTurn({ hasAttachment: true, dispatchProvider: 'anthropic' }, c, probe, 0);
    expect(d).toEqual({ reason: 'fallback', target: { provider: 'anthropic', model: 'strong' } });
  });
});
