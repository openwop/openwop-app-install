import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { A2uiSurfaceCard } from '../A2uiSurfaceCard.js';
import { A2UI_V09_CATALOG_ID } from '../v09/profile.js';
import { foldSurface } from '../v09/fold.js';
import { exceedsRenderBudget, MAX_RENDER_NODES } from '../v09/A2uiV09Surface.js';
import type { CardProps } from '../../registry/types.js';

afterEach(cleanup);

/** ADR 0755 (WIT-A2UI-1) — `children` may legally repeat an id, so a surface of a
 *  few components can EXPAND exponentially. Four components here are 256³ ≈ 16.7M
 *  rendered elements without the budget; the card must refuse, fast. */
const ctx: CardProps['context'] = { runId: 'run-1', nodeId: 'node-1', tenantId: 'demo' };
const SID = 'fan-out';
const surface = (components: unknown[]) => ({
  version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: SID,
  messages: [
    { version: 'v0.9', createSurface: { surfaceId: SID, catalogId: A2UI_V09_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId: SID, components } },
  ],
});
const FAN_OUT = surface([
  { id: 'root', component: 'Column', children: Array(256).fill('a') },
  { id: 'a', component: 'Column', children: Array(256).fill('b') },
  { id: 'b', component: 'Row', children: Array(256).fill('c') },
  { id: 'c', component: 'Text', text: 'x' },
]);

describe('the v0.9 render budget', () => {
  it('refuses a fan-out surface with the unsafe notice, rendering nothing of it and no action', () => {
    const started = Date.now();
    render(<A2uiSurfaceCard payload={FAN_OUT} cardType="ui.a2ui-surface" context={ctx} onAction={vi.fn()} />);
    expect(Date.now() - started, 'the refusal must not pay for the expansion').toBeLessThan(2000);
    expect(screen.getByText(/could not be rendered safely/)).toBeTruthy();
    expect(screen.queryByText('x')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('the pre-check stops at the budget, whatever the expansion', () => {
    const state = foldSurface([FAN_OUT as never]);
    expect(exceedsRenderBudget(state.components)).toBe(true);
  });

  it('CONTROL: honest reuse under the budget still renders', () => {
    const ok = surface([
      { id: 'root', component: 'Column', children: Array(8).fill('row') },
      { id: 'row', component: 'Row', children: ['c', 'c'] },
      { id: 'c', component: 'Text', text: 'cell' },
    ]);
    expect(exceedsRenderBudget(foldSurface([ok as never]).components)).toBe(false);
    render(<A2uiSurfaceCard payload={ok} cardType="ui.a2ui-surface" context={ctx} onAction={vi.fn()} />);
    expect(screen.getAllByText('cell')).toHaveLength(16);
    expect(MAX_RENDER_NODES).toBeGreaterThanOrEqual(512);
  });

  it('a self-referencing Button label cannot drain the budget and drop later siblings (code-review M2)', () => {
    const selfRef = surface([
      { id: 'root', component: 'Column', children: ['go', 'warn'] },
      { id: 'go', component: 'Button', child: 'L', action: { event: { name: 'resume' } } },
      { id: 'L', component: 'Column', children: [...Array(255).fill('L'), 'lt'] },
      { id: 'lt', component: 'Text', text: 'Approve' },
      { id: 'warn', component: 'Text', text: 'This moves money' },
    ]);
    render(<A2uiSurfaceCard payload={selfRef} cardType="ui.a2ui-surface" context={ctx} onAction={vi.fn()} />);
    // Either the whole surface renders (warning included) or none of it does — never a
    // clickable button with its warning silently dropped.
    const warned = screen.queryByText('This moves money') !== null;
    const buttons = screen.queryAllByRole('button').length;
    expect(warned || buttons === 0).toBe(true);
    expect(warned, 'the cycle guard keeps this surface inside the budget').toBe(true);
  });
});
