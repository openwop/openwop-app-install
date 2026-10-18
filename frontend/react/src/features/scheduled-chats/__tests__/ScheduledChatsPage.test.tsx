/**
 * ScheduledChatsPage (ADR 0125 Phase 3b) — the admin list of recurring agent chats.
 *
 * Guards: (1) each row's status is the REAL scheduler state — a paused chat reads
 * Paused even with a turn-workflow wired; an enabled chat with a workflow reads
 * Active; an enabled chat without one reads Inert — asserted PER ROW, because a
 * page-wide "one Active, one Inert" also passes with the labels swapped between rows
 * (grade-tests w53 probe `sch-active-inert-swap` was vacuous until the rows were
 * told apart); (2) the Pause/Resume affordance follows `enabled`; (3) the empty
 * state; (4) the feature-toggle UNRESOLVED state is a skeleton under the header, not
 * the terminal "off" card, and nothing is read until it resolves (#2978 — the old
 * four-field access mock hid that branch; `makeFeatureAccess` is typed as the hook's
 * return); (5) RESOLVED off still renders the off card. No "disabled → no fetch"
 * case: scheduled-chats graduated to always-on (ADR 0134).
 *
 * Breaks it: swapping the Active/Inert ternary, dropping `!r.enabled` precedence,
 * hard-coding the Pause/Resume label, deleting the `access.loading` branch, or
 * passing `true` instead of `access.enabled` to `useOrgSelection`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../client/scheduledChatsClient.js', () => ({ listOrgs: vi.fn(), listScheduledChats: vi.fn(), deleteScheduledChat: vi.fn(), setScheduledChatEnabled: vi.fn() }));
let enabled = true;
let loading = false;
// The real hook returns SEVEN fields. This mock returned four, and the three it
// omitted included `loading` — so the page's MISSING `access.loading` branch was
// unfalsifiable here: `undefined` is exactly the value that branch would have
// skipped. The shared factory is typed as the hook's own return type, so a field
// can no longer go missing by silence.
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled, status: enabled ? 'on' : 'off', loading }),
}));
import { listOrgs, listScheduledChats, type ScheduledChat } from '../../../client/scheduledChatsClient.js';
import { ScheduledChatsPage } from '../ScheduledChatsPage.js';
const mockOrgs = vi.mocked(listOrgs); const mockList = vi.mocked(listScheduledChats);
/** The table row that shows `agentId` (each fixture row has its own agent). */
const rowOf = (agentId: string): HTMLElement => {
  const row = screen.getByText(agentId).closest('tr');
  if (!row) throw new Error(`no table row for ${agentId}`);
  return row;
};
const c = (chatId: string, over: Partial<ScheduledChat> = {}): ScheduledChat => ({ chatId, agentId: 'iris', prompt: 'p', conversationId: 'cv', cronExpr: '0 9 * * *', enabled: true, ...over });
beforeEach(() => { enabled = true; loading = false; mockOrgs.mockReset(); mockList.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);
describe('ScheduledChatsPage (ADR 0125 Phase 3b)', () => {
  it('renders scheduled chats with active/inert status', async () => {
    mockList.mockResolvedValue([c('a', { agentId: 'iris', workflowId: 'wf' }), c('b', { agentId: 'atlas' })]);
    render(<ScheduledChatsPage />);
    await screen.findByText('iris');
    // Per row: enabled + workflowId → Active; enabled, no workflowId → Inert.
    expect(within(rowOf('iris')).getByText('Active')).toBeTruthy();
    expect(within(rowOf('iris')).queryByText('Inert')).toBeNull();
    expect(within(rowOf('atlas')).getByText('Inert')).toBeTruthy();
    expect(within(rowOf('atlas')).queryByText('Active')).toBeNull();
  });

  it('renders the REAL enabled state: a disabled chat reads Paused and offers Resume', async () => {
    mockList.mockResolvedValue([c('a', { workflowId: 'wf', enabled: false })]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('Paused')).toBeTruthy();       // enabled:false wins over workflowId
    expect(screen.queryByText('Active')).toBeNull();               // ...so the wired workflow does not read Active
    expect(screen.getByText('Resume')).toBeTruthy();               // paused → resume affordance
    expect(screen.queryByText('Pause')).toBeNull();
  });

  it('offers a Pause control on an active chat', async () => {
    mockList.mockResolvedValue([c('a', { workflowId: 'wf' })]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('Pause')).toBeTruthy();
  });
  it('shows the empty state', async () => {
    mockList.mockResolvedValue([]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('No scheduled chats yet.')).toBeTruthy();
  });
  // (The "disabled → no fetch" test was removed: scheduled-chats graduated to always-on in
  // the ADR 0134 toggle graduation, so the component hardcodes access.enabled = true.)

  /**
   * The toggle-UNRESOLVED state, which this page had no branch for at all.
   *
   * `useFeatureAccess` answers with the resolver's FALLBACK (`status: 'off',
   * enabled: false`) until the assignments land, so for the whole first paint
   * this page rendered "Scheduled chats are not available" — a terminal answer
   * about a question nobody had answered yet — and then silently swapped it for
   * the real page. Five sibling pages had this fixed; this one was missed, and
   * its four-field mock could not have caught it either way.
   */
  it('toggle UNRESOLVED is a skeleton under the real header — not the not-available card', async () => {
    loading = true;
    enabled = false; // the fallback the resolver really answers with while loading
    mockList.mockResolvedValue([]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeTruthy();
    // The terminal claim must be absent — that is the defect.
    expect(screen.queryByText('Scheduled chats are off for this workspace.')).toBeNull();
    // The header survives: the whole point of not using a title-only StateCard.
    expect(screen.getByText('Scheduled chats')).toBeTruthy();
    // And nothing is read while the answer is unknown.
    expect(mockOrgs).not.toHaveBeenCalled();
  });

  it('toggle RESOLVED off still renders the not-available card', async () => {
    // The positive control for the branch above: without it, that assertion
    // would also pass if the card had simply been deleted.
    enabled = false;
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('Scheduled chats are off for this workspace.')).toBeTruthy();
    expect(mockOrgs).not.toHaveBeenCalled();
  });
});
