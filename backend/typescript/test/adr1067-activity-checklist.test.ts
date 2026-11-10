/**
 * ADR 1067 D3 — server half of the checklist activity card.
 *
 *   - `style` is a closed enum: `checklist` is kept, anything else leaves no
 *     key, so a card that sets none is byte-identical;
 *   - `barLabel` is capped content like the title; a row keeps an `icon` slug;
 *   - crawlers read the bar's words first, then the title and the rows.
 *
 * Sabotage witnesses (each re-measured red, /grade-tests wave 95): widening the
 * style enum, defaulting the style to `checklist`, dropping or uncapping
 * `barLabel` or dropping `icon` in the validator, and putting the bar's words
 * after the title in either prerender.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const row = { actor: 'Sign-in', action: 'Accounts, passwords', status: 'Done', state: 'done', icon: 'lock' };
const hero = (activity: Record<string, unknown>): Section => validateSection({ type: 'hero', data: { heading: 'Your app', visual: 'activity', activity } });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const activityOf = (s: Section): Record<string, unknown> => {
  const a = s.data.activity;
  if (!isRecord(a)) throw new Error('no activity card');
  return a;
};

describe('checklist activity card (ADR 1067 D3)', () => {
  it('keeps the checklist style, the bar words and each row\'s icon', () => {
    const a = activityOf(hero({ style: 'checklist', barLabel: 'your-app.com · launch checklist', title: 'The business', items: [row] }));
    expect(a).toEqual({ style: 'checklist', barLabel: 'your-app.com · launch checklist', title: 'The business', items: [row] });
  });

  it('drops a style outside its set, and sets none by default', () => {
    expect('style' in activityOf(hero({ style: 'fancy', items: [row] }))).toBe(false);
    expect('style' in activityOf(hero({ items: [row] }))).toBe(false);
    expect(activityOf(hero({ barLabel: 'x'.repeat(200), items: [row] })).barLabel).toHaveLength(80);
  });

  it('reads the bar\'s words first for crawlers', () => {
    const s = hero({ style: 'checklist', barLabel: 'your-app.com', title: 'The business', items: [row], result: 'Live' });
    expect(sectionHtml(s, OPTS)).toMatch(/<figure>\n<p><small>your-app\.com<\/small><\/p>\n<p><strong>The business<\/strong><\/p>/);
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('your-app.com\n\n**The business**');
  });
});
