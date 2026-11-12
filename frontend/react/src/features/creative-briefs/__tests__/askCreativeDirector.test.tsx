/**
 * ADR 1039 D8 (CB82XC-2) — "Ask the Creative Director" opens the ONE chat scoped
 * to the agent, with an editable draft naming the brief.
 *
 * Red when the button shows without the agent in the caller's catalog (the chat
 * would silently ignore the unknown id and open unscoped), the deep link names
 * anything but the canonical pack id (ADR 0763 two spellings), the draft stops
 * naming the brief and its org, or a dirty form is not saved first (grade-ux H1:
 * the agent would read the version before the edits).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const entries = vi.fn();
vi.mock('../../../chat/lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: entries(), isLoading: false, error: null }) }));
const staged: string[] = [];
vi.mock('../../../chat/composerSeed.js', () => ({ stageComposerDraft: (t: string) => { staged.push(t); } }));

import { AskCreativeDirector, CREATIVE_DIRECTOR_AGENT_ID } from '../AskCreativeDirector.js';

function Where(): JSX.Element { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }

function mount(opts: { dirty?: boolean; save?: () => Promise<boolean> } = {}): void {
  render(
    <MemoryRouter initialEntries={['/creative-briefs/cb-1']}>
      <Routes>
        <Route path="/creative-briefs/:id" element={<AskCreativeDirector briefId="cbrief:spring" orgId="org-acme" title="Spring hero" dirty={opts.dirty ?? false} onSaveFirst={opts.save ?? (async () => true)} />} />
        <Route path="/" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const cd = { agentId: CREATIVE_DIRECTOR_AGENT_ID, displayName: 'Campaign Creative Director', persona: 'Campaign Creative Director', slug: 'creative-director', description: '', packName: 'p', packVersion: '1', modelClass: 'chat' };

beforeEach(() => { staged.length = 0; entries.mockReset(); });
afterEach(cleanup);

describe('ADR 1039 D8 — Ask the Creative Director', () => {
  it('pins the canonical agent id', () => {
    expect(CREATIVE_DIRECTOR_AGENT_ID).toBe('vendor.openwop-app.campaign-studio.agents.creative-director');
  });

  it('renders nothing when the agent is not in the caller\'s catalog', () => {
    entries.mockReturnValue([{ ...cd, agentId: 'vendor.openwop-app.campaign-studio.agents.copywriter' }]);
    mount();
    expect(screen.queryByRole('button', { name: /ask campaign creative director/i })).toBeNull();
  });

  it('stages a draft naming the brief and its org, and opens the chat scoped to the agent', async () => {
    entries.mockReturnValue([cd]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /ask campaign creative director/i }));
    expect(await screen.findByTestId('where')).toBeTruthy();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toContain('cbrief:spring');
    expect(staged[0]).toContain('org-acme');
    expect(staged[0]).toContain('Spring hero');
    expect(screen.getByTestId('where').textContent).toBe(`/?agent=${encodeURIComponent(CREATIVE_DIRECTOR_AGENT_ID)}`);
  });

  it('a dirty form saves first; a failed save stays on the page with nothing staged', async () => {
    entries.mockReturnValue([cd]);
    const save = vi.fn(async () => false);
    mount({ dirty: true, save });
    fireEvent.click(screen.getByRole('button', { name: /save & ask campaign creative director/i }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(staged).toHaveLength(0);
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
