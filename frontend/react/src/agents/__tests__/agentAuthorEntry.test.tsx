/**
 * ADR 0514 P3 — the describe-to-create entry on /agents/new.
 *
 * Both polarities: toggle OFF (the default) shows NO entry — the wizard is
 * byte-identical to before; toggle ON shows the entry, and opening it mounts
 * the panel region (the lazy chat chunk renders behind Suspense), scoped to the
 * Agent Author agent. The toggle mock answers ONLY the `agent-author` key, so a
 * wizard reading the wrong toggle id renders no entry and the ON case reds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn(), on: false }));
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
// The lazy chat chunk must not load in this test — stub the panel's import and
// record the agent it is scoped to.
const chatProps = vi.hoisted(() => ({ seen: [] as Array<{ agentId?: string }> }));
vi.mock('../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: (props: { agentId?: string }) => { chatProps.seen.push(props); return <div data-testid="embedded-chat" />; },
}));
// The stashed-draft read is the wizard's only other fetch; answer it here so no
// request leaves jsdom (stashedDraftOffer.test.tsx owns that offer's behaviour).
vi.mock('../agentAuthorDraftClient.js', () => ({
  getStashedAgentDraft: vi.fn(async () => null),
  dismissStashedAgentDraft: vi.fn(async () => undefined),
}));

import { AgentCreateWizard } from '../AgentCreateWizard.js';

beforeEach(() => {
  access.useFeatureAccess.mockReset();
  access.useFeatureAccess.mockImplementation((key: string) =>
    makeFeatureAccess({ enabled: key === 'agent-author' && access.on, loading: false }));
  chatProps.seen.length = 0;
});
afterEach(cleanup);

function view(): void {
  render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
}

describe('ADR 0514 P3 — describe-to-create entry', () => {
  it('toggle OFF (default): no entry — the wizard is unchanged', () => {
    access.on = false;
    view();
    // Positive control: the wizard itself rendered (step 1).
    expect(screen.getByText('Pick a role')).toBeTruthy();
    expect(screen.queryByText(/Describe your agent/i)).toBeNull();
  });

  it('toggle ON: the entry opens the panel (lands-disabled contract stated)', async () => {
    access.on = true;
    view();
    fireEvent.click(screen.getByRole('button', { name: /Describe your agent/i }));
    expect(await screen.findByRole('region', { name: 'Describe your agent' })).toBeTruthy();
    expect(screen.getByText(/creates it DISABLED/i)).toBeTruthy();
    expect(await screen.findByTestId('embedded-chat')).toBeTruthy();
    expect(chatProps.seen.at(-1)?.agentId).toBe('vendor.openwop-app.agent-author.agents.agent-author');
  });
});
