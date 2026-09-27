/**
 * Notebook Research Analyst chat tools (CFP-1 remediation; ADR 0084 Phase 4 / ADR
 * 0308 D2 seam) — the three tools the grounded notebook analyst actually calls
 * from the ONE chat: `search` + `ask` GROUND on the notebook's bound KB sources,
 * and `write-transformation` IGNITES the real `notebooks.transform` workflow to
 * author + persist a transformation as a notebook-owned Document.
 *
 * These replace three allowlist entries that were raw NODE typeIds
 * (`openwop:feature.notebooks.nodes.{ask,search,write-transformation}`) — ids no
 * conversational-tool provider resolved, so `resolveAgentTools` silently dropped
 * them and the analyst loaded toothless (CHAT-FIRST-PORT-AUDIT #1). The nodes stay
 * the workflow-lane surface; these are the chat-lane projection over the same
 * `notebooksService` behind the SAME access predicate the routes use
 * (`resolveProjectAccess` on the notebook's backing project, ADR 0084 / ADR 0054
 * D5). Read tools fail EMPTY without an acting human or notebook access; the write
 * tool fails TYPED and only starts the run when the caller holds `workspace:write`.
 *
 * The notebook is resolved from an explicit `notebookId` OR, when the tool runs in
 * a notebook's grounded group chat, from the conversation's `ownerSubject`
 * (`project:<notebookId>` — the same grounding key `routes.ts` server-sets).
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js'; // KBC-1 (ADR 0643 D2 precondition) — an in-process lane that owns these rows / gates at its own door
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveFeatureToggle, str, toolError } from '../../host/agentToolKit.js';
import { surfaceOptCount } from '../../host/featureSurfaces.js';
import { resolveProjectAccess, projectSubject } from '../projects/projectsService.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { composeKnowledgeForSubject } from '../../host/agentKnowledgeComposition.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { makeTurn } from '../../host/conversation.js';
import { persistExchangedPair } from '../../host/exchange/persistExchange.js';
import { loadTurns } from '../../host/exchange/loadTurns.js';
import { getDocument, DEFAULT_TOP_K } from '../kb/kbService.js';
import { getNotebook, searchNotebook } from './notebooksService.js';
import { getTransformation, NOTEBOOK_TRANSFORMATIONS } from './transformations.js';
import { NOTEBOOKS_TRANSFORM_ID } from './transformWorkflow.js';
import { createLogger } from '../../observability/logger.js';

/** The notebooks agent tools NARROW the host retrieval cap (`kbService` MAX.topK,
 *  50) to keep a chat turn's grounded context bounded. Named once so the schema
 *  bound and the model-facing description cannot drift apart (ADR 0602). */
const NOTEBOOK_TOOL_MAX_TOP_K = 20;

/**
 * ADR 0602 § Correction log, item D (`M5`) — the ONE shared count rule, applied
 * in the MODEL-FACING lane too.
 *
 * The ADR claimed "exactly one coercion rule" for the numeric-fan-out class. It
 * was not true: these two tools kept hand-written copies (`typeof input.topK ===
 * 'number' && input.topK > 0 ? Math.floor(input.topK) : undefined`), and the
 * copies had ALREADY diverged from the shared helper — no `Number.isFinite`, so
 * `Infinity` passed. Two hand-written copies of one rule is exactly how `search`
 * and `ask` drifted in the first place.
 *
 * The refusal is REPORTED, not thrown: a model that sends `topK: "5"` gets a
 * typed tool error it can repair from, which is the point of a typed failure in
 * this lane. An uncaught throw would surface as an opaque turn failure.
 */
function readTopK(v: unknown): { ok: true; topK: number | undefined } | { ok: false; message: string } {
  try { return { ok: true, topK: surfaceOptCount(v) }; } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'invalid `topK`' };
  }
}

const log = createLogger('notebooks.researcher-tools');

export const NOTEBOOKS_SEARCH_TOOL_ID = 'openwop:notebooks.search';
export const NOTEBOOKS_ASK_TOOL_ID = 'openwop:notebooks.ask';
export const NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID = 'openwop:notebooks.write-transformation';

const RESEARCHER_AGENT_ID = 'feature.notebooks.agents.researcher';

/** Per-call toggle honesty (ADR 0308 D2): acting-subject shape (CFPT-1b), fail-closed. */
async function notebooksEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('notebooks', scope);
}

/** The notebook this call operates on: an explicit `notebookId`, else the
 *  conversation's `ownerSubject` (`project:<notebookId>` — the notebook's grounded
 *  group chat, the same key `routes.ts` server-sets). Undefined when neither
 *  resolves. */
async function resolveNotebookId(scope: BundleScope, input: Record<string, unknown>): Promise<string | undefined> {
  const explicit = str(input.notebookId);
  if (explicit) return explicit;
  if (!scope.conversationId) return undefined;
  const meta = await getConversationMeta(scope.tenantId, scope.conversationId).catch(() => null);
  return meta?.ownerSubject?.kind === 'project' ? meta.ownerSubject.id : undefined;
}

/**
 * Append a server-side `workflow_run` conversation turn so the chat renders the
 * dispatched transform run inline (the `kicktodo-creator` / `conversationExchange`
 * run-mention precedent). Best-effort: the run already started, so a persistence
 * miss (no materialized conversation run yet) must never fail the tool.
 */
async function appendWorkflowRunTurn(
  storage: StartRunDeps['storage'],
  tenantId: string,
  conversationId: string,
  runId: string,
  agentId: string,
): Promise<void> {
  try {
    const meta = await getConversationMeta(tenantId, conversationId);
    const backingRunId = meta?.conversationRunId;
    if (!backingRunId) return;
    const turns = await loadTurns(storage, backingRunId, conversationId);
    const nextIndex = turns.reduce((max, t) => Math.max(max, t.turnIndex), -1) + 1;
    const turn = makeTurn({
      conversationId,
      turnIndex: nextIndex,
      role: 'agent',
      from: agentId,
      content: { kind: 'workflow_run', runId, agentId },
      ts: Date.now(),
      groupId: conversationId,
      agent: { agentId },
      speakerId: agentId,
    });
    await persistExchangedPair({ runId: backingRunId, nodeId: 'notebooks-transform-run', conversationId, entries: [[nextIndex, turn]] });
  } catch (err) {
    log.warn('transform_run_turn_persist_failed', { conversationId, runId, error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerNotebooksAgentTools(deps: StartRunDeps): void {
  // ── READ: raw ranked hits + citations over the notebook's bound sources. ────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: NOTEBOOKS_SEARCH_TOOL_ID,
      description:
        'Search THIS notebook\'s bound sources (semantic retrieval over the notebook\'s KB collection) and return ranked '
        + 'hits + de-duplicated citations (each with its source `documentId`). Excluded sources are already dropped. Use '
        + 'it to find the passages that answer a question before you compose a cited response. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'The search query.' },
          // ADR 0602 — the default is GENERATED from its SSoT (`kbService.DEFAULT_TOP_K`),
          // not hand-copied. This line said "default 5" while the retrieval used 8:
          // a number the model reasons about, stated wrongly, for as long as it existed.
          topK: { type: 'integer', minimum: 1, maximum: NOTEBOOK_TOOL_MAX_TOP_K, description: `Max hits to return (default ${DEFAULT_TOP_K}, max ${NOTEBOOK_TOOL_MAX_TOP_K}).` },
          notebookId: { type: 'string', description: 'The notebook to search; defaults to the notebook this chat is grounded in.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // UX_UPGRADE-notebooks R2 (NBK2-M1) — every guard below used to return a
      // bare `{ hits: [], citations: [] }`: byte-identical to a REAL search
      // that matched nothing, which the happy path returns in exactly that
      // shape. On a grounded-research tool that collapse is the worst variant
      // of the family — a model told "no hits" reports "your sources don't
      // cover this", a claim about the SOURCES that a refusal, a toggle, or a
      // missing notebook never established. The write tool three registrations
      // down has always typed every one of these guards distinctly; the read
      // tools simply never matched it. Reads keep the EMPTY shape (typed
      // errors would turn policy states into probes) but each empty now says
      // it is not an answer. Access-denied and not-found share ONE note — the
      // existence non-leak the old code preserved, kept.
      const notAnAnswer = (note: string) => ({ content: JSON.stringify({ hits: [], citations: [], note }) });
      if (!scope.actingUserId) return notAnAnswer('This tool only reads from a human-initiated turn — NOT a statement about the notebook\'s sources.');
      if (!(await notebooksEnabled(scope))) return notAnAnswer('Research Notebooks is not enabled for this workspace — NOT a statement about any notebook\'s sources.');
      const notebookId = await resolveNotebookId(scope, input);
      if (!notebookId) return notAnAnswer('Pass a `notebookId`, or run this inside a notebook chat — no notebook was searched.');
      if ((await resolveProjectAccess(scope.tenantId, notebookId, scope.actingUserId)) === 'none') return notAnAnswer('Notebook not found or not accessible — no notebook was searched.');
      const nb = await getNotebook(scope.tenantId, notebookId);
      if (!nb) return notAnAnswer('Notebook not found or not accessible — no notebook was searched.');
      const query = str(input.query) ?? '';
      const parsedTopK = readTopK(input.topK);
      if (!parsedTopK.ok) return toolError('validation_error', `\`topK\`: ${parsedTopK.message}`);
      const topK = parsedTopK.topK;
      const { hits, citations } = await searchNotebook(scope.tenantId, nb.id, query, topK);
      return { content: JSON.stringify({ hits, citations }) };
    },
  });

  // ── READ: the grounded ASK — a fenced, context-level-filtered augmented block. ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: NOTEBOOKS_ASK_TOOL_ID,
      description:
        'Ground an answer in THIS notebook\'s sources: returns a FENCED, context-level-filtered augmented prompt (the '
        + 'retrieved passages, honoring per-source Full/Excluded/Summary levels) plus de-duplicated citations and the raw '
        + 'contexts. Call it before answering a question about the notebook, then compose your cited answer from what it '
        + 'returns — generation is yours, not the tool\'s. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'The question to ground.' },
          // ADR 0602 — same SSoT-generated default as the search tool above.
          topK: { type: 'integer', minimum: 1, maximum: NOTEBOOK_TOOL_MAX_TOP_K, description: `Max passages to retrieve (default ${DEFAULT_TOP_K}, max ${NOTEBOOK_TOOL_MAX_TOP_K}).` },
          notebookId: { type: 'string', description: 'The notebook to ask; defaults to the notebook this chat is grounded in.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // NBK2-M1 — same annotation as the search tool above; an empty
      // augmentedPrompt with no note reads as "the sources say nothing".
      const notAnAnswer = (note: string) => ({ content: JSON.stringify({ augmentedPrompt: '', citations: [], contexts: [], note }) });
      if (!scope.actingUserId) return notAnAnswer('This tool only reads from a human-initiated turn — NOT a statement about the notebook\'s sources.');
      if (!(await notebooksEnabled(scope))) return notAnAnswer('Research Notebooks is not enabled for this workspace — NOT a statement about any notebook\'s sources.');
      const notebookId = await resolveNotebookId(scope, input);
      if (!notebookId) return notAnAnswer('Pass a `notebookId`, or run this inside a notebook chat — no notebook was consulted.');
      if ((await resolveProjectAccess(scope.tenantId, notebookId, scope.actingUserId)) === 'none') return notAnAnswer('Notebook not found or not accessible — no notebook was consulted.');
      const nb = await getNotebook(scope.tenantId, notebookId);
      if (!nb) return notAnAnswer('Notebook not found or not accessible — no notebook was consulted.');
      const query = str(input.query) ?? '';
      const parsedTopK = readTopK(input.topK);
      if (!parsedTopK.ok) return toolError('validation_error', `\`topK\`: ${parsedTopK.message}`);
      const topK = parsedTopK.topK;
      const augmentedPrompt = await composeKnowledgeForSubject(
        scope.tenantId,
        projectSubject(nb.id),
        query,
        topK !== undefined ? { topK } : undefined,
      );
      const { hits, citations } = await searchNotebook(scope.tenantId, nb.id, query, topK);
      return { content: JSON.stringify({ augmentedPrompt, citations, contexts: hits }) };
    },
  });

  // ── ACTION: author a transformation as a notebook-owned Document. ───────────
  const templateIds = NOTEBOOK_TRANSFORMATIONS.map((t) => t.id);
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID,
      description:
        'Apply a transformation TEMPLATE to one of the notebook\'s sources and persist the result as a notebook-owned '
        + `Document. \`templateId\` is one of: ${templateIds.join(', ')}. \`sourceId\` is a source's \`documentId\` (get one `
        + 'from `search`/`ask` citations first). Starts the real `notebooks.transform` run (read source → LLM applies the '
        + 'template → write Document); returns the started `runId`. Requires notebook write access.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', enum: templateIds, description: 'The transformation template to apply.' },
          sourceId: { type: 'string', description: 'The source document id to transform (from a search/ask citation).' },
          notebookId: { type: 'string', description: 'The notebook; defaults to the notebook this chat is grounded in.' },
        },
        required: ['templateId', 'sourceId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'A transformation can only be authored from a human-initiated turn.');
      if (!(await notebooksEnabled(scope))) return toolError('feature_disabled', 'Research Notebooks is not enabled for this workspace.');
      const notebookId = await resolveNotebookId(scope, input);
      if (!notebookId) return toolError('notebook_required', 'Pass a `notebookId`, or run this inside a notebook chat.');
      const level = await resolveProjectAccess(scope.tenantId, notebookId, scope.actingUserId);
      if (level === 'none') return toolError('not_found', 'Notebook not found.');
      if (level !== 'write') return toolError('forbidden_scope', 'You need write access to this notebook to author a transformation.');
      const nb = await getNotebook(scope.tenantId, notebookId);
      if (!nb) return toolError('not_found', 'Notebook not found.');

      const templateId = str(input.templateId) ?? '';
      const tpl = getTransformation(templateId);
      if (!tpl) return toolError('validation_error', `Unknown transformation templateId \`${templateId}\`.`, { templateIds });
      const sourceId = str(input.sourceId);
      if (!sourceId) return toolError('validation_error', '`sourceId` is required (use a source documentId from search/ask).');
      const doc = await getDocument(scope.tenantId, nb.orgId, nb.collectionId, sourceId, PREAUTHORIZED_CALLER); // KBC-1
      if (!doc) return toolError('not_found', 'Source not found in this notebook.', { sourceId });
      if ((doc.text ?? '').trim().length === 0) return toolError('validation_error', 'Source has no text to transform.', { sourceId });

      // CFPT-3 ignition dedup — like every other igniter, a repeated identical
      // transform call (same notebook + source + template) inside the window
      // reuses the run already started instead of igniting a duplicate (and
      // duplicately-billed) transform. Key over the STABLE business inputs only.
      const key = ignitionKey('notebooks.transform', nb.id, sourceId, templateId);
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed) {
        return { content: JSON.stringify({ runId: claim.existingRunId ?? null, templateId, sourceId, ignited: false, note: 'an identical transform was started moments ago — reusing it' }) };
      }

      const runId = await startWorkflowRun(deps, {
        tenantId: scope.tenantId,
        workflowId: NOTEBOOKS_TRANSFORM_ID,
        inputs: {
          notebookId: nb.id,
          sourceId,
          systemPrompt: tpl.systemPrompt,
          kind: tpl.docKind,
          title: `${tpl.label}: ${doc.title}`,
          ownerSubject: projectSubject(nb.id),
          orgId: nb.orgId,
        },
        metadata: {
          actingUserId: scope.actingUserId,
          ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
          notebookTransform: { notebookId: nb.id, sourceId, templateId },
        },
      }).catch((err) => {
        // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
        // null so the shared failure handler below runs.
        log.warn('notebook_transformation_dispatch_threw', { tenantId: scope.tenantId, notebookId: nb.id, sourceId, error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (!runId) {
        // CFPT-2/3 / DATA-4 — the run never started (null OR a throw); release the
        // claim so an honest retry isn't blocked for the dedup window.
        await releaseIgnition(scope.tenantId, key);
        return toolError('dispatch_failed', 'The transform workflow could not start.');
      }
      await recordIgnitionRun(scope.tenantId, key, runId);
      const agentId = scope.agentProfileId ?? RESEARCHER_AGENT_ID;
      if (scope.conversationId) await appendWorkflowRunTurn(deps.storage, scope.tenantId, scope.conversationId, runId, agentId);
      log.info('notebook_transformation_dispatched', { tenantId: scope.tenantId, notebookId: nb.id, sourceId, templateId, runId });
      return { content: JSON.stringify({ runId, templateId, sourceId }) };
    },
  });
}
