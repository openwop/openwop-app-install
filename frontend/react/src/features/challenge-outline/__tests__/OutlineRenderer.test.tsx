/**
 * OutlineRenderer tests (ADR 0458 §2.3) — the ONE read surface must show the
 * challenge header, its days, and each day's evidence/effort/alternatives, and
 * must never throw on malformed content (it coerces defensively).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OutlineRenderer } from '../OutlineRenderer.js';

afterEach(cleanup);

const content = JSON.stringify({
  meta: { title: 'Sleep reset', promise: 'Sleep better in two weeks', audience: 'busy adults', durationDays: 14, dailyMinutesBudget: 20, depthLevel: 'beginner' },
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Wake refreshed', method: 'Sleep diary' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'Logged 7h sleep', outcomeIds: ['o1'] }],
  frames: [{ id: 'outline', name: 'Outline', days: [
    { type: 'day', props: { day: 1, stableActivityId: 'd1', title: 'Wind down', actionInstruction: 'Dim the lights', userFacingWhy: 'Melatonin rises in the dark', estimatedMinutes: 10, evidencePolicy: 'note', achievementIds: ['a1'], isRecovery: true }, children: [
      { type: 'alternative', props: { stableActivityId: 'd1-alt', title: 'Read instead', actionInstruction: 'Read a paper book', evidencePolicy: 'note' } },
    ] },
  ] }],
});

describe('OutlineRenderer', () => {
  it('renders the challenge header, the day, and its alternative', () => {
    render(<OutlineRenderer content={content} />);
    expect(screen.getByText('Sleep reset')).toBeTruthy();
    expect(screen.getByText('Sleep better in two weeks')).toBeTruthy();
    expect(screen.getByText('Wind down')).toBeTruthy();
    expect(screen.getByText('Melatonin rises in the dark')).toBeTruthy();
    expect(screen.getByText('Dim the lights')).toBeTruthy();
    // The recovery flag + evidence chip render as their localized labels.
    expect(screen.getByText('Recovery')).toBeTruthy();
    expect(screen.getByText('Read instead')).toBeTruthy();
    // Outcomes + achievements context.
    expect(screen.getByText('Wake refreshed')).toBeTruthy();
    // The evidence text appears in the achievements checklist AND resolved on
    // the day's achievement chip (screen-polish: ids never face the creator).
    expect(screen.getAllByText('Logged 7h sleep').length).toBeGreaterThanOrEqual(2);
  });

  it('never throws on malformed content — falls back to an empty outline', () => {
    render(<OutlineRenderer content={'not json'} />);
    expect(screen.getByText('Untitled challenge')).toBeTruthy();
  });
});
