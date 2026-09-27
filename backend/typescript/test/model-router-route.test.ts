/**
 * ADR 0130 Phase 1 — the pure per-turn model-routing selector.
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
    expect(d).toMatchObject({ reason: 'rule', target: { provider: 'anthropic', model: 'big' } });
  });

  it('falls through to the always rule for a small turn', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 0);
    expect(d?.target).toMatchObject({ provider: 'openai', model: 'cheap' });
  });

  it('skips non-vision RULES for an attachment turn and lands on the vision-capable fallback', () => {
    // NAME NARROWED (ADR 0714 D3): this proves the RULE lanes are filtered, which is all
    // this fixture can show — its fallback is vision-capable. The universal claim the old
    // name made ("NEVER routes an attachment turn to a non-vision target") is pinned by
    // the dedicated describe block below, on a fixture where the fallback is NOT.
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, config, probe, 0);
    expect(d).not.toBeNull();
    expect(probe(d!.target.provider)).toContain('vision-input');
    expect(d!.target).toMatchObject({ provider: 'anthropic' });
  });

  it('applies cooldown stickiness when the sticky target is still eligible', () => {
    const d = routeTurn({ tokenEstimate: 9000 }, config, probe, 1000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d).toMatchObject({ reason: 'cooldown', target: { provider: 'google', model: 'sticky' } });
  });

  it('drops a sticky target that is no longer eligible (attachment + sticky non-vision)', () => {
    const d = routeTurn({ hasAttachment: true }, config, probe, 1000, { lastTarget: { provider: 'openai', model: 'no-vision' }, lastAtMs: 0 });
    expect(d?.reason).not.toBe('cooldown'); // sticky non-vision is ineligible for an attachment turn
    expect(d).not.toBeNull();
    expect(probe(d!.target.provider)).toContain('vision-input');
  });

  it('expires cooldown after the window', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 70_000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d?.reason).not.toBe('cooldown');
  });

  it('is deterministic', () => {
    expect(routeTurn({ tokenEstimate: 9000 }, config, probe, 0)).toEqual(routeTurn({ tokenEstimate: 9000 }, config, probe, 0));
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
    expect(d).toMatchObject({ reason: 'rule', target: { provider: 'anthropic', model: 'vision-model' } });
  });
  it('a text-only turn skips the attachment rule (falls to the always rule)', () => {
    const d = routeTurn({ tokenEstimate: 100 }, cfg, visionProbe, 0);
    expect(d).toMatchObject({ reason: 'rule', target: { provider: 'openai', model: 'cheap' } });
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
    expect(d).toMatchObject({ reason: 'rule', target: { provider: 'openai', model: 'cheap' } });
  });

  it('CONTROL: an attachment turn WITH a vision-capable fallback still routes to it', () => {
    // The other polarity: the filter must not refuse a fallback that IS eligible.
    const cfg: ModelRouterConfig = { ...nonVisionFallback, fallback: { provider: 'anthropic', model: 'vision' } };
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, cfg, probe, 0);
    expect(d).toMatchObject({ reason: 'fallback', target: { provider: 'anthropic', model: 'vision' } });
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
    expect(d).toEqual({ target: { provider: 'anthropic', model: 'strong' }, reason: 'rule' });
  });

  it('a 1:1 turn (no conversationKind) falls through to the fallback', () => {
    const d = routeTurn({ tokenEstimate: 10 }, cfg, probe, 0);
    expect(d).toEqual({ target: { provider: 'minimax', model: 'small' }, reason: 'fallback' });
  });

  it('a channel does not match a group rule (exact kind match)', () => {
    const d = routeTurn({ tokenEstimate: 10, conversationKind: 'channel' }, cfg, probe, 0);
    expect(d?.reason).toBe('fallback');
  });
});
