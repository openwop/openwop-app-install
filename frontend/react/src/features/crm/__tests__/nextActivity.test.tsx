/**
 * ADR 0837 D8 (ADR 0567 D2) — the deal card's next-activity marker: names the
 * next open task, says plainly when there is none, marks an overdue one as such
 * in TEXT (never colour alone), and compares a date-only due date as a calendar
 * date in the viewer's zone.
 *
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-na-*): dropping the
 * older-backend (`nextTask === undefined`) guard, moving the overdue boundary,
 * putting the due label inside the truncated title, local-midnight date math
 * with `Math.floor`, and a UTC `toISOString()` "today" each turn a case red.
 * The last two only discriminate in a zone WEST of UTC that observes US DST,
 * so the date-math case pins `TZ=America/New_York` itself — on a UTC runner
 * they were vacuous.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n/index.js';
import { NextActivity, daysBetween, localToday } from '../NextActivity.js';

const REAL_TZ = process.env.TZ;
afterEach(() => { if (REAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = REAL_TZ; });

describe('NextActivity', () => {
  it('names the next task and when it is due', () => {
    const { container } = render(<NextActivity today="2026-10-06" deal={{ status: 'open', nextTask: { taskId: 't', title: 'Call back', dueDate: '2026-10-09' } }} />);
    expect(screen.getByText('Next: Call back').getAttribute('title')).toBe('Call back');
    // N5 — the due label sits OUTSIDE the truncated title, so a long title never hides it.
    expect(screen.getByText('Next: Call back').textContent).not.toMatch(/due/);
    expect(container.textContent).toMatch(/due in 3 days/);
  });

  it('says so when there is no next activity', () => {
    render(<NextActivity today="2026-10-06" deal={{ status: 'open', nextTask: null }} />);
    expect(screen.getByText('No next activity')).toBeTruthy();
  });

  it('marks an overdue next task in words', () => {
    const { container } = render(<NextActivity today="2026-10-06" deal={{ status: 'open', nextTask: { taskId: 't', title: 'Send quote', dueDate: '2026-10-05' } }} />);
    expect(screen.getByText('Overdue: Send quote')).toBeTruthy();
    expect(container.textContent).toMatch(/1 day overdue/);
  });

  it('shows nothing on a won or lost deal, or on an older backend (no field)', () => {
    const { container: won } = render(<NextActivity deal={{ status: 'won', nextTask: null }} />);
    expect(won.textContent).toBe('');
    const { container: old } = render(<NextActivity deal={{ status: 'open' }} />);
    expect(old.textContent).toBe('');
  });

  it('date math is calendar-day, DST-proof, and today is LOCAL', () => {
    // Pinned so both checks can fail on ANY runner: New York changes to DST on
    // 2026-03-08 (a local-midnight span is 47 h), and 23:30 there is already
    // the next day in UTC. Node re-reads `TZ` when it is assigned.
    process.env.TZ = 'America/New_York';
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across a US DST change
    expect(localToday(new Date(2026, 0, 2, 23, 30))).toBe('2026-01-02');
  });
});
