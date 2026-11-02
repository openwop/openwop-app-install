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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyAutoTitle } from '../lib/applyAutoTitle.js';
import { CHAT_SESSIONS_CHANNEL } from '../lib/sessionBroadcast.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';
import { messages as chatEn } from '../i18n/en.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

beforeEach(() => { announce('', { assertive: true }); announce(''); });

describe('applyAutoTitle (ATU-1 / ADR 1019 D4)', () => {
  it('swaps the session title AND announces it politely with the title text', () => {
    let session = { id: 's1', title: 'refactor auth please' };
    // Explicit type argument: S cannot be inferred from an updater-taking callback.
    applyAutoTitle<typeof session>('Refactor Auth', (u) => { session = u(session); }, 's1', true);
    expect(session.title).toBe('Refactor Auth');
    const a = currentAnnouncements();
    // The whole polite message (an invisible repeat-mark may trail it), carrying the title.
    expect(a.polite.replace(/\u200b$/, '')).toBe(chatEn.conversationRenamed.replace('{{title}}', 'Refactor Auth'));
    expect(a.assertive).toBe('');
  });
  it('never retitles, nor announces, a chat the person has switched away from', () => {
    let session = { id: 'other', title: 'Other chat' };
    applyAutoTitle<typeof session>('Refactor Auth', (u) => { session = u(session); }, 's1', false);
    expect(session.title).toBe('Other chat');
    expect(currentAnnouncements().polite).toBe('');
  });
  it('tells every session list to refetch the header (rail + tab labels, this tab and others)', async () => {
    const heard: unknown[] = [];
    const listener = new BroadcastChannel(CHAT_SESSIONS_CHANNEL);
    listener.onmessage = (e: MessageEvent) => { heard.push(e.data); };
    try {
      applyAutoTitle<{ id: string; title: string }>('Refactor Auth', () => {}, 's1', true);
      await vi.waitFor(() => expect(heard).toEqual([{ kind: 'session:renamed', sessionId: 's1' }]));
    } finally { listener.close(); }
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
    expect(branch).toMatch(/applyTitleOnce\(\s*autoTitle\s*,\s*titleSessionId\s*\)/);
    expect(branch).not.toMatch(/setSession\s*\(/);
    // …and the once-guard lands through the helper, with the chat's id.
    const once = src.slice(src.indexOf('const applyTitleOnce'), src.indexOf('}, [setSession]);', src.indexOf('const applyTitleOnce')));
    expect(once).toMatch(/applyAutoTitle\(\s*title\s*,\s*setSession\s*,\s*sessionId\s*,\s*sessionRef\.current\.id\s*===\s*sessionId\s*\)/);
    // ADR 1019 D4 — the header follow starts only after a chat's FIRST exchange, only
    // for a persisted chat, only with the toggle on, and lands through the once-guard.
    const follow = src.slice(src.indexOf('followAutoTitle(titleSessionId') - 400, src.indexOf('followAutoTitle(titleSessionId') + 120);
    expect(follow).toMatch(/if \(firstOfChat && persist && autotitleOnRef\.current/);
    expect(follow).toMatch(/followAutoTitle\(titleSessionId,\s*\(t\)\s*=>\s*applyTitleOnce\(t,\s*titleSessionId\)\)/);
  });
});
