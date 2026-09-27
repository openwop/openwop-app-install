/**
 * ATU-1 — the auto-title swap ANNOUNCES the rename to assistive tech (polite), carrying
 * the new title. Born red: the hook used to call `setSession` alone, so a screen-reader
 * user never heard the rail/tab title change under them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyAutoTitle } from '../lib/applyAutoTitle.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';
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
    expect(a.polite).toContain('Refactor Auth');
    expect(a.assertive).toBe('');
  });
  it('WIRING: the transport hook routes the titled event through this helper (not a bare setSession)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'hooks', 'chatSession', 'useTurnTransport.ts'), 'utf8');
    const branch = src.slice(src.indexOf('titledFromEvent(ev'), src.indexOf('titledFromEvent(ev') + 200);
    expect(branch).toContain('applyAutoTitle(autoTitle, setSession)');
    expect(branch).not.toContain("setSession((s) => ({ ...s, title: autoTitle }))");
  });
});
