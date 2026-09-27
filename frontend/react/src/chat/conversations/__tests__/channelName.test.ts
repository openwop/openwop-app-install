/**
 * ADR 0192 D4 — the create dialog's live name preview must mirror the backend
 * channel-name policy exactly (channelService.cleanName), or the preview lies.
 */
import { describe, it, expect } from 'vitest';
import { normalizeChannelName } from '../channelName.js';
import { initials } from '../../../ui/Avatar.js';

describe('normalizeChannelName (mirrors backend cleanName)', () => {
  it('lowercases, dashes whitespace, strips invalid chars, trims leading separators', () => {
    expect(normalizeChannelName('  War Room! 2026  ')).toBe('war-room-2026');
    expect(normalizeChannelName('Ops OnCall')).toBe('ops-oncall');
    expect(normalizeChannelName('team.eng')).toBe('team.eng'); // dots survive
    expect(normalizeChannelName('ops_oncall')).toBe('ops_oncall'); // underscores survive
    expect(normalizeChannelName('--weird--   name--')).toBe('weird-name-');
    expect(normalizeChannelName('###')).toBe('');
  });
  it('caps at 80 chars', () => {
    expect(normalizeChannelName('x'.repeat(120))).toHaveLength(80);
  });
});

describe('ui/Avatar initials', () => {
  it('two-word names use first letters; a single token uses its first letter (AgentAvatar-preserved behavior)', () => {
    expect(initials('Dana Wong')).toBe('DW');
    expect(initials('dana')).toBe('D');
    expect(initials('Code Reviewer')).toBe('CR');
  });
});
