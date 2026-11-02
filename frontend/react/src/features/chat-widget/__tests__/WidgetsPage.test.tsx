/**
 * ADR 0127 Phase 4 — WidgetsPage admin (list + embed snippet + grant editor), ADR 0469
 * Phase B/D. Breaks if Embed shows a snippet that does not carry the widget's real
 * token and embed.js URL, if a write grant does not default to HITL, if the save does
 * not send the chosen control/cap, or if a save leaves the editor open with a stale list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
const { listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget, toastSuccess } = vi.hoisted(() => ({ listWidgets: vi.fn(), listOrgs: vi.fn(), getToolCatalog: vi.fn(), patchWidget: vi.fn(), provisionWidget: vi.fn(), toastSuccess: vi.fn() }));
// Spread the REAL client: `embedSnippet` must be the product's own, or the snippet
// case asserts text this file wrote itself.
vi.mock('../../../client/chatWidgetClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/chatWidgetClient.js')>()),
  listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget, rotateWidgetToken: vi.fn(), deleteWidget: vi.fn(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
// ADR 1018 — the page now offers a roster picker (listAgents) and a "try in chat" deep
// link (useNavigate), so it renders inside a router with the roster read stubbed.
const { listAgents, confirmMock } = vi.hoisted(() => ({ listAgents: vi.fn(), confirmMock: vi.fn() }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));
vi.mock('../../../client/agentsClient.js', () => ({ listAgents }));
import { MemoryRouter } from 'react-router-dom';
import { WidgetsPage } from '../WidgetsPage.js';
import type { Widget } from '../../../client/chatWidgetClient.js';

const W: Widget = { widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true };

beforeEach(() => { confirmMock.mockReset(); listWidgets.mockReset(); listOrgs.mockReset(); getToolCatalog.mockReset(); patchWidget.mockReset(); provisionWidget.mockReset(); toastSuccess.mockReset(); listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org' }]); listAgents.mockReset(); listAgents.mockResolvedValue([]); getToolCatalog.mockResolvedValue(['openwop:kanban.add-todo', 'openwop:knowledge.search']); patchWidget.mockResolvedValue(W); });
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
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    expect(await screen.findByText('support')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    // The real snippet: an ABSOLUTE public embed.js URL carrying THIS widget's token.
    // ADR 1018 D1 — anchored on `src="http`: the unanchored path match this used to
    // be passed the production snippet, whose relative `/api/…` src 404s on every
    // customer site (`CW68WF-1`).
    expect(await screen.findByText(/^<script src="https?:\/\/[^"/]+\/[^"]*host\/openwop-app\/public\/widget\/embed\.js" data-token="wgt_abc"><\/script>$/)).toBeTruthy();
  });

  it('Configure opens the grant editor, loads the catalog, defaults writes to HITL, and saves', async () => {
    listWidgets.mockResolvedValue([W]);
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
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
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
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

  // grade-ux CW68U-2 / CW68U-8 — the agent is picked from the roster (a typo used to make
  // a widget that reported Active and never answered), and a disabled widget says so in
  // words and can be turned back on.
  it('offers the roster as a picker and re-enables a disabled widget', async () => {
    listAgents.mockResolvedValue([{ agentId: 'vendor.x.agents.support', label: 'Support agent' }]);
    listWidgets.mockResolvedValue([{ ...W, enabled: false }]);
    patchWidget.mockResolvedValue({ ...W, enabled: true });
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'Support agent' })).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await vi.waitFor(() => expect(patchWidget).toHaveBeenCalledWith('o1', 'w1', { enabled: true }));
  });

  // grade-ux CW68U-17 / CW68U-16 — turning a live widget off is confirmed; a refused
  // enable (its agent is gone) says why in the user's language.
  it('confirms before Disable, and explains a refused Enable', async () => {
    listWidgets.mockResolvedValue([W]);
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(patchWidget).not.toHaveBeenCalled();

    cleanup();
    const { WidgetApiError } = await import('../../../client/chatWidgetClient.js');
    listWidgets.mockResolvedValue([{ ...W, enabled: false }]);
    patchWidget.mockRejectedValueOnce(new WidgetApiError('validation_error: No agent', 'agentId'));
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText(/no longer exists/)).toBeTruthy();
  });

  // ADR 1018 D8 — the server refuses a widget that would answer on the platform's managed
  // key in a non-superadmin workspace. The console says so in the user's language at
  // every site that can hit it (create, Enable, Configure save), whatever field it names.
  it('maps the widget_byok_required refusal to its own copy on create, enable and save', async () => {
    const { WidgetApiError } = await import('../../../client/chatWidgetClient.js');
    const byok = (): InstanceType<typeof WidgetApiError> => new WidgetApiError('validation_error: needs key', 'credential', undefined, 'widget_byok_required');
    const NEEDS_KEY = 'This widget needs your own model key.';

    listWidgets.mockResolvedValue([]);
    provisionWidget.mockRejectedValueOnce(byok());
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Agent id'), { target: { value: 'support' } });
    fireEvent.change(screen.getByLabelText('Allowed domains (comma-separated)'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create widget' }));
    expect(await screen.findByText(NEEDS_KEY)).toBeTruthy();

    cleanup();
    listWidgets.mockResolvedValue([{ ...W, enabled: false }]);
    patchWidget.mockRejectedValueOnce(byok());
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText(NEEDS_KEY)).toBeTruthy();

    cleanup();
    listWidgets.mockResolvedValue([W]);
    patchWidget.mockRejectedValueOnce(byok());
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    await screen.findByText('openwop:kanban.add-todo');
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByText(NEEDS_KEY)).toBeTruthy();
  });
});

