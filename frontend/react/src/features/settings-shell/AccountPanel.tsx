/**
 * Account panel (ADR 0396 P1) — deep-links only. Every destination keeps its
 * owning feature, route, and gate; the panel adds discovery, never machinery.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const LINKS: Array<{ to: string; titleKey: string; hintKey: string }> = [
  { to: '/profile', titleKey: 'accountProfile', hintKey: 'accountProfileHint' },
  { to: '/keys', titleKey: 'accountKeys', hintKey: 'accountKeysHint' },
  { to: '/example-data', titleKey: 'accountExampleData', hintKey: 'accountExampleDataHint' },
  { to: '/', titleKey: 'accountDashboard', hintKey: 'accountDashboardHint' },
];

export function AccountPanel(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  return (
    <div className="card-grid">
      {LINKS.map((l) => (
        <article key={l.to} className="surface-card">
          <h3><Link to={l.to}>{t(l.titleKey)}</Link></h3>
          <p>{t(l.hintKey)}</p>
        </article>
      ))}
    </div>
  );
}
