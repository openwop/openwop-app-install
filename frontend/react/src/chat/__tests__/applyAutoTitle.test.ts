/**
 * ATU-1 — the auto-title swap ANNOUNCES the rename to assistive tech (polite), carrying
 * the new title. Born red: the hook used to call `setSession` alone, so a screen-reader
 * user never heard the rail/tab title change under them.
 *
 * Sabotage: announce assertively / drop the swap → the helper case reds; route the titled
 * event through a bare `setSession(...)` (any spelling, even with the helper call left in a
 * comment) → the WIRING case reds. Ceiling: the wiring leg reads the hook's SOURCE — driving
 * `useTurnTransport`'s SSE loop end to end costs far more than the one-line claim.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyAutoTitle } from '../lib/applyAutoTitle.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';
import { messages as chatEn } from '../i18n/en.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

beforeEach(() => { announce('', { assertive: true }); announce(''); });

describe('applyAutoTitle (ATU-1)', () => {
  it('swaps the session title AND announces it politely with the title text', () => {
    let session = { id: 's1', title: 'refactor auth please' };
    // Explicit type argument: S cannot be inferred from an updater-taking callback, and
    // the inferred `{title}` would not be assignable back to a session that also has `id`.
    applyAutoTitle<typeof session>('Refactor Auth', (u) => { session = u(session); });
    expect(session.title).toBe('Refactor Auth');
    const a = currentAnnouncements();
    // The whole polite message (an invisible repeat-mark may trail it), carrying the title.
    expect(a.polite.replace(/\u200b$/, '')).toBe(chatEn.conversationRenamed.replace('{{title}}', 'Refactor Auth'));
    expect(a.assertive).toBe('');
  });
  it('WIRING: the transport hook routes the titled event through this helper (not a bare setSession)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Comments stripped, so a helper call left in a comment cannot satisfy the match.
    const src = readFileSync(join(here, '..', 'hooks', 'chatSession', 'useTurnTransport.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const at = src.indexOf('titledFromEvent(ev');
    expect(at, 'the titled-event branch must exist').toBeGreaterThan(-1);
    // The branch: from the titled-event read to the next statement after its `if`.
    const branch = src.slice(at, src.indexOf('exchangeSettleSignal(ev', at));
    expect(branch).toMatch(/applyAutoTitle\(\s*autoTitle\s*,\s*setSession\s*\)/);
    // No direct session write in the branch (the helper call contains `setSession)`, never `setSession(`).
    expect(branch).not.toMatch(/setSession\s*\(/);
  });
});
