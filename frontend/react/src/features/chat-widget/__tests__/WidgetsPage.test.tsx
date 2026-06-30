/**
 * ADR 0127 Phase 4 — WidgetsPage admin (list + embed snippet + disabled gate).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
const { listWidgets, listOrgs } = vi.hoisted(() => ({ listWidgets: vi.fn(), listOrgs: vi.fn() }));
vi.mock('../../../client/chatWidgetClient.js', () => ({
  listWidgets, listOrgs, provisionWidget: vi.fn(), rotateWidgetToken: vi.fn(), deleteWidget: vi.fn(),
  embedSnippet: (tok: string) => `<script src="X" data-token="${tok}"></script>`,
}));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => ({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }) }));
import { WidgetsPage } from '../WidgetsPage.js';

beforeEach(() => { enabled = true; listWidgets.mockReset(); listOrgs.mockReset(); listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org' }]); });
afterEach(cleanup);

describe('WidgetsPage (ADR 0127 Phase 4)', () => {
  // (The "disabled → no fetch" test was removed: chat-widget graduated to always-on in the
  // ADR 0134 toggle graduation, so the component hardcodes access.enabled = true and the
  // feature-off path is dead. The toggle mock stays inert.)

  it('lists widgets + reveals the embed snippet on Embed', async () => {
    listWidgets.mockResolvedValue([{ widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true }]);
    render(<WidgetsPage />);
    expect(await screen.findByText('support')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    expect(await screen.findByText(/data-token="wgt_abc"/)).toBeTruthy();
  });
});
