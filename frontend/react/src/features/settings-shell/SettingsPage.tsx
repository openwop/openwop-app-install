/**
 * The consolidated /settings page (ADR 0396 P1) — a tabbed COMPOSITION shell
 * over the panel registry. Tabs are groups (`SETTINGS_GROUP_ORDER`); the URL
 * hash selects a group so `/settings#accessibility` deep-links. The shell owns
 * zero data — panels re-surface their owning features' stores/components.
 */
import { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard, ErrorBoundary } from '../../ui/index.js';
import { Tabs } from '../../ui/Tabs.js';
import { SETTINGS_GROUP_ORDER, panelsForGroup, type SettingsGroup } from './settingsPanels.js';

function groupFromHash(): SettingsGroup {
  const h = window.location.hash.replace('#', '');
  return (SETTINGS_GROUP_ORDER as readonly string[]).includes(h) ? (h as SettingsGroup) : 'general';
}

export function SettingsPage(): JSX.Element {
  const { t } = useTranslation('settings-shell');
  const [group, setGroup] = useState<SettingsGroup>(groupFromHash);

  useEffect(() => {
    const onHash = (): void => setGroup(groupFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (g: SettingsGroup): void => {
    // GRADE-UX 2026-07-17 — replaceState, not a hash assignment: intra-page
    // tab moves must not stack history entries (Back walked through clicks).
    history.replaceState(null, '', `#${g}`);
    setGroup(g);
  };

  return (
    <div data-walkthrough="settings.page" className="page-shell">
      <h1>{t('title')}</h1>
      {/* GRADE-UX 2026-07-17 — the shared APG tablist (roving tabindex, arrow
          keys, aria-controls) instead of a hand-rolled role=tab row. */}
      <Tabs
        items={SETTINGS_GROUP_ORDER.map((g) => ({ id: g, label: t(`group_${g}`) }))}
        value={group}
        onChange={select}
        label={t('title')}
        idBase="settings-tabs"
        panelId="settings-tabpanel"
      />
      <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tabs-tab-${group}`} className="u-grid u-gap-3 u-mt-3">
        {panelsForGroup(group).map((panel) => {
          const Panel = panel.component;
          return (
            <section key={panel.id} id={panel.id} className="surface-card" aria-labelledby={`settings-h-${panel.id}`}>
              <h2 id={`settings-h-${panel.id}`}>{t(panel.titleKey)}</h2>
              <ErrorBoundary resetKey={`${group}:${panel.id}`} label={`settings panel ${panel.id}`}>
                <Suspense fallback={<StateCard loading title={t('loadingPanel')} />}>
                  <Panel />
                </Suspense>
              </ErrorBoundary>
            </section>
          );
        })}
      </div>
    </div>
  );
}
