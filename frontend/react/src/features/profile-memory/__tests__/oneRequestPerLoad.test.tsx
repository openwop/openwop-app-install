/**
 * F5 (review of ADR 0587, MEM-UX-1) — the memory tabs must read the list ONCE.
 *
 * WHAT WENT WRONG. The routes were changed, in the same change set, to return
 * `{ notes, recallOnlyCount }` in ONE response. Both clients then discarded
 * `recallOnlyCount` and re-fetched the IDENTICAL URL from a second effect purely
 * to read it back. Two costs, and only one of them is about speed:
 *
 *   - every extra call re-runs `countRecallOnlyEntries` server-side, which is a
 *     full `listMemoryEntries` scan, against the per-IP read budget CLAUDE.md
 *     warns about by name ("batch reads; don't N+1");
 *   - the two responses can DISAGREE, so the tab could disclose "N more the
 *     assistant recalls" computed over a list the user is not looking at.
 *
 * WHY A TEST AND NOT JUST THE FIX. Nothing about the collapsed version is
 * self-evident from reading the components — a future effect that "just needs the
 * count" reintroduces it silently, exactly as it arrived. So this counts CALLS at
 * the fetch boundary, which is the only place the duplication was ever visible.
 *
 * The count is asserted as an EXACT equality, not a ceiling: `toBeLessThan(2)`
 * would also pass if the read stopped happening at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileMemoryTab } from '../ProfileMemoryTab.js';
import { AgentMemoryTab } from '../../agent-knowledge/AgentMemoryTab.js';

// The consent control + the agent's writable flag are separate endpoints with
// their own reads; this file is only about the MEMORY LIST url, so they are
// stubbed out rather than counted.
vi.mock('../memoryExtractionClient.js', () => ({
  getExtractionGrant: vi.fn(async () => null),
  setExtractionGrant: vi.fn(),
}));

const LIST_URLS: string[] = [];

beforeEach(() => {
  LIST_URLS.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/memory(\/notes)?$|\/notes$/.test(url.split('?')[0]!)) LIST_URLS.push(url);
      return new Response(JSON.stringify({ notes: [], recallOnlyCount: 3, memoryWritable: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('F5 — one request per memory-list load', () => {
  it('ProfileMemoryTab reads the list URL exactly once on mount', async () => {
    render(<ProfileMemoryTab />);
    // Settle: the empty state renders only after the list read resolves, so this
    // is the point at which any second read would already have been issued.
    expect(await screen.findByText(/No memories yet/i)).toBeTruthy();
    expect(LIST_URLS, `list URLs hit: ${JSON.stringify(LIST_URLS)}`).toHaveLength(1);
  });

  it('AgentMemoryTab reads the notes URL exactly once on mount', async () => {
    render(<AgentMemoryTab rosterId="host:some-agent" persona="Ada" />);
    expect(await screen.findByText(/remembers nothing yet|No memories yet/i)).toBeTruthy();
    expect(LIST_URLS, `list URLs hit: ${JSON.stringify(LIST_URLS)}`).toHaveLength(1);
  });

  it('NON-VACUITY: the disclosure the second request existed for is still rendered', async () => {
    // Without this, both assertions above would also pass if the count had simply
    // stopped being read — "one request" is only the right answer when that one
    // request still carries the value the second one went back for.
    render(<ProfileMemoryTab />);
    expect(await screen.findByText(/3/)).toBeTruthy();
  });
});
