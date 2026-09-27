/**
 * Chat deployment console (ADR 0145) — route + nav fragment.
 *
 * One admin destination (`/chat-deployment`) consolidating Scheduled runs +
 * Website widget into a tabbed console. The page PROJECTS its tabs from the
 * FEATURES manifest, so this module stays tiny: a lazy page + a single nav entry,
 * gated on the `chat-deployment` toggle (default OFF, bucket `tenant`).
 *
 * IMPORTANT: do NOT import `FEATURES` here — `routes.tsx` is evaluated while the
 * manifest is still being composed, so a static import would cycle. The page
 * reads the manifest at render time via its lazy import (see ChatDeploymentHubPage).
 */
import { lazy } from 'react';
import { SendIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ChatDeploymentHubPage = lazy(() =>
  import('./ChatDeploymentHubPage.js').then((m) => ({ default: m.ChatDeploymentHubPage })),
);

const routes: FeatureRoute[] = [
  {
    // ADR 0610 D6 (CDC-2) — the console subsumes scheduled-agent-chats + chat-widget, both
    // `workspace:write` on the backend (their sole authority), so it relocates to the workspace
    // rail: `workspace`-tier not `admin`, the workspace index archetype (the `admin` archetype means
    // "on the admin rail", featureTypes.ts), and nav.group `Workspace` (`Platform` is admin-only).
    // NB this rationale sits ABOVE `path:` on purpose — a comment between path: and nav: pushes the
    // path→nav distance past the walkthrough anchor-coverage scanner's 600-char window
    // (anchorCoverage.test.ts), silently dropping this route from that ratchet.
    path: '/chat-deployment',
    element: <ChatDeploymentHubPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Workspace',
      label: 'Always-on chat',
      labelKey: 'chatDeploymentLabel',
      icon: SendIcon,
      hint: 'Schedule it, or put it on your website',
      hintKey: 'chatDeploymentHint',
      order: 6,
      featureId: 'chat-deployment',
    },
  },
];

export const chatDeploymentFeature: FrontendFeature = { id: 'chat-deployment', routes };
