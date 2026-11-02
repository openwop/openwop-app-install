/**
 * Brand compliance scorer + voice resolver (ADR 0155, Phase 2) — PURE unit
 * tests (no app boot). Verifies:
 *   - banned-phrase hit → hasBannedPhrase + score capped ≤30 + fails threshold
 *   - whole-word matching (no false positive on a substring)
 *   - per-channel length cap → length error + deduction
 *   - formality heuristic flags casual content against a formal brand
 *   - resolveVoice renders the channel rule, approved + banned phrases
 *   - clean content scores 100 and passes
 *
 * TST-BBR-2 (w66 g4, sabotage-witnessed). Expected scores are hand-computed from
 * the rule table, never by the scorer. Red when: the banned-phrase cap is removed;
 * phrase matching stops anchoring on word boundaries; the length deduction (25)
 * or the casual-marker deduction (min(20, n×6)) changes; the formality threshold
 * moves; a channel's formalityOverride stops winning in resolveVoice.
 */

import { describe, expect, it } from 'vitest';
import {
  scoreComplianceDeterministic, resolveVoice, BANNED_SCORE_CEILING,
} from '../src/features/brand/scoring.js';
import {
  DEFAULT_GOVERNANCE, EMPTY_KEY_PHRASES, EMPTY_POSITIONING, EMPTY_VOICE_PROFILE, type Brand,
} from '../src/features/brand/types.js';

function brand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: 'b1', tenantId: 't1', orgId: 'o1', name: 'FlashPick',
    description: '', status: 'active',
    voiceProfile: { ...EMPTY_VOICE_PROFILE },
    positioning: { ...EMPTY_POSITIONING },
    keyPhrases: { ...EMPTY_KEY_PHRASES },
    channelVoiceRules: [],
    governance: { ...DEFAULT_GOVERNANCE },
    createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('brand scoring — banned phrases', () => {
  it('caps the score ≤30 and fails the threshold on a banned-phrase hit', () => {
    const b = brand({ keyPhrases: { ...EMPTY_KEY_PHRASES, bannedPhrases: ['revolutionary'] } });
    const r = scoreComplianceDeterministic('Our revolutionary new system saves time.', b);
    expect(r.hasBannedPhrase).toBe(true);
    expect(r.deterministicScore).toBeLessThanOrEqual(BANNED_SCORE_CEILING);
    expect(r.passesThreshold).toBe(false);
    expect(r.issues.some((i) => i.category === 'banned-phrase' && i.severity === 'error')).toBe(true);
  });

  it('matches whole words only (no false positive on a substring)', () => {
    const b = brand({ keyPhrases: { ...EMPTY_KEY_PHRASES, bannedPhrases: ['pick'] } });
    // "FlashPicker" contains "pick" as a substring but not as a whole word.
    const r = scoreComplianceDeterministic('The FlashPicker handles it.', b);
    expect(r.hasBannedPhrase).toBe(false);
  });
});

describe('brand scoring — channel length + formality', () => {
  it('flags content over the per-channel length cap', () => {
    const b = brand({
      channelVoiceRules: [{ channel: 'ad_variants', tone: 'punchy', maxLength: 20, samplePhrases: [], avoidPhrases: [] }],
    });
    const r = scoreComplianceDeterministic('This ad copy is definitely far too long for the cap.', b, { channel: 'ad_variants' });
    expect(r.issues.some((i) => i.category === 'length' && i.severity === 'error')).toBe(true);
    expect(r.deterministicScore).toBe(75); // 100 − 25 (length is the only rule tripped)
  });

  it('flags casual content against a formal brand voice', () => {
    const b = brand({ voiceProfile: { ...EMPTY_VOICE_PROFILE, formalityLevel: 5 } });
    const r = scoreComplianceDeterministic('Hey, this is gonna be totally awesome!', b);
    expect(r.issues.some((i) => i.category === 'formality')).toBe(true);
    // hey, gonna, totally, awesome = 4 markers × 6 = 24, capped at 20 → 80.
    expect(r.deterministicScore).toBe(80);
  });
});

describe('brand scoring — clean content', () => {
  it('scores 100 and passes for on-brand content with no rules tripped', () => {
    const b = brand();
    const r = scoreComplianceDeterministic('A clear, professional statement about the product.', b);
    expect(r.deterministicScore).toBe(100);
    expect(r.passesThreshold).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
});

describe('brand voice resolver', () => {
  it('renders formality, the channel rule, approved + banned phrases', () => {
    const b = brand({
      voiceProfile: { ...EMPTY_VOICE_PROFILE, voice: 'confident, not arrogant', formalityLevel: 4 },
      positioning: { ...EMPTY_POSITIONING, tagline: 'Pick faster.' },
      keyPhrases: { ...EMPTY_KEY_PHRASES, approvedTaglines: ['Pick faster.'], bannedPhrases: ['cheap'] },
      channelVoiceRules: [{ channel: 'social_posts', tone: 'conversational', maxLength: 280, samplePhrases: ['Ship it.'], avoidPhrases: [] }],
    });
    const out = resolveVoice(b, { channel: 'social_posts' });
    expect(out).toContain('confident, not arrogant');
    expect(out).toContain('Formality: 4/5');
    expect(out).toContain('social_posts');
    expect(out).toContain('Pick faster.');
    expect(out).toContain('NEVER use (banned): cheap');
    expect(out).toContain('280 characters');
  });

  it('applies a channel formality override over the base voice', () => {
    const b = brand({
      voiceProfile: { ...EMPTY_VOICE_PROFILE, formalityLevel: 5 },
      channelVoiceRules: [{ channel: 'social_posts', tone: 'casual', formalityOverride: 2, samplePhrases: [], avoidPhrases: [] }],
    });
    expect(resolveVoice(b, { channel: 'social_posts' })).toContain('Formality: 2/5');
  });
});
