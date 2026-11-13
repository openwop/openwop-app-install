/**
 * ADR 0127 Phase 4 — WidgetsPage admin (list + embed snippet + grant editor), ADR 0469
 * Phase B/D, ADR 1018 (D1 absolute snippet, D8 byok refusal, grade-ux CW68U-2/8/16/17).
 * Breaks if Embed shows a snippet that does not carry the widget's real token and an
 * ABSOLUTE embed.js URL (under the production-shaped relative base `/api`), if a write
 * grant does not default to HITL, if the save does not send the chosen control/cap, if a
 * save leaves the editor open with a stale list, if the agent is not picked from the
 * roster, if a disabled widget is not labelled or cannot be re-enabled, if Disable is not
 * confirmed, or if a refused Enable / a `widget_byok_required` refusal reads as the
 * generic error. Probe-witnessed in wave 107 (`w107g2-wid-*`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
type WidgetApi = typeof import('../../../client/chatWidgetClient.js');
const { listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget, toastSuccess } = vi.hoisted(() => ({
  listWidgets: vi.fn<WidgetApi['listWidgets']>(), listOrgs: vi.fn<WidgetApi['listOrgs']>(),
  getToolCatalog: vi.fn<WidgetApi['getToolCatalog']>(), patchWidget: vi.fn<WidgetApi['patchWidget']>(),
  provisionWidget: vi.fn<WidgetApi['provisionWidget']>(), toastSuccess: vi.fn(),
}));
// Spread the REAL client: `embedSnippet` must be the product's own, or the snippet
// case asserts text this file wrote itself.
vi.mock('../../../client/chatWidgetClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/chatWidgetClient.js')>()),
  listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget, rotateWidgetToken: vi.fn(), deleteWidget: vi.fn(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
// ADR 1018 — the page now offers a roster picker (listAgents) and a "try in chat" deep
// link (useNavigate), so it renders inside a router with the roster read stubbed.
const { listAgents, confirmMock } = vi.hoisted(() => ({
  listAgents: vi.fn<typeof import('../../../client/agentsClient.js')['listAgents']>(),
  confirmMock: vi.fn<typeof import('../../../ui/confirm.js')['confirm']>(),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));
vi.mock('../../../client/agentsClient.js', () => ({ listAgents }));
import { MemoryRouter } from 'react-router-dom';
import { WidgetsPage } from '../WidgetsPage.js';
import type { Widget } from '../../../client/chatWidgetClient.js';
import type { AgentEntry } from '../../../client/agentsClient.js';
import { config } from '../../../client/config.js';

const W: Widget = { widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true };
/** A complete roster entry (typed: the mock is typed against `listAgents`). */
const SUPPORT_AGENT: AgentEntry = {
  agentId: 'vendor.x.agents.support', persona: 'assistant', label: 'Support agent', modelClass: 'standard',
  packName: 'vendor.x.agents', packVersion: '1.0.0', toolAllowlist: [], hasHandoffSchemas: false,
};

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
    // ADR 1018 D1 (`CW68WF-1`) — production's base is the RELATIVE `/api`, and a
    // relative `src` 404s on every customer site. The test env's default base is the
    // absolute dev URL, under which a relative-src page passes too, so the case runs
    // under the production shape. (`embedScriptUrl.test.ts` holds the URL math; this
    // case holds that the page renders THIS widget's snippet through it.)
    const savedBase = config.baseUrl;
    config.baseUrl = '/api';
    try {
      listWidgets.mockResolvedValue([W]);
      render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
      expect(await screen.findByText('support')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
      // The page origin is the environment's (jsdom), not the product's.
      expect(window.location.origin).toMatch(/^https?:\/\/[^/]+$/);
      expect(await screen.findByText(
        `<script src="${window.location.origin}/api/host/openwop-app/public/widget/embed.js" data-token="wgt_abc"></script>`,
      )).toBeTruthy();
    } finally {
      config.baseUrl = savedBase;
    }
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
    listAgents.mockResolvedValue([SUPPORT_AGENT]);
    listWidgets.mockResolvedValue([{ ...W, enabled: false }]);
    patchWidget.mockResolvedValue({ ...W, enabled: true });
    render(<MemoryRouter><WidgetsPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'Support agent' })).toBeTruthy();
    // Wait for the widget list too: the roster and the list load independently, and under
    // shuffle seed 11 the roster won the race, so a synchronous getByText saw "Loading"
    // (wave 107 final verify; main's copy reddened the same way).
    expect(await screen.findByText('Disabled')).toBeTruthy();
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

