/**
 * Research Notebooks — the audio/video + YouTube SOURCE-INGEST built-in workflows
 * (ADR 0085 Phases 3–5). Each is a 2-node graph that turns a recording (or a
 * YouTube caption track) into an ordinary notebook KB source as the LIVE output of
 * a real run — the same "read/derive → write" shape as the summarize/transform
 * workflows (ADR 0084), enqueued by the upload ROUTE (never a sync handler, since
 * provider calls + the surface write are `ctx`-only, ADR 0011).
 *
 *   notebooks.ingest-audio:
 *     transcribe (feature.notebooks.nodes.transcribe-source)   audio bytes → transcript
 *          │  transcript                                        (ctx.callAI, RFC 0091 audio)
 *          ▼
 *     ingest (feature.notebooks.nodes.ingest-source)           transcript → KB source
 *                                                              (ctx.features.notebooks.ingestSource)
 *
 *   notebooks.ingest-youtube:
 *     fetch (feature.notebooks.nodes.fetch-youtube-source)      caption track → transcript
 *          │  transcript                                        (ctx.http.safeFetch, RFC 0076)
 *          ▼
 *     ingest (feature.notebooks.nodes.ingest-source)           transcript → KB source
 *
 * Wiring uses the executor port model: the upstream node's `transcript` output feeds
 * the ingest node's `text` input. notebookId/title/sourceType are workflow VARIABLES
 * threaded into the nodes via `{type:'variable'}` (the summarize precedent); the
 * audio bytes (`audioBase64`/`mimeType`) and the `url` ride run inputs the route
 * seeds. Replay-safe: the transcribe model call + the YouTube fetch are recorded in
 * the host invocation log; a fork replays the cached transcript rather than re-calling.
 *
 * The downstream artifact IS a KB document (ADR 0011) — search, citations, and
 * per-source context levels (ADR 0084) all apply unchanged.
 *
 * @see docs/adr/0085-audio-video-source-ingestion.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

export const NOTEBOOKS_INGEST_AUDIO_ID = 'notebooks.ingest-audio';
export const NOTEBOOKS_INGEST_YOUTUBE_ID = 'notebooks.ingest-youtube';

const TRANSCRIBE_SOURCE = 'feature.notebooks.nodes.transcribe-source';
const FETCH_YOUTUBE_SOURCE = 'feature.notebooks.nodes.fetch-youtube-source';
const INGEST_SOURCE = 'feature.notebooks.nodes.ingest-source';

/** Audio/video upload → transcribe (multimodal `callAI`) → ingest as a KB source. */
export const ingestAudioWorkflowDefinition: WorkflowDefinition = {
  workflowId: NOTEBOOKS_INGEST_AUDIO_ID,
  nodes: [
    {
      nodeId: 'transcribe',
      typeId: TRANSCRIBE_SOURCE,
      // provider/model default to google/gemini (audio-capable) inside the node;
      // an operator MAY override via the route → run inputs → node config later.
      inputs: {
        audioBase64: { type: 'variable', variableName: 'audioBase64' },
        mimeType: { type: 'variable', variableName: 'mimeType' },
        language: { type: 'variable', variableName: 'language' },
      },
      outputRole: 'secondary',
    },
    {
      nodeId: 'ingest',
      typeId: INGEST_SOURCE,
      inputs: {
        notebookId: { type: 'variable', variableName: 'notebookId' },
        title: { type: 'variable', variableName: 'title' },
        sourceType: { type: 'variable', variableName: 'sourceType' },
      },
      outputRole: 'primary',
    },
  ],
  edges: [
    { edgeId: 'e_transcribe_ingest', sourceNodeId: 'transcribe', sourceOutput: 'transcript', targetNodeId: 'ingest', targetInput: 'text', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'notebookId', type: 'string', description: 'The notebook the transcribed source is added to.', required: true },
    { name: 'title', type: 'string', description: 'Title for the new source.', required: true },
    { name: 'sourceType', type: 'string', description: 'Provenance label woven into the title (audio|video).', required: false },
    { name: 'audioBase64', type: 'string', description: 'Base64-encoded audio/video bytes to transcribe.', required: true },
    { name: 'mimeType', type: 'string', description: 'MIME type of the audio/video bytes.', required: true },
    { name: 'language', type: 'string', description: 'Optional spoken-language hint (BCP-47 or name).', required: false },
  ],
  metadata: { kind: 'meta-workflow', feature: 'notebooks' },
};

/** YouTube URL → fetch caption track (SSRF-guarded) → ingest as a KB source. */
export const ingestYoutubeWorkflowDefinition: WorkflowDefinition = {
  workflowId: NOTEBOOKS_INGEST_YOUTUBE_ID,
  nodes: [
    {
      nodeId: 'fetch',
      typeId: FETCH_YOUTUBE_SOURCE,
      inputs: {
        url: { type: 'variable', variableName: 'url' },
      },
      outputRole: 'secondary',
    },
    {
      nodeId: 'ingest',
      typeId: INGEST_SOURCE,
      inputs: {
        notebookId: { type: 'variable', variableName: 'notebookId' },
        title: { type: 'variable', variableName: 'title' },
        sourceType: { type: 'variable', variableName: 'sourceType' },
      },
      outputRole: 'primary',
    },
  ],
  edges: [
    { edgeId: 'e_fetch_ingest', sourceNodeId: 'fetch', sourceOutput: 'transcript', targetNodeId: 'ingest', targetInput: 'text', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'notebookId', type: 'string', description: 'The notebook the transcribed source is added to.', required: true },
    { name: 'title', type: 'string', description: 'Title for the new source.', required: true },
    { name: 'sourceType', type: 'string', description: 'Provenance label woven into the title (youtube).', required: false },
    { name: 'url', type: 'string', description: 'The YouTube watch/share URL to fetch captions from.', required: true },
  ],
  metadata: { kind: 'meta-workflow', feature: 'notebooks' },
};
