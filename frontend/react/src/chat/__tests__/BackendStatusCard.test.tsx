/**
 * ADR 0768 follow-up C1 — pin the backend-status card BEFORE any restyle.
 *
 * It had no test. Its contract (ADR 0517): one card that evolves — a warm/cold
 * guess from the last-success cache, "still waking" after 25 s, "resting" after
 * 40 s or on an error — and an outage is NEVER a key prompt (a user with a
 * working key must not be sent to re-enter it because the backend is asleep).
 */
import { render, screen, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const warm = vi.hoisted(() => ({ value: false }));
vi.mock('../../devtools/lastSuccess.js', () => ({ predictWarm: () => warm.value }));

import { BackendStatusCard } from '../BackendStatusCard.js';

beforeEach(() => { vi.useFakeTimers(); warm.value = false; });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('BackendStatusCard (ADR 0517 state machine)', () => {
  it('starts from the warm/cold guess', () => {
    warm.value = true;
    const { unmount } = render(<BackendStatusCard />);
    expect(screen.getByRole('heading').textContent).toContain('backendLoading');
    unmount();
    warm.value = false;
    render(<BackendStatusCard />);
    expect(screen.getByRole('heading').textContent).toContain('backendWaking');
  });

  it('escalates to "still waking" at 25 s and "resting" at 40 s, with technical detail', () => {
    render(<BackendStatusCard backendUrl="https://api.example" />);
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(screen.getByRole('heading').textContent).toContain('backendStillWaking');
    expect(screen.queryByText('technicalDetail')).toBeNull();
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByRole('heading').textContent).toContain('backendResting');
    expect(screen.getByText('technicalDetail')).toBeTruthy();
    expect(screen.getByText('https://api.example')).toBeTruthy();
  });

  it('an error is "resting" at once and shows the error — never a key prompt', () => {
    render(<BackendStatusCard error="ECONNREFUSED" />);
    expect(screen.getByRole('heading').textContent).toContain('backendResting');
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/apiKey|byokWizard|enterKey|addKey/i);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
