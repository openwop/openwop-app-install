/**
 * ADR 0948 P3a — the Funnel Architect on the Funnels page is the shared `ChatPocket`
 * (the ONE embedded chat, ADR 0768 P5) scoped to the architect: no second chat panel.
 * The starter prompts' visible labels name the organization; what they SEND carries its
 * id too (the architect's tools need `orgId` in a multi-org workspace).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, sent: [] as string[] }));
vi.mock('../../../chat/ChatPocket.js', () => ({
  ChatPocket: (props: { agentId: string; title: string; contextLabel?: unknown; defaultOpen?: boolean; renderEmptyState?: (onPick: (t: string) => void) => unknown }) => {
    seen.props = { ...props };
    return (
      <div data-testid="pocket" data-agent={props.agentId}>
        <span>{props.contextLabel as string}</span>
        {props.renderEmptyState?.((t) => seen.sent.push(t)) as never}
      </div>
    );
  },
}));

import { FunnelArchitectPocket, FUNNEL_ARCHITECT_AGENT_ID } from '../FunnelArchitectPanel.js';
import { FUNNEL_ARCHITECT_AGENT } from '../../campaign-orchestration/campaignStudioClient.js';

afterEach(() => { cleanup(); seen.props = null; seen.sent = []; });

describe('ADR 0948 P3a — the Funnel Architect pocket', () => {
  it('is the shared pocket scoped to the architect; labels name the org, the sent text carries its id', () => {
    render(<FunnelArchitectPocket orgId="org-123" orgName="Acme Client" defaultOpen onTurnSettled={() => undefined} />);
    expect(screen.getByTestId('pocket').getAttribute('data-agent')).toBe(FUNNEL_ARCHITECT_AGENT_ID);
    expect(seen.props?.defaultOpen).toBe(true);
    expect(screen.getByText('Can see: the funnels and briefs of Acme Client')).toBeTruthy();
    const prompts = screen.getAllByRole('button');
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p.textContent).toContain('Acme Client');
      expect(p.textContent, 'the opaque id stays out of the visible label').not.toContain('org-123');
    }
    // Honest copy: the read-only prompt comes first, generation names its condition.
    expect(prompts[0]!.textContent).toBe('Which funnel blueprints are available for Acme Client?');
    fireEvent.click(prompts[1]!);
    expect(seen.sent).toEqual(['Draft a funnel for Acme Client from our existing pages. (organization id: org-123)']);
  });

  it('falls back to "this organization" without a name', () => {
    render(<FunnelArchitectPocket orgId="org-9" orgName={undefined} defaultOpen={false} onTurnSettled={() => undefined} />);
    expect(screen.getByText('Can see: the funnels and briefs of this organization')).toBeTruthy();
  });

  it('Campaign Studio deep-links the same agent id', () => {
    expect(FUNNEL_ARCHITECT_AGENT).toBe(FUNNEL_ARCHITECT_AGENT_ID);
  });
});
