/**
 * Multi-speaker AI podcasts (ADR 0086) — a NotebookLM-style audio-overview studio
 * built entirely by COMPOSING existing seams (notebooks + Documents + Media +
 * Connections + the executor run model + scheduler + chat), never forking them
 * (MEMORY.md no-parallel-architecture law). The feature owns only two reusable
 * config entities (EpisodeProfile + SpeakerProfile) and a thin PodcastEpisode
 * tracking record; the executor RUN of the `podcasts.generate` workflow is the real
 * state machine.
 *
 * Differentiator vs NotebookLM's fixed two-host format: 1–4 configurable speakers,
 * each with its own voice + persona.
 *
 * All three FeatureModule faces ship (ADR 0014): the REST routes, the
 * `ctx.features.podcasts` workflow surface, and the `feature.podcasts.{nodes,agents}`
 * packs. The synthesize node rides RFC 0105 (`ctx.callSpeechSynthesizer`) — Accepted
 * and wired on this host (`aiProviders.speechSynthesis: supported`).
 *
 * Tenant-bucketed, OFF by default (a shared B2B audio-generation surface). Wired by
 * appending to BACKEND_FEATURES (features/index.ts) — zero core edits.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import type { BackendFeature } from '../types.js';
import { registerPodcastsRoutes } from './routes.js';
import { buildPodcastsSurface } from './surface.js';
import { podcastsBuiltinWorkflows } from './generateWorkflow.js';

export const podcastsFeature: BackendFeature = {
  id: 'podcasts',
  registerRoutes: (deps) => registerPodcastsRoutes(deps),
  // ctx.features.podcasts (ADR 0014) — read the cast/show-format profiles + the
  // episode being generated, and the one write-back the pipeline's nodes make to
  // record outline/transcript Document refs + the ordered synthesized clips.
  surface: { id: 'podcasts', build: buildPodcastsSurface },
  // The `podcasts.generate` built-in workflow (select → outline → transcript →
  // synthesize → mix), resolved in catalog source A and enqueued by the create route.
  builtinWorkflows: podcastsBuiltinWorkflows,
  toggleDefault: {
    id: 'podcasts',
    label: 'Podcasts',
    description:
      'Turn a research notebook into a multi-speaker narrated audio episode. Define reusable show-format and cast profiles (1–4 speakers, each with a voice + persona), then generate an episode: an executor run drafts an outline + a multi-speaker transcript (Documents), voices each turn via the RFC 0105 speech-synthesis adapter, and assembles the ordered audio clips. Schedulable (a weekly digest podcast). OFF by default; tenant-bucketed.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'podcasts',
  },
  requiredPacks: [
    // The generation pipeline (outline / transcript / synthesize (RFC 0105) / mix /
    // select-content over ctx.features.{podcasts,notebooks,documents}).
    { name: 'feature.podcasts.nodes', version: '1.0.0' },
    // The optional Podcast Producer agent (chat-drivability = agent + nodes, ADR 0058).
    { name: 'feature.podcasts.agents', version: '1.0.0' },
  ],
};
