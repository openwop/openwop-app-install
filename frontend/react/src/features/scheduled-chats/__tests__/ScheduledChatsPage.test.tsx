import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
const c = (chatId: string, over: Partial<ScheduledChat> = {}): ScheduledChat => ({ chatId, agentId: 'iris', prompt: 'p', conversationId: 'cv', cronExpr: '0 9 * * *', enabled: true, ...over });
beforeEach(() => { enabled = true; loading = false; mockOrgs.mockReset(); mockList.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);
describe('ScheduledChatsPage (ADR 0125 Phase 3b)', () => {
  it('renders scheduled chats with active/inert status', async () => {
    mockList.mockResolvedValue([c('a', { workflowId: 'wf' }), c('b')]);
    render(<ScheduledChatsPage />);
    expect((await screen.findAllByText('iris')).length).toBe(2);
    expect(screen.getByText('Active')).toBeTruthy();   // enabled + workflowId
    expect(screen.getByText('Inert')).toBeTruthy();     // enabled, no workflowId
  });

  it('renders the REAL enabled state: a disabled chat reads Paused and offers Resume', async () => {
    mockList.mockResolvedValue([c('a', { workflowId: 'wf', enabled: false })]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('Paused')).toBeTruthy();       // enabled:false wins over workflowId
    expect(screen.getByText('Resume')).toBeTruthy();               // paused → resume affordance
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
