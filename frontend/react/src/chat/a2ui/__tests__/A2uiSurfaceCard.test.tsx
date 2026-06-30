import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { A2uiSurfaceCard } from '../A2uiSurfaceCard.js';
import { parseSurface, A2UI_CATALOG_VERSION } from '../catalog.js';
import type { CardProps } from '../../registry/types.js';

afterEach(cleanup);

/**
 * Unit coverage for the A2UI surface renderer (ADR 0051 / RFC 0102), aligned to
 * the core wire schema `ui.a2ui-surface` (discriminator `component`, `surface`
 * wrapper, `action.target` resume|exchange). Asserts the load-bearing security +
 * behavior contract, not styling:
 *  - the closed catalog renders the day-1 form subset;
 *  - an out-of-catalog component fails closed (no interactive render);
 *  - a catalog-version mismatch fails closed;
 *  - a resume action routes collected values through onAction('resolve', …);
 *  - an exchange action routes through onAction('exchange', …) (a2ui-action-confinement);
 *  - a required-but-empty field disables the action.
 */

const ctx: CardProps['context'] = { runId: 'run-1', nodeId: 'node-1', tenantId: 'demo' };

function renderCard(payload: unknown, onAction = vi.fn().mockResolvedValue(undefined)): { onAction: ReturnType<typeof vi.fn> } {
  render(<A2uiSurfaceCard payload={payload} cardType="ui.a2ui-surface" context={ctx} onAction={onAction} />);
  return { onAction };
}

const goodPayload = {
  catalogVersion: A2UI_CATALOG_VERSION,
  surface: {
    title: 'Schedule the kickoff',
    components: [
      { component: 'heading', text: 'When works?', level: 2 },
      { component: 'text', text: 'Pick a time and the attendees.' },
      { component: 'field.date', id: 'when', label: 'Date', required: true },
      { component: 'field.select', id: 'dur', label: 'Duration', options: [
        { value: '30', label: '30 min' }, { value: '60', label: '60 min' },
      ] },
      { component: 'field.checkbox', id: 'remind', label: 'Send a reminder', default: false },
      { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
    ],
  },
};

describe('A2uiSurfaceCard — catalog parse', () => {
  it('accepts the day-1 form-subset surface', () => {
    expect(parseSurface(goodPayload).ok).toBe(true);
  });

  it('rejects an out-of-catalog component', () => {
    const p = parseSurface({ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [{ component: 'iframe', src: 'x' }] } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/not in the host A2UI catalog/);
  });

  it('rejects a malformed component (missing required props)', () => {
    const p = parseSurface({ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [{ component: 'field.text' }] } });
    expect(p.ok).toBe(false);
  });

  it('rejects an action.button without a confined target', () => {
    const p = parseSurface({ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [
      { component: 'action.button', id: 'go', label: 'Go', action: { url: 'http://evil' } },
    ] } });
    expect(p.ok).toBe(false);
  });
});

describe('A2uiSurfaceCard — render + action', () => {
  it('renders the title, heading, text, and a primary action button', () => {
    renderCard(goodPayload);
    expect(screen.getByText('Schedule the kickoff')).toBeTruthy();
    expect(screen.getByText('When works?')).toBeTruthy();
    expect(screen.getByText('Pick a time and the attendees.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('renders an agent heading at an OFFSET aria-level so it cannot hijack the chat outline (a11y §11)', () => {
    renderCard(goodPayload); // heading level 2 → aria-level 5, never an <h1>/<h2>
    const heading = screen.getByRole('heading', { name: 'When works?' });
    expect(heading.getAttribute('aria-level')).toBe('5');
    expect(heading.tagName).not.toBe('H1');
    expect(heading.tagName).not.toBe('H2');
  });

  it('routes a resume action through onAction("resolve", …) with collected values', () => {
    const { onAction } = renderCard(goodPayload);
    fireEvent.change(screen.getByLabelText(/Date/), { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAction).toHaveBeenCalledWith('resolve', expect.objectContaining({
      action: 'confirm', when: '2026-07-01', dur: '30', remind: false,
    }));
  });

  it('routes an exchange action through onAction("exchange", …)', () => {
    const payload = {
      catalogVersion: A2UI_CATALOG_VERSION,
      surface: { components: [
        { component: 'field.text', id: 'msg', label: 'Message' },
        { component: 'action.button', id: 'send', label: 'Send', action: { target: 'exchange' } },
      ] },
    };
    const { onAction } = renderCard(payload);
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAction).toHaveBeenCalledWith('exchange', expect.objectContaining({ action: 'send', msg: 'hi' }));
  });

  it('fails closed on an out-of-catalog component (no button, shows a notice)', () => {
    renderCard({ catalogVersion: A2UI_CATALOG_VERSION, surface: { components: [{ component: 'script', text: 'alert(1)' }] } });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/could not be rendered safely/)).toBeTruthy();
  });

  it('fails closed on a catalog-version mismatch', () => {
    renderCard({ ...goodPayload, catalogVersion: '9.9.9' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/this host renders/i)).toBeTruthy();
  });

  it('disables the action until a required field is filled, with an accessible reason', () => {
    renderCard(goodPayload);
    const btn = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // accessible reason for the disabled state, wired via aria-describedby
    const hint = screen.getByText(/Fill the required fields to continue/);
    expect(hint).toBeTruthy();
    expect(btn.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.change(screen.getByLabelText(/Date/), { target: { value: '2026-07-01' } });
    expect(btn.disabled).toBe(false);
    expect(screen.queryByText(/Fill the required fields to continue/)).toBeNull();
  });
});
