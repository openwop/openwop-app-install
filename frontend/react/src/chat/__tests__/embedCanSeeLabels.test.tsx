/**
 * ADR 0768 follow-up P1 — each embed states its agent's REAL reach.
 *
 * None of these agents is bound to what is on screen: the CAD Modeler reads any
 * CAD model the user may open, and the Agent Author sees the catalog + roster but NOT the wizard's
 * form. A "Can see: this canvas" label would be a false statement to the user,
 * so each panel passes its namespace's honest scope key. Pinned per panel so a
 * later "this canvas" copy change has to come with a real binding — which CAD
 * now has (ADR 0777): it passes `focus`, and the embed shows "this model" only
 * after the server accepts; the honest key below stays as the fallback.
 *
 * (ADR 0773 G-10e: the Workflow Architect's drawer is retired. Its embed is now
 * the builder's Pair rail, which IS bound to the open workflow through
 * `read-canvas`, so its label names this workflow; that case left this file.)
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({ t: (k: string) => `${ns ?? ''}:${k}` }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock('../EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ contextLabel, focus }: { contextLabel?: string; focus?: { kind: string; id: string; label: string } }) => (
    <>
      <p data-testid="scope">{contextLabel ?? '(none)'}</p>
      <p data-testid="focus">{focus ? `${focus.kind}:${focus.id}:${focus.label}` : '(none)'}</p>
    </>
  ),
}));

import { CadAssistPanel } from '../../features/cad/CadAssistPanel.js';
import { AgentAuthorPanel } from '../../agents/AgentAuthorPanel.js';

const inRouter = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('embed "can see" labels state the real scope', () => {
  it('CAD Modeler: CAD models the user can open', async () => {
    inRouter(<CadAssistPanel canvasId="cv-1" onClose={vi.fn()} />);
    expect((await screen.findByTestId('scope')).textContent).toBe('cad:assistCanSee');
    // ADR 0777 — the real binding that lets it say "this model" (once the server accepts).
    expect(screen.getByTestId('focus').textContent).toBe('canvas:cv-1:cad:assistCanSeeThis');
  });

  it('Agent Author: agents, workflows and the roster (not the form)', async () => {
    inRouter(<AgentAuthorPanel onClose={vi.fn()} />);
    expect((await screen.findByTestId('scope')).textContent).toBe('agents:authorCanSee');
  });
});
