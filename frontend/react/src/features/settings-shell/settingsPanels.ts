/**
 * The settings panel registry (ADR 0396 §1) — SHELL-OWNED, lazy-importing each
 * panel (the ADR 0375 `allTiles.ts` ruling: per-feature registration calls
 * would cycle `chrome/features ⇄ Page`). A panel that re-surfaces another
 * feature embeds or deep-links that feature's existing component — the shell
 * owns none of their data.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type SettingsGroup = 'general' | 'accessibility' | 'ai' | 'privacy' | 'security' | 'account';

/** Tab order (the ADR 0139 `GROUP_ORDER` twin). */
export const SETTINGS_GROUP_ORDER: readonly SettingsGroup[] = ['general', 'accessibility', 'ai', 'privacy', 'security', 'account'];

export interface SettingsPanel {
  /** Stable key + URL hash (`/settings#a11y`). */
  id: string;
  group: SettingsGroup;
  order: number;
  /** i18n key in the `settings-shell` namespace — never a literal. */
  titleKey: string;
  component: LazyExoticComponent<ComponentType>;
}

export const SETTINGS_PANELS: readonly SettingsPanel[] = [
  { id: 'general', group: 'general', order: 0, titleKey: 'panelGeneral', component: lazy(() => import('./GeneralPanel.js').then((m) => ({ default: m.GeneralPanel }))) },
  { id: 'a11y', group: 'accessibility', order: 0, titleKey: 'panelAccessibility', component: lazy(() => import('./AccessibilityPanel.js').then((m) => ({ default: m.AccessibilityPanel }))) },
  { id: 'budget', group: 'ai', order: 0, titleKey: 'panelBudget', component: lazy(() => import('./BudgetPanel.js').then((m) => ({ default: m.BudgetPanel }))) },
  { id: 'escalation', group: 'ai', order: 1, titleKey: 'panelEscalation', component: lazy(() => import('./EscalationPanel.js').then((m) => ({ default: m.EscalationPanel }))) },
  { id: 'privacy', group: 'privacy', order: 0, titleKey: 'panelPrivacy', component: lazy(() => import('./PrivacyPanel.js').then((m) => ({ default: m.PrivacyPanel }))) },
  // ADR 0389 P1 — Firebase-delegated two-factor auth (`/settings#security`).
  { id: 'security', group: 'security', order: 0, titleKey: 'panelSecurity', component: lazy(() => import('./SecurityPanel.js').then((m) => ({ default: m.SecurityPanel }))) },
  { id: 'account', group: 'account', order: 0, titleKey: 'panelAccount', component: lazy(() => import('./AccountPanel.js').then((m) => ({ default: m.AccountPanel }))) },
];

/** Panels for one group, ordered (the `navGroups()` twin). */
export function panelsForGroup(group: SettingsGroup): SettingsPanel[] {
  return SETTINGS_PANELS.filter((p) => p.group === group).sort((a, b) => a.order - b.order);
}
