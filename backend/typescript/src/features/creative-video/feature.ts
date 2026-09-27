/**
 * Creative-video (ADR 0404 §b) — AI avatar video generation (HeyGen-class). A
 * script/brief → MP4 provider, API-integrated as a workflow node + a creative
 * affordance, landing provenance-stamped assets in `media`. NOT a native video
 * studio, NOT an iframe embed — a `video.generate` node that composes into chains
 * + the chat-drive pattern, cost-metered (ADR 0106 `video`) + replay-safe.
 *
 * RFC gate: host-ext, rides Accepted RFC 0095 + RFC 0120. NO new wire RFC.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §b
 */

import type { BackendFeature } from '../types.js';
import { registerCreativeVideoRoutes } from './routes.js';
import { buildCreativeVideoSurface } from './surface.js';
import { registerVideoMediaCascade } from './videoService.js';

export const creativeVideoFeature: BackendFeature = {
  id: 'creative-video',
  registerRoutes: (deps) => { registerVideoMediaCascade(); registerCreativeVideoRoutes(deps); },
  surface: { id: 'creative-video', build: buildCreativeVideoSurface },
  requiredPacks: [{ name: 'feature.creative-video.nodes', version: '1.1.0' }],
  recommends: ['media', 'connections'],
  toggleDefault: {
    id: 'creative-video',
    label: 'AI Video',
    description:
      'Generate avatar videos from a script or brief through an AI video provider (HeyGen-class) — the job runs async, the result lands as a provenance-stamped asset in your media library, and it composes into workflows and the chat. Cost-metered (the most expensive media kind) and OFF by default; connect the provider under Connections.',
    category: 'Canvas',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'creative-video',
  },
  // ADR 0404 §P4 — text-to-video is a NESTED capability behind its own sub-toggle:
  // the parent (`creative-video`) must be on AND this on for the frontier T2V node/
  // verb to run. OFF by default because provider availability + per-job cost are the
  // open question (it meters a heavier weight against the same daily video budget).
  extraToggleDefaults: [
    {
      id: 'creative-video.t2v',
      label: 'Text-to-video (frontier)',
      description:
        'Generate video directly from a text prompt with a frontier text-to-video model (Runway/Veo/Sora-class), through a governed provider connection. A sub-capability of AI Video: requires AI Video to be on as well. The most expensive generation — metered at a heavier weight against your daily video budget — so it is OFF by default. Connect the provider under Connections.',
      category: 'Canvas',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'creative-video-t2v',
    },
  ],
};
