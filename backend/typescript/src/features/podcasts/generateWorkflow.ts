/**
 * Multi-speaker podcasts — the `podcasts.generate` built-in workflow (ADR 0086).
 * The WHOLE generation pipeline is one executor RUN (provider calls + TTS are
 * `ctx`-only, so a sync route is architecturally impossible — the same correction
 * ADR 0084/0011 hit). The route ENQUEUES this run; it never calls a model/synth.
 *
 *   select   (feature.podcasts.nodes.select-content)  notebook sources/notes → context
 *      │  context                                      (ctx.features.notebooks)
 *      ▼
 *   outline  (feature.podcasts.nodes.outline)         context → outline document
 *      │  outline                                      (ctx.callAI + ctx.features.documents)
 *      ▼
 *   transcript (feature.podcasts.nodes.transcript)    outline + personas → dialogue document
 *      │  turns                                         (ctx.callAI; multi-speaker, segmentCount)
 *      ▼
 *   synthesize (feature.podcasts.nodes.synthesize)    per-turn TTS → ordered audio clips
 *      │  clips                                         (ctx.callSpeechSynthesizer, RFC 0105)
 *      ▼
 *   mix      (feature.podcasts.nodes.mix)             assemble + persist the clip list on the episode
 *
 * The ONLY run input is `episodeId`; every node resolves the rest authoritatively
 * from ctx.features.podcasts (episode → episodeProfile → speakerProfile), keeping
 * the run record tiny. Each node writes its own result back via
 * ctx.features.podcasts.recordEpisodeResult as it completes (the run is the status
 * SoT; the episode accumulates the durable refs). Replay-safe: the model + TTS calls
 * are recorded in the host invocation log; a fork replays cached output.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

export const PODCASTS_GENERATE_ID = 'podcasts.generate';

const SELECT = 'feature.podcasts.nodes.select-content';
const OUTLINE = 'feature.podcasts.nodes.outline';
const TRANSCRIPT = 'feature.podcasts.nodes.transcript';
const SYNTHESIZE = 'feature.podcasts.nodes.synthesize';
const MIX = 'feature.podcasts.nodes.mix';

export const generateWorkflowDefinition: WorkflowDefinition = {
  workflowId: PODCASTS_GENERATE_ID,
  nodes: [
    { nodeId: 'select', typeId: SELECT, inputs: { episodeId: { type: 'variable', variableName: 'episodeId' } } },
    { nodeId: 'outline', typeId: OUTLINE, inputs: { episodeId: { type: 'variable', variableName: 'episodeId' } }, outputRole: 'secondary' },
    { nodeId: 'transcript', typeId: TRANSCRIPT, inputs: { episodeId: { type: 'variable', variableName: 'episodeId' } }, outputRole: 'secondary' },
    { nodeId: 'synthesize', typeId: SYNTHESIZE, inputs: { episodeId: { type: 'variable', variableName: 'episodeId' } }, outputRole: 'secondary' },
    { nodeId: 'mix', typeId: MIX, inputs: { episodeId: { type: 'variable', variableName: 'episodeId' } }, outputRole: 'primary' },
  ],
  edges: [
    { edgeId: 'e_select_outline', sourceNodeId: 'select', sourceOutput: 'context', targetNodeId: 'outline', targetInput: 'context', triggerRule: 'all_success' },
    { edgeId: 'e_outline_transcript', sourceNodeId: 'outline', sourceOutput: 'outline', targetNodeId: 'transcript', targetInput: 'outline', triggerRule: 'all_success' },
    { edgeId: 'e_transcript_synth', sourceNodeId: 'transcript', sourceOutput: 'turns', targetNodeId: 'synthesize', targetInput: 'turns', triggerRule: 'all_success' },
    { edgeId: 'e_synth_mix', sourceNodeId: 'synthesize', sourceOutput: 'clips', targetNodeId: 'mix', targetInput: 'clips', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'episodeId', type: 'string', description: 'The podcast episode tracking record to generate.', required: true },
  ],
  metadata: { kind: 'meta-workflow', feature: 'podcasts' },
};

export const podcastsBuiltinWorkflows: readonly WorkflowDefinition[] = [generateWorkflowDefinition];
