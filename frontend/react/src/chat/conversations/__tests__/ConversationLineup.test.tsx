import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { ConversationLineup } from '../ConversationLineup.js';
import type { ActiveAgentRow } from '../../activeAgents/types.js';
import { DEFAULT_ASSISTANT_ID } from '../../activeAgents/constants.js';
import i18n from '../../../i18n/index.js';

/**
 * ADR 0304 P2 residue — the live-boardroom speaking pulse on the lineup.
 *
 * Guards: the agent whose settled turn is being VOICED shows "Speaking" on ITS
 * row (its tagline yields), speaking outranks thinking on the same row, nothing
 * speaks when `speakingAgentId` is null, and the strip chip exposes the floor as
 * a `role=status` named "Speaking". Every assertion is scoped to a row, so a
 * speaking state that lands on the wrong agent goes red (sabotage
 * `isSpeaking={row.agentId === currentAgentId}`, w44 cl-speak-row).
 */

const LINEUP: ActiveAgentRow[] = [
  { agentId: 'assistant', persona: 'Default', slug: 'assistant', modelClass: 'balanced', addedAt: '' },
  { agentId: 'ada', persona: 'Finance lens', slug: 'ada', modelClass: 'balanced', addedAt: '2026-01-01' },
  { agentId: 'rex', persona: 'Pipeline lens', slug: 'rex', modelClass: 'balanced', addedAt: '2026-01-01' },
];

function renderLineup(over: Partial<Parameters<typeof ConversationLineup>[0]> = {}) {
  render(
    <ConversationLineup
      lineup={LINEUP}
      currentAgentId="assistant"
      thinkingAgentId={null}
      onSwitchAgent={vi.fn()}
      onRemoveAgent={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => cleanup());

describe('ConversationLineup — speaking pulse (ADR 0304)', () => {
  it('shows "Speaking" on the agent whose turn is being voiced', () => {
    renderLineup({ speakingAgentId: 'ada' });
    const ada = screen.getByRole('button', { name: 'Switch to Ada' });
    expect(within(ada).getByText(/Speaking/)).toBeTruthy();
    expect(within(ada).queryByText('Finance lens')).toBeNull(); // the tagline yields
    // No other row speaks, and the other rows keep their taglines.
    expect(screen.getAllByText(/Speaking/)).toHaveLength(1);
    expect(within(screen.getByRole('button', { name: 'Switch to Rex' })).getByText('Pipeline lens')).toBeTruthy();
  });

  it('speaking outranks thinking on the same row', () => {
    renderLineup({ speakingAgentId: 'ada', thinkingAgentId: 'ada' });
    const ada = screen.getByRole('button', { name: 'Switch to Ada' });
    expect(within(ada).getByText(/Speaking/)).toBeTruthy();
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it('renders no speaking state when absent (default null — pre-0304 behavior)', () => {
    renderLineup({ thinkingAgentId: 'rex' });
    expect(screen.queryByText(/Speaking/)).toBeNull();
    expect(within(screen.getByRole('button', { name: 'Switch to Rex' })).getByText(/Thinking/)).toBeTruthy();
  });

  it('strip variant marks the speaking chip with the audible-floor icon', () => {
    renderLineup({ variant: 'strip', speakingAgentId: 'rex' });
    const rex = screen.getByRole('button', { name: 'Switch to Rex' });
    expect(within(rex).getByRole('status', { name: 'Speaking' })).toBeTruthy();
    expect(screen.getAllByRole('status', { name: 'Speaking' })).toHaveLength(1);
  });
});

/** ADR 0140 G2 — compact role context. The Campaigns handoff selects the
 *  correct agent, but its persona-based mention alias can be `research-9`.
 *  Keep that primary name while exposing the role already available on the
 *  row, without routing a switch/remove by the label or mention alias. */
const STRATEGIST: ActiveAgentRow = {
  agentId: 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist',
  persona: 'Campaign Strategist', slug: 'research-9', modelClass: 'research', addedAt: '2026-11-08',
};

describe('ConversationLineup — compact role context (ADR 0140 G2)', () => {
  it('explains the selected Research 9 alias visibly and to both controls without changing their canonical target', () => {
    const onSwitchAgent = vi.fn();
    const onRemoveAgent = vi.fn();
    renderLineup({ variant: 'strip', lineup: [STRATEGIST], currentAgentId: STRATEGIST.agentId, onSwitchAgent, onRemoveAgent });
    const activate = screen.getByRole('button', { name: 'Switch to Research 9' });
    expect(activate).toHaveAttribute('aria-pressed', 'true');
    expect(within(activate).getByText('Research 9')).toBeVisible();
    expect(within(activate).getByText('Campaign Strategist')).toBeVisible();
    expect(activate).toHaveAccessibleDescription('Campaign Strategist');
    const remove = screen.getByRole('button', { name: 'Remove Research 9 from this conversation' });
    expect(remove).toHaveAccessibleDescription('Campaign Strategist');
    fireEvent.click(activate);
    fireEvent.click(remove);
    expect(onSwitchAgent).toHaveBeenCalledExactlyOnceWith('vendor.openwop-app.campaign-orchestration.agents.campaign-strategist');
    expect(onRemoveAgent).toHaveBeenCalledExactlyOnceWith('vendor.openwop-app.campaign-orchestration.agents.campaign-strategist');
  });

  it('keeps a real human name primary while adding its existing role', () => {
    renderLineup({ variant: 'strip', lineup: [{ ...STRATEGIST, agentId: 'nora', slug: 'nora', persona: 'Chief of Staff' }] });
    const activate = screen.getByRole('button', { name: 'Switch to Nora' });
    expect(within(activate).getByText('Nora')).toBeVisible();
    expect(within(activate).getByText('Chief of Staff')).toBeVisible();
    expect(activate).toHaveAccessibleDescription('Chief of Staff');
    expect(screen.queryByRole('button', { name: 'Switch to Chief of Staff' })).toBeNull();
  });

  it('does not add redundant context to the synthetic default Assistant', () => {
    renderLineup({ variant: 'strip', lineup: [{ agentId: DEFAULT_ASSISTANT_ID, slug: 'assistant', persona: 'OpenWOP Assistant', modelClass: 'chat', addedAt: '' }] });
    const activate = screen.getByRole('button', { name: 'Switch to Assistant' });
    expect(within(activate).getByText('Assistant')).toBeVisible();
    expect(activate).toHaveAccessibleDescription('');
    expect(within(activate).queryByText('OpenWOP Assistant')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Assistant from this conversation' })).toBeNull();
  });

  it.each(['', '   ', '  nOrA  '])('omits empty or name-equivalent context %j without a dangling description', (persona) => {
    renderLineup({ variant: 'strip', lineup: [{ ...STRATEGIST, agentId: 'nora', slug: 'nora', persona }] });
    const activate = screen.getByRole('button', { name: 'Switch to Nora' });
    expect(within(activate).getAllByText(/^nora$/i)).toHaveLength(1);
    expect(activate).toHaveAccessibleDescription('');
    const remove = screen.getByRole('button', { name: 'Remove Nora from this conversation' });
    // No role link is needed here; the existing tooltip remains its native
    // accessible-description fallback when aria-describedby is absent.
    expect(remove).not.toHaveAttribute('aria-describedby');
    expect(remove).toHaveAttribute('title', i18n.t('chat:removeFromConversationTitle'));
    expect(remove).toHaveAccessibleDescription(i18n.t('chat:removeFromConversationTitle'));
  });

  it('keeps two collision aliases and their descriptions separate', () => {
    const onSwitchAgent = vi.fn();
    const onRemoveAgent = vi.fn();
    renderLineup({ variant: 'strip', lineup: [
      { ...STRATEGIST, agentId: 'vendor.qa.research-advisor', slug: 'research-8', persona: 'Market Analyst' },
      STRATEGIST,
    ], onSwitchAgent, onRemoveAgent });
    const analyst = screen.getByRole('button', { name: 'Switch to Research 8' });
    const strategist = screen.getByRole('button', { name: 'Switch to Research 9' });
    expect(analyst).toHaveAccessibleDescription('Market Analyst');
    expect(strategist).toHaveAccessibleDescription('Campaign Strategist');
    expect(analyst.getAttribute('aria-describedby')).not.toBe(strategist.getAttribute('aria-describedby'));
    fireEvent.click(analyst);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Research 9 from this conversation' }));
    expect(onSwitchAgent).toHaveBeenCalledExactlyOnceWith('vendor.qa.research-advisor');
    expect(onRemoveAgent).toHaveBeenCalledExactlyOnceWith('vendor.openwop-app.campaign-orchestration.agents.campaign-strategist');
  });

  it('updates the accessible role on the same row without changing its human name or speaking state', () => {
    const props = { currentAgentId: 'nora', thinkingAgentId: null, speakingAgentId: 'nora', onSwitchAgent: vi.fn(), onRemoveAgent: vi.fn(), variant: 'strip' as const };
    const { rerender } = render(<ConversationLineup {...props} lineup={[{ ...STRATEGIST, agentId: 'nora', slug: 'nora', persona: 'Chief of Staff' }]} />);
    expect(screen.getByRole('button', { name: 'Switch to Nora' })).toHaveAccessibleDescription('Chief of Staff');
    rerender(<ConversationLineup {...props} lineup={[{ ...STRATEGIST, agentId: 'nora', slug: 'nora', persona: 'Operations lead' }]} />);
    const activate = screen.getByRole('button', { name: 'Switch to Nora' });
    expect(activate).toHaveAccessibleDescription('Operations lead');
    expect(within(activate).getByText('Operations lead')).toBeVisible();
    expect(within(activate).queryByText('Chief of Staff')).toBeNull();
    expect(within(activate).getByRole('status', { name: 'Speaking' })).toBeVisible();
  });
});
