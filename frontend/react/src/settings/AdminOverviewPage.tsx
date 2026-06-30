import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ADMIN_NAV_GROUPS, FEATURES } from '../chrome/features.js';
import { useFeatureVisible } from '../featureToggles/FeatureAccessContext.js';
import { PageHeader } from '../ui/PageHeader.js';

/**
 * Admin home (`/admin`) — the landing surface behind the workspace rail's
 * single "Admin" entry. The card grid derives from the feature manifest's
 * admin tier, so a newly-declared admin feature appears here (and in the
 * embedded rail) with zero edits to this file.
 */
export function AdminOverviewPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const isVisible = useFeatureVisible();
  // ADR 0144/0145 — keep the grid consistent with each consolidation console:
  // hide a console's own tile until its toggle is enabled, and hide the tiles it
  // subsumes once it is (so the index never lists both the console and its
  // sub-pages). Scoped to the consoles only — every other tile keeps the page's
  // show-all-admin behavior. An id with no registered feature resolves
  // not-visible and the loop no-ops, so this list is forgiving of ordering.
  // access-hub graduated to always-on (ADR 0144 §Correction 2026-06-26): no toggle,
  // and its subsumed surfaces dropped their nav — the static grid already shows only
  // the hub tile, so it needs no entry here. Models/chat-deployment stay gated.
  const CONSOLE_IDS = ['models', 'chat-deployment'];
  const hidden = new Set<string>(['/admin']);
  for (const id of CONSOLE_IDS) {
    const route = FEATURES.find((f) => f.nav?.featureId === id);
    if (!isVisible(id)) {
      if (route) hidden.add(route.path);
    } else {
      for (const f of FEATURES) if (f.nav?.hiddenWhenFeature === id) hidden.add(f.path);
    }
  }
  const groups = ADMIN_NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((item) => !hidden.has(item.to)) }))
    .filter((g) => g.items.length > 0);
  return (
    <section className="admin-overview">
      <PageHeader
        eyebrow={t('adminEyebrow')}
        title={t('adminTitle')}
        lede={t('adminLede')}
      />
      {groups.map((group) => (
        <div key={group.label}>
          <h3 className="admin-overview-group">{group.label}</h3>
          <div className="admin-overview-grid">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.to} to={item.to} className="surface-card admin-overview-card">
                  <span className="admin-overview-icon" aria-hidden><Icon size={20} /></span>
                  <span className="admin-overview-meta">
                    <span className="admin-overview-label">{item.label}</span>
                    <span className="admin-overview-hint">{item.hint}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
