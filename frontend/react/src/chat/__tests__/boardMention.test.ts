/**
 * Board-of-Advisors `@@<handle>` summon (ADR 0040) — mention detection. `@@`
 * convenes a board (distinct from a single `@agent`). (The model-input `@@`-strip
 * lived in the per-turn `composeProviderMessages`, retired with the per-turn
 * transport in ADR 0067 Phase 6; the conversation path handles routing server-side.)
 */
import { describe, it, expect } from 'vitest';
import { detectBoardMention } from '../lib/agentMentions.js';

describe('detectBoardMention', () => {
  it('matches `@@<handle>` and captures the trailing question', () => {
    expect(detectBoardMention('@@timeless what should we prioritize?')).toEqual({ handle: 'timeless', trailing: 'what should we prioritize?' });
  });
  it('matches a bare `@@<handle>` with no trailing text', () => {
    expect(detectBoardMention('@@founders')).toEqual({ handle: 'founders', trailing: null });
  });
  it('does NOT match a single `@<agent>` mention', () => {
    expect(detectBoardMention('@elon-trask hi')).toBeNull();
  });
  it('returns null when there is no board summon', () => {
    expect(detectBoardMention('just a normal message')).toBeNull();
  });
});
