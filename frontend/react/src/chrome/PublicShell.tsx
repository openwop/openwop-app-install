/**
 * Public shell (ADR 0027). A bare chrome for the anonymous CMS-driven front page:
 * brand header + sign-in, the page body, and the footer — NO Sidebar, NO admin
 * rail, NO auth gate. Rendered by App.tsx ABOVE <AppGate> so the marketing page
 * stays reachable even when a deployment runs a sign-in / password gate.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBrand } from '../brand/BrandProvider.js';
import { SignInButton } from '../auth/SignInButton.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';

export function PublicShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation('chrome');
  const brand = useBrand(); // live runtime brand (ADR 0170)
  return (
    <div className="public-shell">
      <a className="skip-link" href="#public-main">{t('common:skipToContent')}</a>
      <header className="public-shell-header action-bar">
        <Link to="/" className="public-shell-brand">
          {brand.logoSrc ? <img src={brand.logoSrc} alt="" className="public-shell-logo" /> : null}
          <span className="app-gate-product">{brand.productName}</span>
        </Link>
        <div className="action-bar">
          <ThemeToggle />
          <a className="chip" href="https://openwop.dev" rel="noopener noreferrer">{t('readTheSpec')}</a>
          <Link className="chip" to="/chat">{t('exploreTheDemo')}</Link>
          <SignInButton />
        </div>
      </header>
      <main id="public-main" className="public-shell-main">
        {children}
      </main>
      <footer className="app-footer">
        {brand.footerText} ·{' '}
        <Link to="/privacy">{t('common:privacy')}</Link>
      </footer>
    </div>
  );
}
