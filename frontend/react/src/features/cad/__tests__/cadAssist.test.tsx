/**
 * ADR 0515 — the CAD editor's in-editor entry to the CAD Modeler.
 * Invariants:
 *   - toggle OFF: NO entry (the slot self-gates — polarity)
 *   - toggle ON: the entry opens the drawer, which embeds the ONE shared
 *     chat (stubbed here) scoped to the CAD Modeler — never a new chat
 *   - the seeded example prompts CARRY the open canvas's id (the scoping
 *     mechanism for get-design/render)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import type { EmbeddedChatPanel } from '../../../chat/EmbeddedChatPanel.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
type EmbeddedProps = ComponentProps<typeof EmbeddedChatPanel>;
const embedded = vi.hoisted(() => ({ props: [] as EmbeddedProps[] }));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: (p: EmbeddedProps) => { embedded.props.push(p); return <div data-testid="embedded-chat" />; },
}));

import { CadAssistExtras } from '../CadAssistExtras.js';

beforeEach(() => { vi.clearAllMocks(); embedded.props.length = 0; });
afterEach(cleanup);

const PROPS = { orgId: 'org-1', canvasId: 'cv-cad-42', docName: 'Bracket', dirty: false };

function view(): void {
  render(<MemoryRouter><CadAssistExtras {...PROPS} /></MemoryRouter>);
}

describe('ADR 0515 — CAD assist entry', () => {
  it('toggle OFF: renders nothing (self-gating polarity)', () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    view();
    // The slot gates on the CAD feature itself, not on some other toggle.
    expect(access.useFeatureAccess).toHaveBeenCalledWith('cad');
    expect(screen.queryByRole('button', { name: /CAD Modeler/i })).toBeNull();
  });

  it('toggle ON: opens the drawer; the SHARED chat mounts scoped to the CAD Modeler', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
    view();
    expect(access.useFeatureAccess).toHaveBeenCalledWith('cad');
    fireEvent.click(screen.getByRole('button', { name: /Ask the CAD Modeler/i }));
    expect(screen.getByRole('region', { name: 'CAD Modeler' })).toBeTruthy();
    expect(await screen.findByTestId('embedded-chat')).toBeTruthy();
    expect(embedded.props[0]?.agentId).toBe('vendor.openwop-app.cad.agents.default'); // the ONE cad agent
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'CAD Modeler' })).toBeNull();
  });

  it('the seeded examples carry the open canvas id (the scoping mechanism)', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
    view();
    fireEvent.click(screen.getByRole('button', { name: /Ask the CAD Modeler/i }));
    await screen.findByTestId('embedded-chat');
    const renderEmptyState = embedded.props[0]?.renderEmptyState;
    expect(renderEmptyState).toBeTypeOf('function');
    const picked: string[] = [];
    render(<MemoryRouter>{renderEmptyState!((t) => { picked.push(t); })}</MemoryRouter>);
    const example = screen.getAllByRole('button', { name: /cv-cad-42/ });
    expect(example).toHaveLength(3); // every example names THIS canvas
    fireEvent.click(example[0]!);
    expect(picked[0]).toContain('cv-cad-42');
  });
});
