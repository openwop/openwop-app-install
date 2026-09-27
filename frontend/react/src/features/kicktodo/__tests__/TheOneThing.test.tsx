/**
 * KickTodo Today logic (ADR 0436) — the load-bearing correctness the grade-code
 * pass flagged as untested (KTEXP-4): the time-of-day mapping and, most
 * importantly, the evidence-gating (KTFULL-B6) that must NEVER let a check-in
 * fire without the evidence the server enforces.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { washPosition, daypartOf, ActionCompleter } from '../TheOneThing.js';
import type { TodayAction } from '../../../client/kicktodoClient.js';

afterEach(cleanup);

const action = (policy: string, completed = false): TodayAction => ({
  occurrence: { cardId: 'c1', stableActivityId: 'a1', occurrenceDateLocal: '2026-07-19', evidencePolicy: policy },
  card: { id: 'c1', title: 'Do the thing', columnId: 'todo', completed },
  checkIn: null,
});

describe('washPosition / daypartOf', () => {
  it('maps the local hour to a daypart and a wash anchor at the boundaries', () => {
    expect(daypartOf(0)).toBe('morning');
    expect(daypartOf(11)).toBe('morning');
    expect(daypartOf(12)).toBe('afternoon');
    expect(daypartOf(17)).toBe('afternoon');
    expect(daypartOf(18)).toBe('evening');
    expect(daypartOf(23)).toBe('evening');
    expect(washPosition(8)).toBe('18%');
    expect(washPosition(14)).toBe('50%');
    expect(washPosition(20)).toBe('82%');
  });
});

describe('ActionCompleter evidence-gating (KTFULL-B6)', () => {
  const btn = () => screen.getByRole('button');

  it('attestation completes in one tap — no input, no evidence', () => {
    const onComplete = vi.fn();
    render(<ActionCompleter action={action('attestation')} busy={false} onComplete={onComplete} />);
    expect(btn().hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn());
    expect(onComplete).toHaveBeenCalledWith('c1');
  });

  it('note stays disabled until a note is typed, then submits it', () => {
    const onComplete = vi.fn();
    render(<ActionCompleter action={action('note')} busy={false} onComplete={onComplete} />);
    expect(btn().hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'went well' } });
    expect(btn().hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn());
    expect(onComplete).toHaveBeenCalledWith('c1', { note: 'went well' });
  });

  it('measurement stays disabled until a finite number is entered', () => {
    const onComplete = vi.fn();
    render(<ActionCompleter action={action('measurement')} busy={false} onComplete={onComplete} />);
    expect(btn().hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '42' } });
    expect(btn().hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn());
    expect(onComplete).toHaveBeenCalledWith('c1', { measuredValue: 42 });
  });

  it('photo rides the note field and gates on it (the backend contract)', () => {
    const onComplete = vi.fn();
    render(<ActionCompleter action={action('photo')} busy={false} onComplete={onComplete} />);
    expect(btn().hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://ref/photo' } });
    fireEvent.click(btn());
    expect(onComplete).toHaveBeenCalledWith('c1', { note: 'https://ref/photo' });
  });

  it('a completed action shows a done badge and no completion button', () => {
    render(<ActionCompleter action={action('attestation', true)} busy={false} onComplete={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
