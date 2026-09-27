/**
 * ADR 0127 Phase 4 — WidgetsPage admin (list + embed snippet + grant editor).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
const { listWidgets, listOrgs, getToolCatalog, patchWidget } = vi.hoisted(() => ({ listWidgets: vi.fn(), listOrgs: vi.fn(), getToolCatalog: vi.fn(), patchWidget: vi.fn() }));
vi.mock('../../../client/chatWidgetClient.js', () => ({
  listWidgets, listOrgs, getToolCatalog, patchWidget, provisionWidget: vi.fn(), rotateWidgetToken: vi.fn(), deleteWidget: vi.fn(),
  embedSnippet: (tok: string) => `<script src="X" data-token="${tok}"></script>`,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { WidgetsPage } from '../WidgetsPage.js';

beforeEach(() => { listWidgets.mockReset(); listOrgs.mockReset(); getToolCatalog.mockReset(); patchWidget.mockReset(); listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org' }]); getToolCatalog.mockResolvedValue(['openwop:kanban.add-todo', 'openwop:knowledge.search']); patchWidget.mockResolvedValue({}); });
afterEach(cleanup);

describe('WidgetsPage (ADR 0127 Phase 4)', () => {
  // NO TOGGLE MOCK, because there is no toggle and the page does not import the
  // hook. `chat-widget` graduated to always-on in ADR 0134 (no `toggleDefault` in
  // its backend feature), and this file used to mock `useFeatureAccess` anyway —
  // a mock of a module the subject never imports, feeding an `enabled` flag
  // nothing read, beside a page whose `if (!access.enabled)` branch was
  // statically dead. Inert scenery is worse than nothing: it makes the file look
  // like it covers a gate.

  it('lists widgets + reveals the embed snippet on Embed', async () => {
    listWidgets.mockResolvedValue([{ widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true }]);
    render(<WidgetsPage />);
    expect(await screen.findByText('support')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    expect(await screen.findByText(/data-token="wgt_abc"/)).toBeTruthy();
  });

  it('Configure opens the grant editor, loads the catalog, defaults writes to HITL, and saves', async () => {
    listWidgets.mockResolvedValue([{ widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true }]);
    render(<WidgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    // Catalog renders both tools with read + write checkboxes.
    expect(await screen.findByText('openwop:kanban.add-todo')).toBeTruthy();
    expect(getToolCatalog).toHaveBeenCalledWith('o1');
    // Grant a write tool → the control defaults to HITL (the safe default).
    fireEvent.click(screen.getByLabelText('Allow anonymous write via openwop:kanban.add-todo (held for approval)'));
    expect(await screen.findByText(/held in your approval inbox/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await screen.findByText('support'); // settle
    expect(patchWidget).toHaveBeenCalledWith('o1', 'w1', expect.objectContaining({
      anonToolGrant: expect.objectContaining({ write: ['openwop:kanban.add-todo'], writeControl: 'hitl' }),
    }));
  });

  it('ADR 0469 Phase D — choosing auto-run reveals the per-session cap and saves rate-limit-session-cap', async () => {
    listWidgets.mockResolvedValue([{ widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true }]);
    render(<WidgetsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    await screen.findByText('openwop:kanban.add-todo');
    fireEvent.click(screen.getByLabelText('Allow anonymous write via openwop:kanban.add-todo (held for approval)'));
    // Select the auto-run control → the per-session cap field + the auto note appear.
    fireEvent.click(await screen.findByRole('radio', { name: /Auto-run under a per-session cap/i }));
    fireEvent.change(screen.getByLabelText('Auto-runs per session'), { target: { value: '3' } });
    expect(screen.getByText(/run automatically \(no approval\)/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await screen.findByText('support');
    expect(patchWidget).toHaveBeenCalledWith('o1', 'w1', expect.objectContaining({
      anonToolGrant: expect.objectContaining({ writeControl: 'rate-limit-session-cap' }),
      caps: expect.objectContaining({ maxAutoWritesPerSession: 3 }),
    }));
  });
});
