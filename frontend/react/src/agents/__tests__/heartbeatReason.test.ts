/**
 * ADR 0963 — the Check-now notice used to interpolate the raw server code
 * ("found no eligible To Do tasks (no_working_lane)"). Every code the server
 * names must read as a sentence, and an unknown one falls back.
 */
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.js';
import { heartbeatReasonText } from '../heartbeatReason.js';

const CODES = [
  'paused', 'no_boards', 'empty_board', 'no_runnable_workflow', 'policy_denied',
  'awaiting_approval', 'held', 'mock_archive', 'no_working_lane', 'no_eligible_tasks',
];

describe('heartbeatReasonText', () => {
  it.each(CODES)('%s reads as words, never the code', (code) => {
    const text = heartbeatReasonText(i18n.t, code, 'FALLBACK');
    expect(text).not.toBe('FALLBACK');
    expect(text).not.toContain('_');
    expect(text).not.toContain('heartbeatReason');
  });

  it('an unknown or absent code falls back', () => {
    expect(heartbeatReasonText(i18n.t, 'something_new', 'idle')).toBe('idle');
    expect(heartbeatReasonText(i18n.t, undefined, 'idle')).toBe('idle');
  });
});
