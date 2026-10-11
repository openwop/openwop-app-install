/**
 * KB2UX-3 — a failed agent-knowledge write reaches the user as words in their
 * language, never as the server's English or a wire diagnostic.
 *
 * ADR 0830 D4 made a MANAGED collection (an advisor's Strategy KB, bound by the
 * advisory-board reconciler) refuse writes from this panel. The panel still
 * offers "Add document" on it — the bound-collection view carries no `managed`
 * flag (backend residue) — so the refusal is the user's first signal, and it
 * used to render verbatim: "This collection is managed (synced from strategy);
 * edit the source instead." The two DELETE paths rendered `unbindCollection
 * returned 403`.
 *
 * Sabotage that turns this red (grade-tests w11 probes): dropping the `managed` branch of
 * `knowledgeErrorMessage` (case 1); rendering `err.message` instead of the status mapping
 * (case 2); not setting the success notice, or setting an error on success (case 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getAgentKnowledge: vi.fn(),
  listOrgs: vi.fn(),
  ingestText: vi.fn(),
  unbindCollection: vi.fn(),
}));
vi.mock('../agentKnowledgeClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../agentKnowledgeClient.js')>();
  return { ...orig, ...api };
});
const confirmMock = vi.hoisted(() => vi.fn(async (_opts: { title?: string }) => true));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));

import { AgentKnowledgePanel } from '../AgentKnowledgePanel.js';
import { AgentKnowledgeRequestError, type AgentKnowledgeView } from '../agentKnowledgeClient.js';

const MANAGED_EN = 'This collection is managed (synced from strategy); edit the source instead.';
const VIEW: AgentKnowledgeView = {
  agentId: 'a1', knowledgeEnabled: true, memoryWritable: false, noteCount: 0,
  collections: [{ collectionId: 'mgd-strategy-o1', orgId: 'o1', name: 'Strategy', documentCount: 0, chunkCount: 0, documents: [] }],
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getAgentKnowledge.mockResolvedValue(VIEW);
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = async (): Promise<void> => {
  render(<AgentKnowledgePanel rosterId="a1" persona="Iris" />);
  await screen.findByText('Strategy');
};

describe('KB2UX-3 — agent-knowledge failures are localized sentences', () => {
  it('a MANAGED refusal says the collection is synced elsewhere — not the server English', async () => {
    api.ingestText.mockRejectedValue(new AgentKnowledgeRequestError(MANAGED_EN, 400, 'strategy'));
    await view();
    fireEvent.change(screen.getByLabelText('Document text'), { target: { value: 'Q4 goals' } });
    fireEvent.click(screen.getByRole('button', { name: /Add document/ }));
    expect(await screen.findByText(/kept in sync by another feature/)).toBeTruthy();
    expect(screen.queryByText(MANAGED_EN)).toBeNull();
  });

  it('a 403 on a no-content DELETE reads as the localized permission sentence, not `… returned 403`', async () => {
    api.unbindCollection.mockRejectedValue(new AgentKnowledgeRequestError('unbindCollection returned 403', 403));
    await view();
    fireEvent.click(screen.getByRole('button', { name: /Unbind|Remove/ }));
    await waitFor(() => expect(api.unbindCollection).toHaveBeenCalled());
    expect(await screen.findByText(/don't have permission/)).toBeTruthy();
    expect(screen.queryByText(/returned 403/)).toBeNull();
  });

  it('positive control: a successful ingest shows the success notice and no error', async () => {
    api.ingestText.mockResolvedValue({});
    await view();
    fireEvent.change(screen.getByLabelText('Document text'), { target: { value: 'Q4 goals' } });
    fireEvent.click(screen.getByRole('button', { name: /Add document/ }));
    await waitFor(() => expect(api.getAgentKnowledge).toHaveBeenCalledTimes(2));
    // The notice it is titled for — this case used to stop at "no error", so dropping the
    // success notice entirely left it green (grade-tests w11).
    expect(await screen.findByText('Document ingested.')).toBeTruthy();
    expect(screen.queryByText(/kept in sync by another feature/)).toBeNull();
  });
});
