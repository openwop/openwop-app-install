import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { A2uiSurfaceCard } from '../A2uiSurfaceCard.js';
import { A2UI_V09_CATALOG_ID } from '../v09/profile.js';
import type { CardProps } from '../../registry/types.js';

afterEach(cleanup);

/**
 * `openwop.requirement.0209.render-needs-root` — the reference-impl witness
 * RFC 0209 §C.9 assigns to this app (tier: reference-impl; the server suite
 * cannot observe a renderer). A consumer MUST NOT render a v0.9 surface, or
 * enable any action on it, until the fold holds a component with id `root`.
 *
 * Each case renders the SAME components — including an enabled-looking Button
 * and Text — with and without `root`, so a pass is the presence of `root`
 * deciding the render, not an empty surface rendering nothing.
 */
const ctx: CardProps['context'] = { runId: 'run-1', nodeId: 'node-1', tenantId: 'demo' };
const SID = 'approve-brief';
const create = { version: 'v0.9', createSurface: { surfaceId: SID, catalogId: A2UI_V09_CATALOG_ID } };
const leaves = [
  { id: 'h', component: 'Text', text: 'Launch brief', variant: 'h2' },
  { id: 'go_label', component: 'Text', text: 'Approve' },
  { id: 'go', component: 'Button', child: 'go_label', variant: 'primary', action: { event: { name: 'resume' } } },
];
const root = { id: 'root', component: 'Column', children: ['h', 'go'] };
const payload = (messages: unknown[]) => ({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: SID, messages });
const components = (list: unknown[]) => ({ version: 'v0.9', updateComponents: { surfaceId: SID, components: list } });

function renderCard(p: unknown) {
  const onAction = vi.fn().mockResolvedValue(undefined);
  render(<A2uiSurfaceCard payload={p} cardType="ui.a2ui-surface" context={ctx} onAction={onAction} />);
  return onAction;
}

describe('openwop.requirement.0209.render-needs-root', () => {
  it('a surface whose fold has components but no root renders none of them and no action', () => {
    renderCard(payload([create, components(leaves)]));
    expect(screen.queryByText('Launch brief')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/still building/);
  });

  it('a createSurface alone renders nothing of the surface', () => {
    renderCard(payload([create]));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('the same components render — with an enabled action — once root arrives, including in a LATER envelope of the fold', () => {
    renderCard({ surfaces: [payload([create, components(leaves)]), payload([components([root])])] });
    expect(screen.getByRole('heading', { name: 'Launch brief' })).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('a deleted surface stops rendering, root or not', () => {
    renderCard(payload([create, components([root, ...leaves]), { version: 'v0.9', deleteSurface: { surfaceId: SID } }]));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/closed/);
  });
});
