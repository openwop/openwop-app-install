/**
 * ADR 1112 grade residue (2026-11-13), the editor and the public section.
 *
 * Pins:
 *  - the byte and AI refusals map to cms catalog keys off `details.reason`, with the sizes in
 *    kB, so a localized editor never shows the server's English (UXG-1112-12);
 *  - the cost of delay is in the section's `currency`, USD when it has none, and the
 *    carrying-cost label shows that currency's symbol (UXG-1112-7);
 *  - a decision row in an open cell names its milestone; a row in the milestone panel does
 *    not repeat it (UXG-1112-8).
 *
 * Sabotage, each restored, each red: return null for `section_too_large`; read the blockers'
 * rule as always 'todo'; hard-code 'USD'; pass `inCell` as false.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { CmsApiError, cmsErrorInfo, type Section } from '../cmsClient.js';

afterEach(cleanup);

describe('UXG-1112-12 — size and AI refusals are keyed, not English', () => {
  const err = (code: string, details: Record<string, unknown>) => new CmsApiError('English from the server', code, 400, details);
  it('maps each reason to its key, with kB', () => {
    expect(cmsErrorInfo(err('validation_error', { reason: 'section_too_large', bytes: 912_345, limit: 850_000 }))).toEqual({ key: 'errSectionTooLarge', options: { kb: 913, limit: 850 } });
    expect(cmsErrorInfo(err('validation_error', { reason: 'page_too_large', bytes: 1_000_001, limit: 975_000 }))).toEqual({ key: 'errPageTooLarge', options: { kb: 1001, limit: 975 } });
    expect(cmsErrorInfo(err('validation_error', { reason: 'publish_blocked', blockers: [{ rule: 'too_large', bytes: 1_070_000, limit: 975_000 }] }))).toEqual({ key: 'errPublishTooLarge', options: { kb: 1070, limit: 975 } });
    expect(cmsErrorInfo(err('validation_error', { reason: 'publish_blocked', blockers: [{ rule: 'todo', sectionId: 'sec:a' }] }))).toEqual({ key: 'errPublishBlocked' });
    // ADR 1112 Phase E — a shared-section edit refused for the published page it would grow.
    expect(cmsErrorInfo(err('validation_error', { reason: 'publish_blocked', pageTitle: 'Live schedules', blockers: [{ rule: 'too_large', bytes: 1_070_000, limit: 975_000 }] }))).toEqual({ key: 'errSharedGrowsPage', options: { kb: 1070, limit: 975, title: 'Live schedules' } });
    expect(cmsErrorInfo(err('validation_error', { reason: 'too_large' }))).toEqual({ key: 'errAiTooLarge' });
    expect(cmsErrorInfo(err('translation_invalid', { reason: 'too_large' }))).toEqual({ key: 'errAiTooLarge' });
    expect(cmsErrorInfo(err('translation_invalid', { reason: 'timeout' }))).toEqual({ key: 'errAiTimeout' });
    expect(cmsErrorInfo(err('rewrite_invalid', { reason: 'timeout' }))).toEqual({ key: 'errAiTimeout' });
    expect(cmsErrorInfo(err('translation_invalid', {}))).toEqual({ key: 'translateInvalid' });
    expect(cmsErrorInfo(err('validation_error', { field: 'title' }))).toBeNull(); // a field refusal keeps its own words
  });
});

const show = (data: Record<string, unknown>) => render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data } as Section} mode="public" /></MemoryRouter>);
const milestones = [
  { id: 'm1', label: 'Design lock', startWeek: 0, weeks: 4, floatDays: 0 },
  { id: 'm2', label: 'Rough-in', startWeek: 4, weeks: 4, floatDays: 0 },
];
const decisions = [
  { id: 'a', title: 'Tile', milestone: 'm1', lockWeek: 2, phase: 'design', category: 'rooms' },
  { id: 'b', title: 'Tap', milestone: 'm2', lockWeek: 6, phase: 'design', category: 'rooms' },
];

describe('UXG-1112-7 — the cost of delay currency', () => {
  const carryCost = (currency?: string): string => {
    show({ startDate: '2027-01-04', milestones, decisions, ...(currency ? { currency } : {}) });
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Tile' }), { target: { value: '14' } });
    const input = document.querySelector('.fp-psim__carry input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1000' } });
    return `${document.querySelector('.fp-psim__carry span')?.textContent} = ${document.querySelectorAll('.fp-psim__v')[document.querySelectorAll('.fp-psim__v').length - 1]?.textContent}`;
  };
  it('reads the section currency, else USD', () => {
    expect(carryCost('EUR')).toMatch(/\(€\) = .*€/);
    cleanup();
    expect(carryCost()).toMatch(/\(\$\) = \$/);
  });
});

describe('UXG-1112-8 — a cell row names its milestone', () => {
  it('the open cell says which milestone each decision is in', () => {
    show({ startDate: '2027-01-04', phases: [{ key: 'design', label: 'Design' }], categories: [{ key: 'rooms', label: 'Rooms' }], milestones, decisions });
    fireEvent.click(screen.getByRole('button', { name: /^Design, Rooms: 2 decisions/ }));
    const cell = document.querySelectorAll('.fp-psim__cells .fp-psim__detail')[0] as Element;
    const metas = [...cell.querySelectorAll('.fp-psim__meta')].map((m) => m.textContent ?? '');
    expect(metas[0]).toMatch(/^For Design lock/);
    expect(metas[1]).toMatch(/^For Rough-in/);
    for (const m of document.querySelectorAll('.fp-psim__decision .fp-psim__meta')) {
      if (!cell.contains(m)) expect(m.textContent).not.toMatch(/^For /);
    }
  });
});
