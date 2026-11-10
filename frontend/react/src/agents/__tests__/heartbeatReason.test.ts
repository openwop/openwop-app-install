/**
 * ADR 0963 — the Check-now notice used to interpolate the raw server code
 * ("found no eligible To Do tasks (no_working_lane)"). Every code the server
 * names must read as a sentence, and an unknown one falls back.
 *
 * `CODES` is checked against the backend's `HeartbeatResult['reason']` union, read
 * from its source, so a code the server gains reds here.
 *
 * Sabotage (witnessed): dropping a case, crossing two codes' sentences, deleting a
 * catalog key, returning the code as the fallback, and adding a server code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // Its OWN sentence: a crossed mapping still reads as words.
    expect(text).toBe(i18n.t(`agents:heartbeatReason_${code}`));
  });

  it('every code the server names is listed here', () => {
    const source = readFileSync(join(process.cwd(), '../../backend/typescript/src/host/heartbeatService.ts'), 'utf8');
    const start = source.indexOf('export interface HeartbeatResult {');
    const union = source.slice(source.indexOf('reason?:', start), source.indexOf('boardId?:', start));
    const named = [...union.matchAll(/^\s*\| '([a-z_]+)'/gm)].map((m) => m[1]!);
    expect([...named].sort()).toEqual([...CODES].sort());
  });

  it('an unknown or absent code falls back', () => {
    expect(heartbeatReasonText(i18n.t, 'something_new', 'idle')).toBe('idle');
    expect(heartbeatReasonText(i18n.t, undefined, 'idle')).toBe('idle');
  });
});
