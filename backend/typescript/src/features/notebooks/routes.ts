/**
 * Research Notebooks routes (ADR 0084) — host-extension, toggle-gated on
 * `notebooks` (backend authority — 404 when off, like every feature package).
 *
 * A notebook IS a project Subject (`facet:'notebook'`), so the RBAC + IDOR model
 * is the project model, reused verbatim: the caller's access is resolved through
 * `resolveProjectAccess` (org authority composed with the project's visibility/
 * members, ADR 0054 D5). Write needs `workspace:write` in the notebook's org;
 * read needs `workspace:read`. A foreign-tenant / non-notebook / no-access id is a
 * UNIFORM 404 (no existence leak); a reader attempting a write op gets 403.
 *
 * Surface under /v1/host/openwop-app/notebooks:
 *   POST   /                  create {name, orgId}            [workspace:write in body.orgId]
 *   GET    /                  list the caller's notebooks      [workspace:read, access-scoped]
 *   GET    /:id               one notebook                     [workspace:read]
 *   DELETE /:id               delete + cascade (KB col, board, memory, binding) [workspace:write]
 *   POST   /:id/sources       {title?, text} ingest a source   [workspace:write]
 *   GET    /:id/sources       list sources (+ contextLevel)     [workspace:read]
 *   PUT    /:id/sources/:sid/context-level {level} full|summary|excluded [workspace:write]
 *   POST   /:id/sources/:sid/summarize    enqueue notebooks.summarize run [workspace:write]
 *   POST   /:id/sources/:sid/transform    {templateId} enqueue notebooks.transform run [workspace:write]
 *   GET    /:id/transformations           list the notebook's transformation Documents [workspace:read]
 *   GET    /:id/transformations/templates the transformation catalog [workspace:read]
 *   POST   /:id/notes         {text} add a note                 [workspace:write]
 *   GET    /:id/notes         list notes                        [workspace:read]
 *   POST   /:id/search        {query, topK?} semantic search    [workspace:read]
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString, optionalString } from '../featureRoute.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { resolveProjectAccess, projectSubject } from '../projects/projectsService.js';
import {
  subjectConversationId, ensureConversationMeta, getConversationMeta,
  addParticipant, agentRef,
} from '../../host/conversationStore.js';
import {
  createNotebook, ensureNotebookForProject, getNotebook, listNotebooks, deleteNotebook,
  addSource, listSources, setSourceContextLevel, addNote, listNotes, searchNotebook,
  getSourceSummary, listTransformations,
} from './notebooksService.js';
import { getDocument } from '../kb/kbService.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { NOTEBOOKS_SUMMARIZE_ID } from './summarizeWorkflow.js';
import { NOTEBOOKS_TRANSFORM_ID } from './transformWorkflow.js';
import { NOTEBOOKS_INGEST_AUDIO_ID, NOTEBOOKS_INGEST_YOUTUBE_ID } from './transcribeWorkflow.js';
import { isAllowedUploadMime, allowedUploadMimeList } from '../../host/allowedUploadMime.js';
import { checkMediaBudget, recordMediaUsage, estimateMediaBytes } from '../../aiProviders/mediaBudget.js';
import { NOTEBOOK_TRANSFORMATIONS, getTransformation } from './transformations.js';

const log = createLogger('features.notebooks.routes');

/** base64 shape guard for the audio upload route (mirrors features/media). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Route-level decoded-byte cap for an audio/video upload — mirrors the
 *  `MAX_TRANSCRIBE_DECODED_BYTES` cap inside the transcribe node (ADR 0085), so an
 *  over-cap upload is rejected SYNCHRONOUSLY at the edge with a clear 413 rather
 *  than enqueuing an async run that is doomed to fail `audio_too_large` later. The
 *  scoped 44mb body parser (index.ts) admits a full-cap base64 payload; this is the
 *  decoded-size backstop that gives the precise error. */
const MAX_AUDIO_DECODED_BYTES = 32 * 1024 * 1024;

/** The Notebook Research Analyst manifest agent (ADR 0084 Phase 4) — the
 *  notebooks-surface analog of the KB Researcher, tool-allowlisted to the
 *  feature.notebooks.nodes ask/search over ctx.features.notebooks. It is the
 *  grounded analyst in the notebook's group chat — no parallel agent. Seeded as a
 *  conversation PARTICIPANT (not a project member: the project member API validates
 *  ROSTER agents, and the researcher is a manifest pack agent the chat dispatch
 *  resolves via the agent registry). Phase-2 owner-subject auto-grounding is
 *  agent-agnostic, so swapping the agent KEEPS grounding and adds ask/search. */
const RESEARCHER_AGENT_ID = 'feature.notebooks.agents.researcher';

const TOGGLE = { toggleId: 'notebooks', label: 'Research Notebooks' };

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** A resolved caller is required to author a notebook or a source (so KB
 *  `createdBy` is never the placeholder `'unknown'`). Fail closed: an
 *  unauthenticated caller gets 401 rather than an anonymously-attributed write.
 *  (Access gates already 403/404 unauthenticated callers in practice; this makes
 *  the attribution invariant explicit at the write sites.) */
function requireActor(req: Request): string {
  const actor = actingUserOf(req);
  if (!actor) throw new OpenwopError('unauthenticated', 'Authentication required.', 401);
  return actor;
}

/** Boolean: does the caller hold `scope` IN `orgId`? (used for create, which
 *  gates on the body's org before any notebook exists). */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}

/** Resolve a notebook + gate on the caller's RESOLVED project access (the same
 *  gate `projects` uses — visibility ≠ authority, ADR 0054 D5). Uniform 404 on
 *  missing / non-notebook / cross-tenant / no-read-access (no existence leak); a
 *  read-only caller attempting a write op gets 403. Returns the resolved notebook. */
async function requireNotebook(req: Request, scope: Scope) {
  await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
  const tenantId = tenantOf(req);
  const id = req.params.id;
  const nb = await getNotebook(tenantId, id);
  const level = nb ? await resolveProjectAccess(tenantId, id, actingUserOf(req)) : 'none';
  if (!nb || level === 'none') {
    throw new OpenwopError('not_found', 'Notebook not found.', 404, { id });
  }
  if (scope === 'workspace:write' && level !== 'write') {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  return nb;
}

export function registerNotebooksRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/notebooks';

  // POST / — create a notebook (project + KB collection + binding) in body.orgId.
  app.post(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const body = (req.body ?? {}) as { name?: unknown; orgId?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      if (!(await hasOrgScope(req, orgId, 'workspace:write'))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId });
      }
      const notebook = await createNotebook(tenantOf(req), orgId, requireActor(req), { name: body.name });
      // NB-4 — structured trail for the consequential mutations (create/delete), so a
      // feature-flag rollout / provisioning issue is debuggable beyond the error middleware.
      log.info('notebook_created', { tenantId: tenantOf(req), orgId, id: notebook.id });
      res.status(201).json({ notebook, collectionId: notebook.collectionId });
    } catch (err) { next(err); }
  });

  // POST /:id/ensure — ADR 0084 correction (Sources is a PROJECT tab): provision a
  // KB collection + binding for an EXISTING project so it can host sources, idempotent.
  // Gated on the caller's resolved project access (workspace:write) — NOT requireNotebook,
  // which 404s before provisioning. Returns the notebook projection.
  app.post(`${BASE}/:id/ensure`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const tenantId = tenantOf(req);
      const id = req.params.id;
      const level = await resolveProjectAccess(tenantId, id, actingUserOf(req));
      if (level === 'none') throw new OpenwopError('not_found', 'Project not found.', 404, { id });
      if (level !== 'write') throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
      const notebook = await ensureNotebookForProject(tenantId, id, requireActor(req));
      log.info('notebook_ensured', { tenantId, id });
      res.status(200).json({ notebook, collectionId: notebook.collectionId });
    } catch (err) { next(err); }
  });

  // GET / — list the caller's notebooks (access-scoped: drop any the caller can't read).
  app.get(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const tenantId = tenantOf(req);
      const caller = actingUserOf(req);
      // NB-1 — resolve the per-notebook access CONCURRENTLY (was a sequential await-in-loop)
      // before the access-scoped filter — bounds the list path at ~1 round-trip of latency.
      const all = await listNotebooks(tenantId);
      const levels = await Promise.all(all.map((nb) => resolveProjectAccess(tenantId, nb.id, caller)));
      res.json({ notebooks: all.filter((_, i) => levels[i] !== 'none') });
    } catch (err) { next(err); }
  });

  // GET /:id — one notebook.
  app.get(`${BASE}/:id`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:read');
      res.json(nb);
    } catch (err) { next(err); }
  });

  // DELETE /:id — delete + cascade (KB collection, board, memory, knowledge binding).
  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:write');
      const result = await deleteNotebook(tenantOf(req), req.params.id);
      log.info('notebook_deleted', { tenantId: tenantOf(req), id: req.params.id, deleted: result.deleted });
      res.json(result);
    } catch (err) { next(err); }
  });

  // POST /:id/sources — ingest a text source into the notebook's KB collection.
  app.post(`${BASE}/:id/sources`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:write');
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown; contentBase64?: unknown; contentType?: unknown };
      const title = optionalString(body.title);
      // A source is EITHER pasted text OR an uploaded file (text/PDF/DOCX → extracted
      // by ingestDocument). The file path carries base64 bytes + its MIME.
      const hasFile = typeof body.contentBase64 === 'string' && body.contentBase64.length > 0 && typeof body.contentType === 'string';
      const source = await addSource(tenantOf(req), req.params.id, requireActor(req), {
        ...(title !== undefined ? { title } : {}),
        ...(hasFile
          ? { contentBase64: body.contentBase64 as string, contentType: body.contentType as string }
          : { text: requireString(body.text, 'text') }),
      });
      res.status(201).json(source);
    } catch (err) { next(err); }
  });

  // POST /:id/sources/audio — ingest an audio/video source (ADR 0085). Write-gated.
  // Validates the bytes (base64) + the MIME (must be an audio/video container in the
  // shared upload allowlist — the stored-XSS guard, inert when reflected), then
  // ENQUEUES the `notebooks.ingest-audio` built-in run (transcribe → ingest). The
  // transcript is produced by the REAL run (ctx.callAI audio part, RFC 0091), never
  // here — provider calls are ctx-only (ADR 0011). The FE polls listSources for the
  // new source once the run completes (the same async pattern as summarize).
  app.post(`${BASE}/:id/sources/audio`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:write');
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { title?: unknown; contentBase64?: unknown; contentType?: unknown; language?: unknown };
      const contentBase64 = requireString(body.contentBase64, 'contentBase64');
      const contentType = requireString(body.contentType, 'contentType');
      if (!BASE64_RE.test(contentBase64) || contentBase64.length % 4 !== 0) {
        throw new OpenwopError('validation_error', 'Field `contentBase64` must be valid base64.', 400, { field: 'contentBase64' });
      }
      // Decoded-byte cap at the edge (~3/4 of the base64 length is the decoded byte
      // count — cheap pre-check). 413 here is the clear synchronous rejection; the
      // transcribe node enforces the same cap as defence-in-depth on replay.
      if (Math.floor((contentBase64.length * 3) / 4) > MAX_AUDIO_DECODED_BYTES) {
        throw new OpenwopError('validation_error', `Audio exceeds the ${Math.round(MAX_AUDIO_DECODED_BYTES / (1024 * 1024))} MiB upload cap — split it into shorter segments.`, 413, { field: 'contentBase64', cap: MAX_AUDIO_DECODED_BYTES });
      }
      // Only audio/video container types — reuse the single upload allowlist (so the
      // stored-XSS exclusion of text/html, svg can never be bypassed here) AND require
      // the audio|video families (an image/pdf can't be transcribed).
      if (!isAllowedUploadMime(contentType) || !/^(audio|video)\//.test(contentType)) {
        throw new OpenwopError('validation_error', `contentType must be an audio/video type in: ${allowedUploadMimeList()}`, 415, { contentType });
      }
      // ADR 0106 Phase 2 — pre-flight the per-org STT (transcription) BYTE budget
      // SYNCHRONOUSLY here, where the decoded size is known and there is no
      // invocation-log/replay concern (the transcription run itself can't meter
      // safely — callAI is replay-cached). No-op when the budget is unset.
      const sttBytes = estimateMediaBytes(contentBase64);
      const budget = await checkMediaBudget(tenantId, 'stt', sttBytes);
      if (budget.exceeded) {
        throw new OpenwopError(
          'rate_limited',
          `Daily transcription budget reached (${budget.cap} bytes; ${budget.used} used). Resets at 00:00 UTC.`,
          429,
          { kind: 'stt', cap: budget.cap, used: budget.used },
        );
      }
      const sourceType = contentType.startsWith('video/') ? 'video' : 'audio';
      const title = optionalString(body.title) ?? `Transcribed ${sourceType}`;
      const language = optionalString(body.language);
      const runId = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        {
          tenantId,
          workflowId: NOTEBOOKS_INGEST_AUDIO_ID,
          inputs: { notebookId: nb.id, title, sourceType, audioBase64: contentBase64, mimeType: contentType, language: language ?? '' },
          metadata: { notebookIngest: { notebookId: nb.id, sourceType } },
        },
      );
      if (!runId) {
        throw new OpenwopError('internal_error', 'Audio ingest workflow is unavailable.', 500, { workflowId: NOTEBOOKS_INGEST_AUDIO_ID });
      }
      // Record the submitted bytes against the budget (this route runs once per
      // upload — no replay double-count, unlike metering inside the run).
      await recordMediaUsage(tenantId, 'stt', sttBytes);
      log.info('notebook_source_audio_enqueued', { tenantId, id: nb.id, sourceType, runId });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });

  // POST /:id/sources/youtube — ingest a YouTube source by caption track (ADR 0085).
  // Write-gated. Enqueues the `notebooks.ingest-youtube` built-in run (fetch captions
  // via SSRF-guarded egress → ingest). Fails the run with `no_transcript` when the
  // video has no captions (the audio-track STT fallback is a documented deferral).
  app.post(`${BASE}/:id/sources/youtube`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:write');
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { title?: unknown; url?: unknown };
      const url = requireString(body.url, 'url');
      if (!/^https?:\/\/([\w-]+\.)*(youtube\.com|youtu\.be)\//i.test(url)) {
        throw new OpenwopError('validation_error', 'url must be a YouTube watch/share URL.', 400, { field: 'url' });
      }
      const title = optionalString(body.title) ?? 'YouTube source';
      const runId = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        {
          tenantId,
          workflowId: NOTEBOOKS_INGEST_YOUTUBE_ID,
          inputs: { notebookId: nb.id, title, sourceType: 'youtube', url },
          metadata: { notebookIngest: { notebookId: nb.id, sourceType: 'youtube' } },
        },
      );
      if (!runId) {
        throw new OpenwopError('internal_error', 'YouTube ingest workflow is unavailable.', 500, { workflowId: NOTEBOOKS_INGEST_YOUTUBE_ID });
      }
      log.info('notebook_source_youtube_enqueued', { tenantId, id: nb.id, runId });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });

  // GET /:id/sources — list the notebook's sources.
  app.get(`${BASE}/:id/sources`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:read');
      res.json({ sources: await listSources(tenantOf(req), req.params.id) });
    } catch (err) { next(err); }
  });

  // PUT /:id/sources/:sid/context-level — set a source's context level (ADR 0084).
  // `full` (in the grounded chat + Ask), `excluded` (omitted from both), or `summary`
  // (raw chunks dropped, the stored LLM summary injected instead — ADR 0084 T1).
  // `summary` is allowed ONLY once a summary has been generated (else 400 "summarize
  // the source first"); the service double-guards it. Unknown sid ⇒ 404.
  app.put(`${BASE}/:id/sources/:sid/context-level`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:write');
      const body = (req.body ?? {}) as { level?: unknown };
      const level = requireString(body.level, 'level');
      if (level !== 'full' && level !== 'excluded' && level !== 'summary') {
        throw new OpenwopError('validation_error', 'level must be "full", "summary", or "excluded".', 400, { level });
      }
      if (level === 'summary' && (await getSourceSummary(tenantOf(req), req.params.id, req.params.sid)) === null) {
        throw new OpenwopError('validation_error', 'Summarize the source first.', 400, { level, sourceId: req.params.sid });
      }
      const source = await setSourceContextLevel(tenantOf(req), req.params.id, req.params.sid, level);
      res.json(source);
    } catch (err) { next(err); }
  });

  // POST /:id/sources/:sid/summarize — enqueue the `notebooks.summarize` built-in
  // workflow run (ADR 0084 Transformations T1). Write-gated. Validates sid is a real
  // document in the notebook's collection (unknown ⇒ 404, the uniform IDOR guard;
  // cross-tenant is already 404 via requireNotebook). The summary is produced by the
  // REAL run (read-source → core.ai.chatCompletion → store-summary), not here — the
  // route only kicks it off and returns the runId. The FE polls listSources for
  // hasSummary, then can switch the source to the `summary` context level.
  app.post(`${BASE}/:id/sources/:sid/summarize`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:write');
      const tenantId = tenantOf(req);
      const sid = req.params.sid;
      const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sid);
      if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id: nb.id, sourceId: sid });
      const runId = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        {
          tenantId,
          workflowId: NOTEBOOKS_SUMMARIZE_ID,
          inputs: { notebookId: nb.id, sourceId: sid },
          metadata: { notebookSummarize: { notebookId: nb.id, sourceId: sid } },
        },
      );
      if (!runId) {
        // The built-in workflow didn't resolve in the catalog — a deploy/config
        // issue, not a caller error.
        throw new OpenwopError('internal_error', 'Summarize workflow is unavailable.', 500, { workflowId: NOTEBOOKS_SUMMARIZE_ID });
      }
      log.info('notebook_source_summarize_enqueued', { tenantId, id: nb.id, sourceId: sid, runId });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });

  // GET /:id/transformations/templates — the transformation catalog (id + label).
  // Read-gated. Const config (NOT a store) — the FE renders these as the Transform
  // menu. Must precede the `:tid`-style routes (none here) but kept above the list
  // route for grouping. ADR 0084 Transformations T2.
  app.get(`${BASE}/:id/transformations/templates`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:read');
      res.json({ templates: NOTEBOOK_TRANSFORMATIONS.map((tpl) => ({ id: tpl.id, label: tpl.label })) });
    } catch (err) { next(err); }
  });

  // GET /:id/transformations — list the notebook's transformation Documents (ADR
  // 0084 Transformations T2). Read-gated. The outputs live in Documents owned by
  // project:<id> (the single owner of stored artifacts — no notebooks store);
  // listTransformations queries Documents by ownerSubject + filters to the catalog
  // kinds. Returns [{ documentId, title, kind, status, createdAt }].
  app.get(`${BASE}/:id/transformations`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:read');
      res.json({ transformations: await listTransformations(tenantOf(req), req.params.id) });
    } catch (err) { next(err); }
  });

  // POST /:id/sources/:sid/transform — apply a transformation TEMPLATE to a source
  // (ADR 0084 Transformations T2). Write-gated. Validates `templateId` ∈ catalog
  // (else 400) and `sid` is a real document in the collection (else 404; cross-tenant
  // already 404 via requireNotebook). Reads the source's full text + title, builds
  // messages = [{system: tpl.systemPrompt}, {user: sourceText}], and enqueues the
  // `notebooks.transform` built-in workflow run (core.ai.chatCompletion →
  // write-transformation → a Document owned by project:<id>). Returns { runId }.
  app.post(`${BASE}/:id/sources/:sid/transform`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:write');
      const tenantId = tenantOf(req);
      const sid = req.params.sid;
      const body = (req.body ?? {}) as { templateId?: unknown };
      const templateId = requireString(body.templateId, 'templateId');
      const tpl = getTransformation(templateId);
      if (!tpl) {
        throw new OpenwopError('validation_error', `Unknown transformation templateId \`${templateId}\`.`, 400, { templateId });
      }
      const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sid);
      if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id: nb.id, sourceId: sid });
      if ((doc.text ?? '').trim().length === 0) {
        throw new OpenwopError('validation_error', 'Source has no text to transform.', 400, { sourceId: sid });
      }
      // The source text is NOT inlined into run.inputs: the workflow's read-source
      // node fetches it IN-RUN (keeps the run record small for large sources +
      // consistent with notebooks.summarize). The route passes the small systemPrompt
      // + ids; read-source prepends the system message before the chatCompletion node.
      const runId = await startWorkflowRun(
        { storage: deps.storage, hostSuite: deps.hostSuite },
        {
          tenantId,
          workflowId: NOTEBOOKS_TRANSFORM_ID,
          inputs: {
            notebookId: nb.id,
            sourceId: sid,
            systemPrompt: tpl.systemPrompt,
            kind: tpl.docKind,
            title: `${tpl.label}: ${doc.title}`,
            ownerSubject: projectSubject(nb.id),
            orgId: nb.orgId,
          },
          metadata: { notebookTransform: { notebookId: nb.id, sourceId: sid, templateId } },
        },
      );
      if (!runId) {
        throw new OpenwopError('internal_error', 'Transform workflow is unavailable.', 500, { workflowId: NOTEBOOKS_TRANSFORM_ID });
      }
      log.info('notebook_source_transform_enqueued', { tenantId, id: nb.id, sourceId: sid, templateId, runId });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });

  // POST /:id/notes — add a note (subject memory in the project:<id> scope).
  app.post(`${BASE}/:id/notes`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:write');
      const body = (req.body ?? {}) as { text?: unknown };
      const notes = await addNote(tenantOf(req), req.params.id, requireString(body.text, 'text'));
      res.status(201).json({ notes });
    } catch (err) { next(err); }
  });

  // GET /:id/notes — list notes.
  app.get(`${BASE}/:id/notes`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:read');
      res.json({ notes: await listNotes(tenantOf(req), req.params.id) });
    } catch (err) { next(err); }
  });

  // POST /:id/chat — ensure (idempotent) the notebook's project group conversation
  // and return its conversationId for the main /chat surface to open. Mirrors the
  // projects group-chat handler (features/projects/routes.ts §`/:id/chat`): the SAME
  // host primitives (`subjectConversationId` + `ensureConversationMeta` +
  // `addParticipant`) — no parallel chat. ADR 0084 Phase 2.
  //
  // The `ownerSubject` is SERVER-SET to `projectSubject(id)` (never client-supplied),
  // which is what `conversationExchange` reads to ground each turn in the notebook's
  // bound KB sources (authorized via `resolveSubjectAccess`). Write-gated: opening
  // reconciles the lineup (a write), mirroring the projects handler.
  app.post(`${BASE}/:id/chat`, async (req, res, next) => {
    try {
      const nb = await requireNotebook(req, 'workspace:write');
      const tenantId = tenantOf(req);
      const subject = projectSubject(nb.id);
      const conversationId = subjectConversationId(tenantId, subject);
      const researcherRef = agentRef(RESEARCHER_AGENT_ID);
      const ts = new Date().toISOString();
      try {
        await deps.storage.createChatSession({ sessionId: conversationId, tenantId, title: `${nb.name} · notebook`, createdAt: ts, updatedAt: ts, messageCount: 0 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== '23505') throw err; // already exists ⇒ reuse
      }
      await ensureConversationMeta(tenantId, conversationId, {
        type: 'group',
        ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}),
        ownerSubject: subject, // SERVER-SET — the grounding key, never client-supplied
        participants: [researcherRef],
      });
      // Idempotent reconcile: ensure the researcher is in the room on re-open (the
      // meta is create-or-return, so a pre-existing meta won't re-seed participants).
      const meta = await getConversationMeta(tenantId, conversationId);
      if (!(meta?.participants ?? []).some((p) => p.subjectRef === researcherRef)) {
        await addParticipant(tenantId, conversationId, researcherRef);
      }
      res.status(201).json({ conversationId });
    } catch (err) { next(err); }
  });

  // POST /:id/search — KB semantic search over the notebook's collection (ask).
  app.post(`${BASE}/:id/search`, async (req, res, next) => {
    try {
      await requireNotebook(req, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown };
      requireString(body.query, 'query'); // validate before the search
      res.json(await searchNotebook(tenantOf(req), req.params.id, body.query, body.topK));
    } catch (err) { next(err); }
  });
}
