/**
 * ADR 0127 Phase 4 — WidgetsPage admin (list + embed snippet + grant editor), ADR 0469
 * Phase B/D. Breaks if Embed shows a snippet that does not carry the widget's real
 * token and embed.js URL, if a write grant does not default to HITL, if the save does
 * not send the chosen control/cap, or if a save leaves the editor open with a stale list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
const { listWidgets, listOrgs, getToolCatalog, patchWidget, toastSuccess } = vi.hoisted(() => ({ listWidgets: vi.fn(), listOrgs: vi.fn(), getToolCatalog: vi.fn(), patchWidget: vi.fn(), toastSuccess: vi.fn() }));
// Spread the REAL client: `embedSnippet` must be the product's own, or the snippet
// case asserts text this file wrote itself.
vi.mock('../../../client/chatWidgetClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/chatWidgetClient.js')>()),
  listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget: vi.fn(), rotateWidgetToken: vi.fn(), deleteWidget: vi.fn(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
import { WidgetsPage } from '../WidgetsPage.js';
import type { Widget } from '../../../client/chatWidgetClient.js';

const W: Widget = { widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true };

beforeEach(() => { listWidgets.mockReset(); listOrgs.mockReset(); getToolCatalog.mockReset(); patchWidget.mockReset(); toastSuccess.mockReset(); listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org' }]); getToolCatalog.mockResolvedValue(['openwop:kanban.add-todo', 'openwop:knowledge.search']); patchWidget.mockResolvedValue(W); });
afterEach(cleanup);

/** A save closes the editor (onSaved) and reloads the list — not merely "patch was called". */
const expectSavedAndReloaded = async (): Promise<void> => {
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save configuration' })).toBeNull());
  expect(listWidgets).toHaveBeenCalledTimes(2);
  expect(toastSuccess).toHaveBeenCalledTimes(1);
};

describe('WidgetsPage (ADR 0127 Phase 4)', () => {
  // NO TOGGLE MOCK, because the page does not import `useFeatureAccess`.
  // CORRECTED (wave 26): this used to say `chat-widget` has no toggle (ADR 0134).
  // That is stale — ADR 0820 §8.2 restored a per-tenant `toggleDefault` in
  // `backend/…/chat-widget/feature.ts`, enforced server-side on the operator routes
  // (`authorizeOrgScope`). The PAGE still reads no toggle, so mocking the hook here
  // would be scenery: a mock of a module the subject never imports.

  it('lists widgets + reveals the embed snippet on Embed', async () => {
    listWidgets.mockResolvedValue([W]);
    render(<WidgetsPage />);
    expect(await screen.findByText('support')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    // The real snippet: the public embed.js URL carrying THIS widget's token.
    expect(await screen.findByText(/\/host\/openwop-app\/public\/widget\/embed\.js" data-token="wgt_abc"/)).toBeTruthy();
  });

  it('Configure opens the grant editor, loads the catalog, defaults writes to HITL, and saves', async () => {
    listWidgets.mockResolvedValue([W]);
    render(<WidgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    // Catalog renders both tools with read + write checkboxes.
    expect(await screen.findByText('openwop:kanban.add-todo')).toBeTruthy();
    expect(getToolCatalog).toHaveBeenCalledWith('o1');
    // Grant a write tool → the control defaults to HITL (the safe default).
    fireEvent.click(screen.getByLabelText('Allow anonymous write via openwop:kanban.add-todo (held for approval)'));
    expect(await screen.findByText(/held in your approval inbox/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(patchWidget).toHaveBeenCalledWith('o1', 'w1', expect.objectContaining({
      anonToolGrant: expect.objectContaining({ write: ['openwop:kanban.add-todo'], writeControl: 'hitl' }),
    }));
    await expectSavedAndReloaded();
  });

  it('ADR 0469 Phase D — choosing auto-run reveals the per-session cap and saves rate-limit-session-cap', async () => {
    listWidgets.mockResolvedValue([W]);
    render(<WidgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    await screen.findByText('openwop:kanban.add-todo');
    fireEvent.click(screen.getByLabelText('Allow anonymous write via openwop:kanban.add-todo (held for approval)'));
    // Select the auto-run control → the per-session cap field + the auto note appear.
    fireEvent.click(await screen.findByRole('radio', { name: /Auto-run under a per-session cap/i }));
    fireEvent.change(screen.getByLabelText('Auto-runs per session'), { target: { value: '3' } });
    expect(screen.getByText(/run automatically \(no approval\)/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(patchWidget).toHaveBeenCalledWith('o1', 'w1', expect.objectContaining({
      anonToolGrant: expect.objectContaining({ writeControl: 'rate-limit-session-cap' }),
      caps: expect.objectContaining({ maxAutoWritesPerSession: 3 }),
    }));
    await expectSavedAndReloaded();
  });
});
