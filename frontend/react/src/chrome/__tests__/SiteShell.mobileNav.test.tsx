import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType } from 'react';

const Icon: ComponentType<{ size?: number }> = () => <svg aria-hidden="true" />;
const items = [
  { to: '/today', label: 'Today', icon: Icon, hint: '' },
  { to: '/plan', label: 'Plan', icon: Icon, hint: '' },
  { to: '/discover', label: 'Discover', icon: Icon, hint: '' },
  { to: '/progress', label: 'Progress', icon: Icon, hint: '' },
  { to: '/circles', label: 'Circles', icon: Icon, hint: '' },
  { to: '/leaderboard', label: 'Leaderboard', icon: Icon, hint: '' },
  { to: '/guide', label: 'Guide', icon: Icon, hint: '' },
];

vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ workspace: [], admin: [], site: [{ id: 'KickTodo', label: 'KickTodo', items }] }),
}));
vi.mock('../../brand/BrandProvider.js', () => ({
  useBrand: () => ({ productName: 'KickTodo', logoSrc: '/mark.svg', markSrcDark: '', footerText: '' }),
}));
vi.mock('../../brand/BrandLogo.js', () => ({ BrandLogo: () => <svg aria-hidden="true" /> }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => <button type="button">Sign in</button> }));
vi.mock('../../ui/ThemeToggle.js', () => ({ ThemeToggle: () => <button type="button">Theme</button> }));
vi.mock('../../i18n/LanguageSwitcher.js', () => ({ LanguageSwitcher: () => <select aria-label="Language" /> }));

const { SiteShell } = await import('../SiteShell.js');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SiteShell mobile navigation', () => {
  it('keeps the five repeat-use destinations in product order and moves the rest into More', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/today']}>
        <SiteShell><p>Page</p></SiteShell>
      </MemoryRouter>,
    );

    const primary = container.querySelector('.site-mobile-nav__primary');
    expect(primary).toBeTruthy();
    expect(Array.from(primary?.querySelectorAll('a') ?? []).map((link) => link.getAttribute('href')))
      .toEqual(['/today', '/discover', '/plan', '/progress', '/guide']);
    expect(primary?.querySelector('a[href="/today"]')?.classList.contains('is-active')).toBe(true);

    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    const panel = container.querySelector('.site-mobile-nav__panel');
    expect(Array.from(panel?.querySelectorAll('a') ?? []).map((link) => link.getAttribute('href')))
      .toEqual(['/circles', '/leaderboard']);
    const firstPanelLink = panel?.querySelector<HTMLElement>('a');
    const language = panel?.querySelector<HTMLElement>('select');
    expect(document.activeElement).toBe(firstPanelLink);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(language);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstPanelLink);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.site-mobile-nav__panel')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(more);
    expect(screen.getByText('Today page')).toBeTruthy();
  });

  it('marks More active when the current destination lives in its disclosure', () => {
    render(
      <MemoryRouter initialEntries={['/circles']}>
        <SiteShell><p>Page</p></SiteShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'More' }).classList.contains('is-active')).toBe(true);
  });
});
