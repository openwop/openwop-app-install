/**
 * RunDrawer (§7.2.5 / CV-17) — direct coverage (grade-pass 2026-07-12):
 * hidden without an overlay, summary counts, expandable per-node payloads,
 * and the 4000-char payload bound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunDrawer } from '../RunDrawer.js';
import { useBuilderStore } from '../store/builderStore.js';

const st = () => useBuilderStore.getState();

beforeEach(() => {
  useBuilderStore.setState({
    nodes: [{ id: 'n1', kind: 'transform', name: 'Extract totals', position: { x: 0, y: 0 }, config: {} }],
    edges: [], selectedNodeIds: [], selectedNodeId: null, past: [], future: [], overlay: null,
  });
});

const ev = (type: string, payload?: unknown) => ({
  eventId: 'e', runId: 'r1', type, nodeId: 'b1', payload, timestamp: '2026-07-12T20:00:00Z', sequence: 1, schemaVersion: 3,
});

describe('RunDrawer', () => {
  it('renders nothing without an overlay', () => {
    const { container } = render(<RunDrawer />);
    expect(container.firstChild).toBeNull();
  });

  it('summarizes per-status counts and expands to payload rows', () => {
    st().startOverlay('r1', { b1: 'n1' });
    st().applyRunEvent(ev('node.completed', { out: 42 }));
    render(<RunDrawer />);
    const head = screen.getByRole('button', { name: /Run/ });
    expect(head.textContent).toContain('1 completed');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(screen.getByText('Extract totals')).toBeTruthy();
    // The terminal payload is behind a disclosure, pretty-printed.
    fireEvent.click(screen.getByText('Payload'));
    expect(screen.getByText(/"out": 42/)).toBeTruthy();
  });

  it('bounds a giant payload instead of rendering it whole', () => {
    st().startOverlay('r1', { b1: 'n1' });
    st().applyRunEvent(ev('node.failed', { blob: 'x'.repeat(10_000) }));
    render(<RunDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    fireEvent.click(screen.getByText('Payload'));
    const pre = document.querySelector('.builder-run-drawer__payload pre');
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? '').length).toBeLessThanOrEqual(4001 + 1); // 4000 + ellipsis line
    expect(pre?.textContent).toContain('…');
  });
});
