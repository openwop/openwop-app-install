/**
 * ADR 0514 P3 — the describe-to-create entry on /agents/new.
 *
 * Both polarities: toggle OFF (the default) shows NO entry — the wizard is
 * byte-identical to before; toggle ON shows the entry, and opening it mounts
 * the panel region (the lazy chat chunk renders behind Suspense).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
// The lazy chat chunk must not load in this test — stub the panel's import.
vi.mock('../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: () => <div data-testid="embedded-chat" />,
}));

import { AgentCreateWizard } from '../AgentCreateWizard.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function view(): void {
  render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
}

describe('ADR 0514 P3 — describe-to-create entry', () => {
  it('toggle OFF (default): no entry — the wizard is unchanged', () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    view();
    expect(screen.queryByText(/Describe your agent/i)).toBeNull();
  });

  it('toggle ON: the entry opens the panel (lands-disabled contract stated)', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
    view();
    fireEvent.click(screen.getByRole('button', { name: /Describe your agent/i }));
    expect(await screen.findByRole('region', { name: 'Describe your agent' })).toBeTruthy();
    expect(screen.getByText(/creates it DISABLED/i)).toBeTruthy();
    expect(await screen.findByTestId('embedded-chat')).toBeTruthy();
  });
});
