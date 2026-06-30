import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
vi.mock('../../../client/scheduledChatsClient.js', () => ({ listOrgs: vi.fn(), listScheduledChats: vi.fn(), deleteScheduledChat: vi.fn() }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => ({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }) }));
import { listOrgs, listScheduledChats, type ScheduledChat } from '../../../client/scheduledChatsClient.js';
import { ScheduledChatsPage } from '../ScheduledChatsPage.js';
const mockOrgs = vi.mocked(listOrgs); const mockList = vi.mocked(listScheduledChats);
const c = (chatId: string, over: Partial<ScheduledChat> = {}): ScheduledChat => ({ chatId, agentId: 'iris', prompt: 'p', conversationId: 'cv', cronExpr: '0 9 * * *', enabled: true, ...over });
beforeEach(() => { enabled = true; mockOrgs.mockReset(); mockList.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);
describe('ScheduledChatsPage (ADR 0125 Phase 3b)', () => {
  it('renders scheduled chats with active/inert status', async () => {
    mockList.mockResolvedValue([c('a', { workflowId: 'wf' }), c('b')]);
    render(<ScheduledChatsPage />);
    expect((await screen.findAllByText('iris')).length).toBe(2);
    expect(screen.getByText('Active')).toBeTruthy();   // has workflowId
    expect(screen.getByText('Inert')).toBeTruthy();     // no workflowId
  });
  it('shows the empty state', async () => {
    mockList.mockResolvedValue([]);
    render(<ScheduledChatsPage />);
    expect(await screen.findByText('No scheduled chats yet.')).toBeTruthy();
  });
  // (The "disabled → no fetch" test was removed: scheduled-chats graduated to always-on in
  // the ADR 0134 toggle graduation, so the component hardcodes access.enabled = true.)
});
