/**
 * KickTodo Admin & Trust manifest (ADR 0438 A0/A2). Admin-tier surfaces that ride
 * the EXISTING `kicktodo-core` toggle — no new toggle, no new feature-package on
 * the wire. `<AdminLayout>` gates the tier on `isAdminCaller`; the composed
 * backends enforce their own authority. Per the §13 /architect correction this is
 * an additive platform-admin tier, NOT a re-home of the workspace pages.
 */
import { lazy } from 'react';
import { ShieldIcon, InboxIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AdminOverviewPage = lazy(() =>
  import('./AdminOverviewPage.js').then((m) => ({ default: m.AdminOverviewPage })));
const SafetyInboxPage = lazy(() =>
  import('./SafetyInboxPage.js').then((m) => ({ default: m.SafetyInboxPage })));
const CatalogHealthPage = lazy(() =>
  import('./CatalogHealthPage.js').then((m) => ({ default: m.CatalogHealthPage })));
const AuditMetricsPage = lazy(() =>
  import('./AuditMetricsPage.js').then((m) => ({ default: m.AuditMetricsPage })));
const AiConnectionsPage = lazy(() =>
  import('./AiConnectionsPage.js').then((m) => ({ default: m.AiConnectionsPage })));
const AdminPaidChallengesPage = lazy(() => import('./AdminPaidChallengesPage.js').then((m) => ({ default: m.AdminPaidChallengesPage })));
const AdminCommercePage = lazy(() =>
  import('./AdminCommercePage.js').then((m) => ({ default: m.AdminCommercePage })));
const PeopleAccessPage = lazy(() =>
  import('./PeopleAccessPage.js').then((m) => ({ default: m.PeopleAccessPage })));

const routes: FeatureRoute[] = [
  {
    path: '/admin/kicktodo',
    element: <AdminOverviewPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'System operations',
      label: 'KickTodo Trust', labelKey: 'kicktodoTrustLabel',
      icon: ShieldIcon,
      hint: 'KickTodo trust & operations console', hintKey: 'kicktodoTrustHint',
      featureId: 'kicktodo-core',
      notUnder: ['/admin/kicktodo/safety'],
    },
  },
  {
    path: '/admin/kicktodo/safety',
    element: <SafetyInboxPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'System operations',
      label: 'KickTodo Safety', labelKey: 'kicktodoSafetyLabel',
      icon: InboxIcon,
      hint: 'KickTodo safety & approvals queue', hintKey: 'kicktodoSafetyHint',
      featureId: 'kicktodo-core',
    },
  },
  {
    // A3 — catalog & content-health (detail; reached from the console, no nav entry).
    path: '/admin/kicktodo/catalog',
    element: <CatalogHealthPage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    // A7 — audit & metrics (verifier quality + audit-surface link; reached from the console).
    path: '/admin/kicktodo/audit-metrics',
    element: <AuditMetricsPage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    // A6 — AI & connections (honest calendar-write port state; reached from the console).
    path: '/admin/kicktodo/connections',
    element: <AiConnectionsPage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    // A5 — commerce & payouts reconciliation (reached from the console).
    path: '/admin/kicktodo/commerce',
    element: <AdminCommercePage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    // ADR 0420 (admin link surface) — what is for sale: product→challenge links (reached from commerce).
    path: '/admin/kicktodo/commerce/paid-challenges',
    element: <AdminPaidChallengesPage />,
    tier: 'admin', archetype: 'admin',
  },
  {
    // A4 — people & access (read-only aggregate lens; reached from the console).
    path: '/admin/kicktodo/people',
    element: <PeopleAccessPage />,
    tier: 'admin', archetype: 'admin',
  },
];

export const kicktodoAdminFeature: FrontendFeature = { id: 'kicktodo-core', routes };
