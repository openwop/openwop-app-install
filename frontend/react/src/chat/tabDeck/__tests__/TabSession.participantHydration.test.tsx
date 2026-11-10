/** CHAT-LINEUP-RELOAD-1 / ADR 0140 correction 2026-11-08 (incident witness): a
 * reload dropped the saved Campaign Creative Director from the tab strip and
 * Members pane because the one-shot participant restore ran against the agent
 * catalog's loading []. Actual TabSession + useChatSession + useActiveAgents +
 * useAgentMentions + ConversationLineup + MembersPane. Only HTTP/stream clients
 * and unrelated composer/feed/decision UI boundaries are replaced. No duplicate
 * restore algorithm, membership mock or model call. No CSS/physical-geometry,
 * server membership mutation or dispatch claim here.
 *
 * Sabotage, each witnessed red (wave 97): restore no longer waiting for the
 * catalog to settle (case 1); `participants` dropped from the restore effect's
 * deps (cases 2, 4, 5); `restoreLineup` resetting the current voice (case 3) or
 * replacing the lineup instead of merging (cases 3, 4); the pending-removal set
 * ignored (case 5); a saved member synthesized from an unresolved id (case 9,
 * via the one-member count).
 * Double guard, witnessed as a held pair: case 6 is held by BOTH the one-shot
 * `lineupDerivedRef` in TabSession and the `seen` dedupe in `restoreLineup`;
 * either alone stays green, both removed reds it.
 * Not reachable here, recorded rather than claimed:
 * - `isHydrating` in the restore guard is doubled by useSessionPersistence
 *   keeping the current `activeAgents` when history lands (case 3 stays green
 *   without it; see the held pair in wave 97).
 * - `agentsError` is an equivalent mutant: useAgentMentions never retries in
 *   one mount, so a restore over the failed read's [] adds nothing (case 10).
 * - The in-instance session guards (`session.id !== sessionId`, the
 *   `s.id !== expectedSessionId` check, useAgentMentions' `cancelled` flag) are
 *   never reached: TabChatDeck keys each tab by sessionId, and so does `mount`,
 *   so a session change is a remount (cases 7, 8 are remount checks). */
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationViewProps } from '../../ConversationView.js';
import type { AgentEntry } from '../../../client/agentsClient.js';
import type { ChatMessagePage, ConversationParticipant } from '../../../client/chatSessionsClient.js';
import { listAgents } from '../../../client/agentsClient.js';
import { createChatSession, listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import { createRun } from '../../../client/runsClient.js';
import i18n from '../../../i18n/index.js';
import { TabSession, type TabSessionProps } from '../TabSession.js';

vi.mock('../../../client/agentsClient.js', () => ({ listAgents: vi.fn() }));
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(), appendChatMessage: vi.fn(), updateChatMessage: vi.fn(),
  listChatSessionMessagesPage: vi.fn(), getSessionFeedback: vi.fn(async () => ({})),
}));
vi.mock('../../../client/streamsClient.js', () => ({ subscribeToRun: () => ({ close: vi.fn() }) }));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(), cancelRun: vi.fn(), getRun: vi.fn(), pollEvents: vi.fn(), getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({ listOpenInterrupts: vi.fn(async () => []), resolveByRun: vi.fn() }));
// Feed/composer/provider configuration is outside initial member restoration.
// Expose only real history readiness, never a synthetic membership projection.
vi.mock('../../ConversationView.js', () => ({
  ConversationView: ({ isHydrating, messages }: ConversationViewProps) => <div>
    <output aria-label="History readiness">{isHydrating ? 'loading' : 'ready'}</output>
    {messages.map((m) => <p key={m.id}>{typeof m.content === 'string' ? m.content : 'attachment'}</p>)}
  </div>,
}));
vi.mock('../../hooks/useComposerModifiers.js', () => ({ useComposerModifiers: () => ({
  composerModifiers: null, modelSwitcher: null, getSubmitExtras: () => ({}), selectedModel: null,
}) }));
vi.mock('../../../byok/ConfiguredProviderCard.js', () => ({ ConfiguredProviderCard: () => null }));
vi.mock('../../decisions/useRecordDecision.js', () => ({ useRecordDecision: () => ({ onRecord: undefined, dialog: null }) }));
vi.mock('../../reviews/ConversationReviewsStrip.js', () => ({ ConversationReviewsStrip: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const DIRECTOR: AgentEntry = {
  agentId: 'vendor.openwop-app.campaign-studio.agents.creative-director',
  persona: 'Campaign Creative Director', label: 'Campaign Creative Director', description: 'Private creative direction.',
  modelClass: 'chat', packName: 'qa.campaign', packVersion: '1.0.0', toolAllowlist: [], hasHandoffSchemas: false,
};
const NORA: AgentEntry = { ...DIRECTOR, agentId: 'user.qa.nora', persona: 'Nora', label: 'QA adviser', description: 'A different adviser.' };
const participant = (agent: AgentEntry): ConversationParticipant => ({ subjectRef: `agent:${agent.agentId}`, role: 'member', addedAt: '2026-11-08T10:43:54Z' });
const OWNER: ConversationParticipant = { subjectRef: 'user:qa-owner', role: 'owner', addedAt: '2026-11-08T10:35:25Z' };
const SAVED = [OWNER, participant(DIRECTOR)];
const originalLanguage = i18n.language;
function history(sessionId: string): ChatMessagePage {
  return { messages: [{ messageId: `${sessionId}-m1`, sessionId, role: 'user', content: `Saved ${sessionId} message`, meta: null, createdAt: '2026-11-08T10:44:00Z' }], nextCursor: null };
}
const props: TabSessionProps = {
  sessionId: 'saved-a', config: { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free' },
  byokStored: false, participants: SAVED,
  onSessionIdChange: vi.fn(), onStreamingChange: vi.fn(), onActivity: vi.fn(), onReconfigureBYOK: vi.fn(),
  onOpenConversation: vi.fn(), refreshConversations: vi.fn(), onAddParticipant: vi.fn(), onRemoveParticipant: vi.fn(),
};
type Overrides = Omit<Partial<TabSessionProps>, 'participants'> & { participants?: readonly ConversationParticipant[] | undefined };
function mount(over: Overrides = {}, strict = false) {
  const tree = (p: Overrides) => {
    const { participants: savedParticipants, ...defaults } = props;
    const { participants, ...other } = p;
    const members = 'participants' in p ? participants : savedParticipants;
    const current: TabSessionProps = { ...defaults, ...other, ...(members === undefined ? {} : { participants: members }) };
    return <MemoryRouter>{strict
      ? <StrictMode><TabSession key={current.sessionId} {...current} /></StrictMode>
      : <TabSession key={current.sessionId} {...current} />}</MemoryRouter>;
  };
  const result = render(tree(over));
  return { ...result, rerenderTab: (p: Overrides) => result.rerender(tree(p)) };
}
const switchName = (persona: string) => i18n.t('chat:switchToPersona', { persona });
async function ready() { await waitFor(() => expect(screen.getByLabelText('History readiness')).toHaveTextContent('ready')); }
async function settleCatalog(d: ReturnType<typeof deferred<readonly AgentEntry[]>>, entries: readonly AgentEntry[]) {
  await act(async () => { d.resolve(entries); await d.promise; });
}
function noRunOrParticipantAdd() {
  expect(createRun).not.toHaveBeenCalled();
  expect(createChatSession).not.toHaveBeenCalled();
  expect(props.onAddParticipant).not.toHaveBeenCalled();
}
beforeEach(async () => {
  localStorage.clear(); vi.clearAllMocks(); vi.mocked(listAgents).mockReset(); await i18n.changeLanguage('en');
  vi.mocked(listChatSessionMessagesPage).mockImplementation(async (id) => history(id));
});
afterEach(async () => { cleanup(); await i18n.changeLanguage(originalLanguage); });

describe('TabSession initial persisted member restoration', () => {
  it('restores a saved director in both strip and Members when the catalog arrives last', async () => {
    const catalog = deferred<readonly AgentEntry[]>();
    vi.mocked(listAgents).mockReturnValue(catalog.promise);
    mount(); await ready();
    expect(screen.getByRole('button', { name: switchName('Assistant') })).toHaveAttribute('aria-pressed', 'true');
    await settleCatalog(catalog, [DIRECTOR, NORA]);
    expect(screen.getByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:membersToggleAria', { count: 2 }) }));
    const drawer = await screen.findByRole('complementary', { name: i18n.t('chat:inThisConversation') });
    expect(within(drawer).getByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    expect(within(drawer).getByRole('button', { name: switchName('Assistant') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('also restores when the catalog settles before the saved participants arrive', async () => {
    const catalog = deferred<readonly AgentEntry[]>();
    vi.mocked(listAgents).mockReturnValue(catalog.promise);
    const tab = mount({ participants: undefined }); await ready();
    await settleCatalog(catalog, [DIRECTOR, NORA]);
    expect(screen.queryByRole('button', { name: switchName('Campaign Creative Director') })).toBeNull();
    tab.rerenderTab({ participants: SAVED });
    expect(await screen.findByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    noRunOrParticipantAdd();
  });

  it('restores membership after a late history read without stealing the scoped adviser', async () => {
    const pendingHistory = deferred<ChatMessagePage>();
    vi.mocked(listChatSessionMessagesPage).mockReturnValue(pendingHistory.promise);
    vi.mocked(listAgents).mockResolvedValue([DIRECTOR, NORA]);
    mount({ scopeAgentId: NORA.agentId });
    const nora = await screen.findByRole('button', { name: switchName('Nora') });
    expect(nora).toHaveAttribute('aria-pressed', 'true');
    await act(async () => { pendingHistory.resolve(history('saved-a')); await pendingHistory.promise; });
    await ready();
    expect(screen.getByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    expect(screen.getByRole('button', { name: switchName('Nora') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('keeps a newer explicit switch to Assistant and the locally added adviser during late participant restore', async () => {
    vi.mocked(listAgents).mockResolvedValue([DIRECTOR, NORA]);
    const tab = mount({ participants: undefined, scopeAgentId: NORA.agentId }); await ready();
    await screen.findByRole('button', { name: switchName('Nora') });
    fireEvent.click(screen.getByRole('button', { name: switchName('Assistant') }));
    tab.rerenderTab({ participants: SAVED, scopeAgentId: NORA.agentId });
    expect(await screen.findByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    expect(screen.getByRole('button', { name: switchName('Nora') })).toBeVisible();
    expect(screen.getByRole('button', { name: switchName('Assistant') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('does not resurrect a member explicitly removed while saved participants were pending', async () => {
    vi.mocked(listAgents).mockResolvedValue([DIRECTOR, NORA]);
    const tab = mount({ participants: undefined, scopeAgentId: DIRECTOR.agentId }); await ready();
    await screen.findByRole('button', { name: switchName('Campaign Creative Director') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:removeFromConversation', { persona: 'Campaign Creative Director' }) }));
    expect(props.onRemoveParticipant).toHaveBeenCalledExactlyOnceWith('saved-a', `agent:${DIRECTOR.agentId}`);
    tab.rerenderTab({ participants: [OWNER, participant(DIRECTOR), participant(NORA)], scopeAgentId: DIRECTOR.agentId });
    expect(await screen.findByRole('button', { name: switchName('Nora') })).toBeVisible();
    expect(screen.queryByRole('button', { name: switchName('Campaign Creative Director') })).toBeNull();
    expect(screen.getByRole('button', { name: switchName('Assistant') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('does not reset a later user choice or duplicate members on repeated participant renders under StrictMode', async () => {
    vi.mocked(listAgents).mockResolvedValue([DIRECTOR, NORA]);
    const tab = mount({}, true); await ready();
    const director = await screen.findByRole('button', { name: switchName('Campaign Creative Director') });
    fireEvent.click(director);
    tab.rerenderTab({ participants: SAVED.map((p) => ({ ...p })) });
    expect(screen.getAllByRole('button', { name: switchName('Campaign Creative Director') })).toHaveLength(1);
    expect(screen.getByRole('button', { name: switchName('Campaign Creative Director') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('a remounted tab ignores the unmounted old tab\'s late catalog (remount check)', async () => {
    const oldCatalog = deferred<readonly AgentEntry[]>();
    const newCatalog = deferred<readonly AgentEntry[]>();
    vi.mocked(listAgents).mockReturnValueOnce(oldCatalog.promise).mockReturnValueOnce(newCatalog.promise);
    const tab = mount(); await ready();
    tab.rerenderTab({ sessionId: 'saved-b', participants: [OWNER, participant(NORA)] }); await ready();
    await settleCatalog(newCatalog, [DIRECTOR, NORA]);
    expect(screen.getByRole('button', { name: switchName('Nora') })).toBeVisible();
    await settleCatalog(oldCatalog, [DIRECTOR]);
    expect(screen.queryByRole('button', { name: switchName('Campaign Creative Director') })).toBeNull();
    expect(screen.getByText('Saved saved-b message')).toBeVisible();
    noRunOrParticipantAdd();
  });

  it('a remount on return restores from that session\'s own participants (remount check)', async () => {
    vi.mocked(listAgents).mockResolvedValue([DIRECTOR, NORA]);
    const tab = mount(); await ready();
    await screen.findByRole('button', { name: switchName('Campaign Creative Director') });
    tab.rerenderTab({ sessionId: 'saved-b', participants: [OWNER, participant(NORA)] }); await ready();
    await screen.findByRole('button', { name: switchName('Nora') });
    tab.rerenderTab({ sessionId: 'saved-a', participants: SAVED }); await ready();
    expect(await screen.findByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    expect(screen.queryByRole('button', { name: switchName('Nora') })).toBeNull();
    noRunOrParticipantAdd();
  });

  it('does not synthesize a saved member from a successfully empty catalog', async () => {
    const catalog = deferred<readonly AgentEntry[]>();
    vi.mocked(listAgents).mockReturnValue(catalog.promise);
    mount(); await ready(); await settleCatalog(catalog, []);
    expect(screen.queryByRole('button', { name: switchName('Campaign Creative Director') })).toBeNull();
    // Exactly one member (Assistant): a row synthesized from the bare agent id
    // would carry a different name, so count the lineup, not one persona.
    expect(screen.getByRole('button', { name: i18n.t('chat:membersToggleAria', { count: 1 }) })).toBeVisible();
    expect(screen.getByRole('button', { name: switchName('Assistant') })).toHaveAttribute('aria-pressed', 'true');
    noRunOrParticipantAdd();
  });

  it('a failed catalog shows no saved member, and an ordinary remount restores it', async () => {
    const failedCatalog = deferred<readonly AgentEntry[]>();
    vi.mocked(listAgents).mockReturnValueOnce(failedCatalog.promise).mockResolvedValue([DIRECTOR, NORA]);
    const tab = mount(); await ready();
    await act(async () => { failedCatalog.reject(new Error('catalog unavailable')); await failedCatalog.promise.catch(() => undefined); });
    expect(screen.queryByRole('button', { name: switchName('Campaign Creative Director') })).toBeNull();
    tab.unmount(); mount(); await ready();
    expect(await screen.findByRole('button', { name: switchName('Campaign Creative Director') })).toBeVisible();
    noRunOrParticipantAdd();
  });
});
