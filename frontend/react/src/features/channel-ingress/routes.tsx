/**
 * Channels into chat (ADR 1042, CHAN-P0-8) — the channels settings page.
 *
 * A tab in the Access console beside Connections (`/access?tab=channels`), gated
 * on the `channel-ingress` toggle (default OFF). `workspace` tier like the MCP and
 * API-keys tabs: a person who owns a personal Telegram connection manages its
 * senders without being an admin; the backend's per-connection manage check and
 * workspace write stay the authority. Lazy route-split.
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const ChannelSettingsPage = lazy(() => import('./ChannelSettingsPage.js').then((m) => ({ default: m.ChannelSettingsPage })));

const routes: FeatureRoute[] = [
  {
    path: '/access/channels',
    element: <ChannelSettingsPage />,
    tier: 'workspace', archetype: 'admin',
    hubTab: { group: 'credentials', order: 6, featureId: 'channel-ingress' },
  },
];

export const channelIngressFeature: FrontendFeature = { id: 'channel-ingress', routes };
