/**
 * ADR 0128 Phase 4 — ChartRenderer (untrusted chart DATA → inline SVG via React).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChartRenderer } from '../ChartRenderer.js';

afterEach(cleanup);
const spec = (o: unknown) => JSON.stringify(o);

describe('ChartRenderer', () => {
  it('renders a bar chart as SVG (rects) with React-escaped labels', () => {
    const { container } = render(<ChartRenderer content={spec({ chartType: 'bar', data: { labels: ['A', 'B'], datasets: [{ data: [3, 6] }] } })} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.querySelectorAll('rect').length).toBe(2);
    expect(svg!.textContent).toContain('A');
  });

  it('renders a line chart as a polyline', () => {
    const { container } = render(<ChartRenderer content={spec({ chartType: 'line', data: { labels: ['x', 'y'], datasets: [{ data: [1, 2] }] } })} />);
    expect(container.querySelector('polyline')).not.toBeNull();
  });

  it('DEGRADES to raw for malformed JSON (never throws/blanks)', () => {
    const { container } = render(<ChartRenderer content={'{not json'} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('DEGRADES to raw for an unsupported chartType', () => {
    const { container } = render(<ChartRenderer content={spec({ chartType: 'radar', data: { datasets: [{ data: [1] }] } })} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('never innerHTMLs — a script-ish label is inert SVG text', () => {
    const { container } = render(<ChartRenderer content={spec({ chartType: 'bar', data: { labels: ['<script>x</script>'], datasets: [{ data: [1] }] } })} />);
    expect(container.querySelector('script')).toBeNull(); // escaped, not a real node
  });
});
