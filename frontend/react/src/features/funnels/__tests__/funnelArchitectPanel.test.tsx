/**
 * ADR 0948 P3a — the Funnel Architect on the Funnels page is the shared `ChatPocket`
 * (the ONE embedded chat, ADR 0768 P5) scoped to the architect: no second chat panel.
 * The starter prompts' visible labels name the organization; what they SEND carries its
 * id too (the architect's tools need `orgId` in a multi-org workspace). The page's list
 * refresh rides `onTurnSettled`, and `defaultOpen` passes through both ways.
 *
 * Sabotage (w76 probes): another agent id, a label that shows the id, a sent prompt
 * without it, or a reordered prompt list reds the first case; a dropped `onTurnSettled`
 * reds it too; a pinned `defaultOpen` reds the second; the Funnels and Campaign Studio
 * ids drifting apart reds the third.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { t } from 'i18next';

type PocketProps = Parameters<typeof import('../../../chat/ChatPocket.js').ChatPocket>[0];

const seen = vi.hoisted(() => ({ props: null as null | PocketProps, sent: [] as string[] }));
vi.mock('../../../chat/ChatPocket.js', () => ({
  ChatPocket: (props: PocketProps) => {
    seen.props = props;
    return (
      <div data-testid="pocket" data-agent={props.agentId}>
        <span>{props.contextLabel}</span>
        {props.renderEmptyState?.((text) => { seen.sent.push(text); })}
      </div>
    );
  },
}));

import { FunnelArchitectPocket, FUNNEL_ARCHITECT_AGENT_ID } from '../FunnelArchitectPanel.js';
import { FUNNEL_ARCHITECT_AGENT } from '../../campaign-orchestration/campaignStudioClient.js';

afterEach(() => { cleanup(); seen.props = null; seen.sent = []; });

describe('ADR 0948 P3a — the Funnel Architect pocket', () => {
  it('is the shared pocket scoped to the architect; labels name the org, the sent text carries its id', () => {
    const onTurnSettled = vi.fn();
    render(<FunnelArchitectPocket orgId="org-123" orgName="Acme Client" defaultOpen onTurnSettled={onTurnSettled} />);
    // The id the agent pack ships (`packs/vendor.openwop-app.funnels.agents/pack.json`).
    expect(screen.getByTestId('pocket').getAttribute('data-agent')).toBe('vendor.openwop-app.funnels.agents.funnel-architect');
    expect(seen.props?.defaultOpen).toBe(true);
    seen.props?.onTurnSettled?.();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('funnels:architectContext', { org: 'Acme Client' }))).toBeTruthy();
    const prompts = screen.getAllByRole('button');
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p.textContent).toContain('Acme Client');
      expect(p.textContent, 'the opaque id stays out of the visible label').not.toContain('org-123');
    }
    // Honest copy: the read-only prompt comes first, generation names its condition.
    expect(prompts[0]!.textContent).toBe('Which funnel blueprints are available for Acme Client?');
    for (const p of prompts) fireEvent.click(p);
    expect(seen.sent).toEqual([
      'Which funnel blueprints are available for Acme Client? (organization id: org-123)',
      'Draft a funnel for Acme Client from our existing pages. (organization id: org-123)',
      'Generate a draft funnel for Acme Client from a confirmed campaign brief. (organization id: org-123)',
    ]);
  });

  it('falls back to "this organization" without a name', () => {
    render(<FunnelArchitectPocket orgId="org-9" orgName={undefined} defaultOpen={false} onTurnSettled={() => undefined} />);
    expect(screen.getByText(t('funnels:architectContext', { org: t('funnels:architectThisOrg') }))).toBeTruthy();
    expect(seen.props?.defaultOpen).toBe(false);
  });

  it('Campaign Studio deep-links the same agent id', () => {
    expect(FUNNEL_ARCHITECT_AGENT).toBe(FUNNEL_ARCHITECT_AGENT_ID);
  });
});
