/**
 * Button + InlineState API contracts (ADR 0510 §4, DSA-013/030).
 * Pins: variant→class mapping is EXACTLY the existing CSS vocabulary (adoption
 * is a no-visual-change refactor); type defaults to "button" (no accidental
 * form submit); loading disables + aria-busy with the label still visible;
 * InlineState failed announces and is never a silent muted paragraph.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Button } from '../Button.js';
import { InlineState, EmptyRow } from '../InlineState.js';

vi.mock('../announce.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../announce.js')>();
  return { ...mod, announce: vi.fn() };
});
import { announce } from '../announce.js';

afterEach(cleanup);

describe('Button', () => {
  it('maps variants onto the existing class vocabulary', () => {
    const { rerender } = render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole('button').className).toBe('');
    rerender(<Button variant="secondary">Go</Button>);
    expect(screen.getByRole('button').className).toBe('secondary');
    rerender(<Button variant="quiet" size="sm">Go</Button>);
    expect(screen.getByRole('button').className).toBe('btn-ghost btn-sm');
    rerender(<Button variant="danger">Go</Button>);
    expect(screen.getByRole('button').className).toBe('secondary u-text-danger');
    rerender(<Button variant="link">Go</Button>);
    expect(screen.getByRole('button').className).toBe('btn-link');
    rerender(<Button variant="accent">Go</Button>);
    expect(screen.getByRole('button').className).toBe('btn-accent');
    rerender(<Button variant="accent-solid" size="sm">Go</Button>);
    expect(screen.getByRole('button').className).toBe('btn-accent-solid btn-sm');
  });

  it('defaults type="button" so a form never submits by accident', () => {
    render(<Button>Go</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).type).toBe('button');
  });

  it('loading disables, sets aria-busy, and keeps the label visible', () => {
    render(<Button variant="primary" loading>Saving…</Button>);
    const b = screen.getByRole('button') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.textContent).toBe('Saving…');
  });

  it('className passthrough appends, never replaces the variant class', () => {
    render(<Button variant="secondary" className="u-self-start">Go</Button>);
    expect(screen.getByRole('button').className).toBe('secondary u-self-start');
  });
});

describe('InlineState', () => {
  it('failed announces assertively and renders the retry action', () => {
    render(<InlineState kind="failed" message="Could not load" announce="Could not load" action={<Button variant="quiet" size="sm">Retry</Button>} />);
    expect(vi.mocked(announce)).toHaveBeenCalledWith('Could not load', { assertive: true });
    expect(screen.getByText('Could not load')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('failed without announce carries role=alert instead (never silent)', () => {
    render(<InlineState kind="failed" message="Could not load" />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('loading is busy and silent; empty is neither alert nor busy', () => {
    const { rerender, container } = render(<InlineState kind="loading" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    rerender(<InlineState kind="empty" message="Nothing yet" />);
    expect(container.querySelector('[role="alert"], [aria-busy]')).toBeNull();
  });

  it('EmptyRow spans the table', () => {
    render(<table><tbody><EmptyRow colSpan={4} kind="empty" message="No rows" /></tbody></table>);
    const td = screen.getByText('No rows').closest('td');
    expect(td?.colSpan).toBe(4);
  });
});
