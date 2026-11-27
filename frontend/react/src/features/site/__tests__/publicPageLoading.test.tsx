/**
 * Public CMS pages load inside the page's own full-height box.
 *
 * A short loading strip let the site footer sit in view at load and then jump
 * off-screen when the content arrived: one layout shift of 0.12–0.14 on
 * app.openwop.dev (`/` and `/p/features`, 2026-11-27), and the largest CLS
 * source an adopter measured on its public site.
 *
 * Pinned:
 * - the shared loading state renders `.cms-public-page.cms-public-page--loading`
 *   holding the labelled status region, and the stylesheet gives that class a
 *   full-viewport min-height;
 * - no public page under features/site builds its own loading block again.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PublicPageLoading } from '../PublicPageLoading.js';

afterEach(cleanup);

const SITE = resolve(__dirname, '..');
const CSS = resolve(__dirname, '../../../styles/global.css');

describe('public page loading state', () => {
  it('renders the status region inside the full-height page box', () => {
    render(<PublicPageLoading />);
    const status = screen.getByRole('status');
    const box = status.parentElement;
    expect(box?.classList.contains('cms-public-page')).toBe(true);
    expect(box?.classList.contains('cms-public-page--loading')).toBe(true);
  });

  it('the stylesheet holds the loading box at a full viewport', () => {
    const css = readFileSync(CSS, 'utf8');
    expect(css).toMatch(/\.cms-public-page--loading\s*\{[^}]*min-height:\s*100svh/);
  });

  it('no public page renders its own Skeleton status block', () => {
    const offenders = readdirSync(SITE)
      .filter((f) => f.endsWith('.tsx') && f !== 'PublicPageLoading.tsx')
      .filter((f) => /role="status"[^\n]*<Skeleton/.test(readFileSync(join(SITE, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
