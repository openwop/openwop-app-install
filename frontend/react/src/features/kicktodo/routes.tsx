/**
 * KickTodo frontend feature (ADR 0414 P5) — route + nav manifest. Today is
 * the product's default answer to "what should I do?"; Discover is the
 * catalog. Pages are lazy chunks; `featureId: 'kicktodo-core'` gates nav on
 * the server-authoritative toggle. "Ask your guide" deep-links the ONE shared
 * chat (`/?agent=host:kickbot`) — no second chat surface.
 */
import { lazy } from 'react';
import { ActivityIcon, CalendarIcon, CheckSquareIcon, FlagIcon, SparklesIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const TodayPage = lazy(() => import('./TodayPage.js').then((m) => ({ default: m.TodayPage })));
const DiscoverPage = lazy(() => import('./DiscoverPage.js').then((m) => ({ default: m.DiscoverPage })));
const ChallengeDetailPage = lazy(() => import('./ChallengeDetailPage.js').then((m) => ({ default: m.ChallengeDetailPage })));
const GuidePage = lazy(() => import('./GuidePage.js').then((m) => ({ default: m.GuidePage })));
const ProgressPage = lazy(() => import('./ProgressPage.js').then((m) => ({ default: m.ProgressPage })));
const JournalPage = lazy(() => import('./JournalPage.js').then((m) => ({ default: m.JournalPage })));
const PlanPage = lazy(() => import('./PlanPage.js').then((m) => ({ default: m.PlanPage })));

const routes: FeatureRoute[] = [
  {
    path: '/today',
    element: <TodayPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Today', labelKey: 'navTodayLabel',
      icon: CheckSquareIcon,
      hint: 'Your due KickTodo actions', hintKey: 'navTodayHint',
      order: 10,
      featureId: 'kicktodo-core',
    },
  },
  {
    // Plan (ADR 0443 R3 / ADR 0436 §5.5) — the cross-challenge week view.
    path: '/plan',
    element: <PlanPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Plan', labelKey: 'navPlanLabel',
      icon: CalendarIcon,
      hint: 'Your week across challenges', hintKey: 'navPlanHint',
      order: 15,
      featureId: 'kicktodo-core',
    },
  },
  {
    path: '/discover',
    element: <DiscoverPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Discover', labelKey: 'navDiscoverLabel',
      icon: FlagIcon,
      hint: 'Browse guided challenges', hintKey: 'navDiscoverHint',
      order: 20,
      featureId: 'kicktodo-core',
    },
  },
  // Challenge detail (ADR 0436 §5.4) — the commitment preview + enroll; not a nav
  // destination, so no `nav` (reached from a Discover card).
  {
    path: '/discover/:challengeId',
    element: <ChallengeDetailPage />,
    tier: 'site', archetype: 'detail',
  },
  // Journal (ADR 0443 R5) — the participant's own notes; reached from Progress, no nav.
  {
    path: '/journal',
    element: <JournalPage />,
    tier: 'site', archetype: 'standard-index',
  },
  // Progress (ADR 0436 §5.6) — transformation/consistency/evidence, not volume.
  {
    path: '/progress',
    element: <ProgressPage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Progress', labelKey: 'navProgressLabel',
      icon: ActivityIcon,
      hint: 'How your challenges are going', hintKey: 'navProgressHint',
      order: 30,
      featureId: 'kicktodo-core',
    },
  },
  // Guide (ADR 0436 §5.8) — the named-KickBot landing; deep-links the ONE shared chat.
  {
    path: '/guide',
    element: <GuidePage />,
    tier: 'site', archetype: 'standard-index',
    nav: {
      group: 'KickTodo',
      label: 'Guide', labelKey: 'navGuideLabel',
      icon: SparklesIcon,
      hint: 'Your named KickBot', hintKey: 'navGuideHint',
      order: 50,
      featureId: 'kicktodo-core',
    },
  },
];

export const kicktodoFeature: FrontendFeature = { id: 'kicktodo-core', routes };
