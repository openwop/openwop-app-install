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
    path: '/chat-deployment',
    element: <ChatDeploymentHubPage />,
    tier: 'admin',
    nav: {
      group: 'Platform',
      label: 'Chat deployment',
      labelKey: 'chatDeploymentLabel',
      icon: SendIcon,
      hint: 'Run the chat on a schedule, or embed it on your website',
      hintKey: 'chatDeploymentHint',
      order: 6,
      featureId: 'chat-deployment',
    },
  },
];

export const chatDeploymentFeature: FrontendFeature = { id: 'chat-deployment', routes };
