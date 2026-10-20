/**
 * ADR 0889 D2 — the agent eval suite store, host-extension (non-normative):
 *
 *   GET    /host/openwop-app/agent-evals/suites                 — list (workspace:read)
 *   PUT    /host/openwop-app/agent-evals/suites/:ref            — create/replace a version; `?create=true` is insert-only (workspace:write)
 *   GET    /host/openwop-app/agent-evals/suites/:ref            — read (workspace:read)
 *   DELETE /host/openwop-app/agent-evals/suites/:ref            — delete (workspace:write)
 *   GET    /host/openwop-app/agent-evals/runs?agentId=&limit=&cursor= — eval runs, newest first, paged (workspace:read)
 *
 * `:ref` is `<suiteId>@<version>`. Running a suite is NOT here: it is the
 * normative `POST /runs {mode:"eval"}` (RFC 0081 §B), so there is one lane.
 * Every row is tenant-keyed; another tenant's ref is indistinguishable from an
 * absent one (404).
 */
import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { tenantOf, callerSubject } from '../host/requestSubject.js';
import { callerHoldsTenantScope, requireTenantWrite } from '../features/featureRoute.js';
import { evalWorkflowId, validateEvalSuite, putEvalSuite, getEvalSuite, deleteEvalSuite, suiteRef, updateEvalSuite } from '../host/evals/suiteStore.js';
import { isAgentEvalRun, type AgentEvalMeta } from '../host/evals/agentEvalRun.js';
import { evalSuiteCapability } from '../host/evals/evalCapability.js';
import { getCaptureSetting, setCaptureSetting, listCapturedRuns, listRunBoundary } from '../host/evals/toolBoundary.js';
import { buildTaskFromRun } from '../host/evals/promoteRun.js';
import { listResolvableSuites, visiblePackSuiteOwning, type ListedSuite } from '../host/evals/packSuites.js';
import { resolveAgentForTenant } from '../host/agentVisibility.js';
import { agentStorageId } from '../executor/agentIdAliases.js';
import { storedRunId } from '../host/evals/runIds.js';
import { requireAgentEvalsEnabled } from '../host/evals/access.js';

async function requireTenantRead(req: Request): Promise<string> {
  const tenantId = tenantOf(req);
  if (!(await callerHoldsTenantScope(req, tenantId, 'workspace:read'))) {
    throw new OpenwopError('forbidden', 'workspace:read is required.', 403, {});
  }
  return tenantId;
}

const pub = (r: Awaited<ReturnType<typeof getEvalSuite>>) => r && ({
  ref: suiteRef(r.suite),
  suite: r.suite,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  locked: !!r.lockedAt,
  source: 'tenant' as const,
  ...(r.erasedAt ? { erasedAt: r.erasedAt } : {}),
});

/**
 * Why a requested regression came back `inconclusive` (A1 writes it to
 * `metadata.eval.regressionReason`: baseline_unavailable | judge_mismatch |
 * model_class_mismatch). Host-extension only: the wire summary's `regression`
 * block is closed, so the reason is never added there.
 */
const regressionReasonOf = (m: AgentEvalMeta): string | null => {
  const r = (m as { regressionReason?: unknown }).regressionReason;
  return typeof r === 'string' ? r : null;
};

/** EVAL-10 — the history page size (default, cap) and its opaque cursor. */
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 100;
function decodeCursor(raw: unknown): { createdAt: string; runId: string } | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { createdAt?: unknown; runId?: unknown };
    if (typeof v.createdAt === 'string' && typeof v.runId === 'string') return { createdAt: v.createdAt, runId: v.runId };
  } catch { /* fall through */ }
  throw new OpenwopError('validation_error', 'cursor is not a cursor this endpoint issued.', 400, { field: 'cursor', rule: 'type' });
}
const encodeCursor = (r: { createdAt: string; runId: string }): string => Buffer.from(JSON.stringify({ createdAt: r.createdAt, runId: r.runId })).toString('base64url');
/** Newest first, ties broken by runId — the order `listRuns({before})` pages in. */
const newerFirst = (a: { createdAt: string; runId: string }, b: { createdAt: string; runId: string }): number =>
  b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId);
/** A pack-shipped suite (ADR 0889 D2): read-only, so always `locked`. */
const pubListed = (l: ListedSuite) => l.source === 'tenant'
  ? pub(l.stored)
  : { ref: suiteRef(l.suite), suite: l.suite, locked: true, source: 'pack' as const, pack: l.pack };

export function registerAgentEvalRoutes(app: Express, deps: { storage: Storage }): void {
  const BASE = '/host/openwop-app/agent-evals';

  // Review H1 — the `evals` toggle + plan gate every route here (it was UI-only).
  // ONE middleware on the namespace, so a new route cannot forget it.
  app.use(BASE, async (req, _res, next) => {
    try {
      await requireAgentEvalsEnabled({ tenantId: tenantOf(req), ...(req.principal?.principalId ? { userId: req.principal.principalId } : {}) });
      next();
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/capability`, async (req, res, next) => {
    try {
      await requireTenantRead(req);
      res.json(evalSuiteCapability());
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/suites`, async (req, res, next) => {
    try {
      const tenantId = await requireTenantRead(req);
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
      res.json({ items: (await listResolvableSuites(tenantId, agentId)).map(pubListed) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/suites/:ref`, async (req, res, next) => {
    try {
      const tenantId = await requireTenantRead(req);
      const ref = req.params.ref ?? '';
      const row = await getEvalSuite(tenantId, ref);
      if (row) { res.json(pub(row)); return; }
      // EVAL-11 — a pack suite the list returns is readable by its ref too.
      const listed = (await listResolvableSuites(tenantId)).find((l) => suiteRef(l.suite) === ref);
      if (!listed) throw new OpenwopError('not_found', 'Eval suite not found.', 404, {});
      res.json(pubListed(listed));
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/suites/:ref`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      await requireTenantWrite(req, tenantId);
      const suite = validateEvalSuite(req.body);
      if (suiteRef(suite) !== req.params.ref) {
        throw new OpenwopError('validation_error', `Path ref ${req.params.ref} does not match the body's ${suiteRef(suite)}.`, 400, { field: 'suiteId', rule: 'enum', params: { values: [req.params.ref] } });
      }
      // EVD-13 — a tenant suite must not claim a visible pack suite's ref.
      if (visiblePackSuiteOwning(tenantId, suiteRef(suite))) {
        throw new OpenwopError('conflict', `Suite ${suiteRef(suite)} is shipped by an agent pack; publish under another suite id.`, 409, { reason: 'pack_suite_ref', suiteRef: suiteRef(suite) });
      }
      // EVUX-1 — `?create=true` is insert-only: an existing ref is `409 suite_exists`.
      const row = await putEvalSuite(tenantId, suite, callerSubject(req), { create: req.query.create === 'true' });
      res.status(200).json(pub(row));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/suites/:ref`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      await requireTenantWrite(req, tenantId);
      const ok = await deleteEvalSuite(tenantId, req.params.ref ?? '');
      if (!ok) throw new OpenwopError('not_found', 'Eval suite not found.', 404, {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ADR 0889 D9 — per-agent opt-in capture of the tool boundary (default OFF).
  app.get(`${BASE}/capture/:agentId`, async (req, res, next) => {
    try {
      const tenantId = await requireTenantRead(req);
      const agentId = req.params.agentId ?? '';
      res.json({ agentId, enabled: await getCaptureSetting(tenantId, agentId), runs: await listCapturedRuns(tenantId, agentId) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/capture/:agentId`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      await requireTenantWrite(req, tenantId);
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') throw new OpenwopError('validation_error', 'enabled must be a boolean.', 400, { field: 'enabled', rule: 'type' });
      // EVD-5 — no orphan opt-in rows for an agent this tenant cannot see (404, same as dispatch).
      if (!(await resolveAgentForTenant(req.params.agentId ?? '', tenantId))) {
        throw new OpenwopError('not_found', `agent '${req.params.agentId}' is not installed on this host`, 404, { field: 'agentId' });
      }
      await setCaptureSetting(tenantId, req.params.agentId ?? '', enabled, callerSubject(req));
      res.json({ agentId: req.params.agentId, enabled });
    } catch (err) { next(err); }
  });

  // Promote a captured run into a regression task appended to an (unlocked) suite version.
  app.post(`${BASE}/suites/:ref/tasks`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      await requireTenantWrite(req, tenantId);
      const ref = req.params.ref ?? '';
      if (!(await getEvalSuite(tenantId, ref))) throw new OpenwopError('not_found', 'Eval suite not found.', 404, {});
      const body = (req.body ?? {}) as { fromRunId?: unknown; taskId?: unknown; expectedContains?: unknown; input?: unknown; wrapId?: unknown; overrideTargetAgent?: unknown };
      // AE-4 — every promote refusal names a `reason` the client localizes on.
      if (typeof body.fromRunId !== 'string') throw new OpenwopError('validation_error', 'fromRunId is required.', 400, { field: 'fromRunId', rule: 'required', reason: 'missing_run' });
      const fromId = storedRunId(body.fromRunId, tenantId);
      const run = fromId ? await deps.storage.getRun(fromId) : null;
      if (!run || run.tenantId !== tenantId) throw new OpenwopError('not_found', 'Run not found.', 404, { field: 'fromRunId', reason: 'missing_run' });
      // Review H3 — `wrapId` picks ONE turn/node of a multi-turn run; default is every call in order.
      const boundary = await listRunBoundary(tenantId, run.runId, typeof body.wrapId === 'string' ? { wrapId: body.wrapId } : {});
      if (boundary.length === 0) throw new OpenwopError('validation_error', 'That run has no captured tool calls (turn on capture for the agent, then run it again).', 400, { field: 'fromRunId', reason: 'nothing_captured' });
      // AEV-6 — a recorded FAILURE must replay as a failure. With RFC 0245
      // (`agents.evalSuite.fixtureErrors`, ADR 0929) it is promoted as an
      // `isError: true` fixture entry. Without the advert the fixture item has no
      // error field, so a failure would replay as a success: refuse rather than lie.
      const errored = boundary.filter((b) => b.isError);
      if (errored.length > 0 && evalSuiteCapability().fixtureErrors !== true) {
        throw new OpenwopError('validation_error', `That run's calls include ${errored.length} failed tool call(s), which a fixture cannot replay as failures yet; promote another turn or run.`, 400, {
          field: 'fromRunId', reason: 'errored_call', params: { calls: errored.map((b) => ({ wrapId: b.wrapId, seq: b.seq, tool: b.tool })) },
        });
      }
      const task = buildTaskFromRun({
        taskId: typeof body.taskId === 'string' ? body.taskId : `from-run-${run.runId.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        input: body.input !== undefined ? body.input : run.inputs,
        boundary,
        ...(typeof body.expectedContains === 'string' && body.expectedContains ? { expectedContains: body.expectedContains } : {}),
      });
      // EVD-4 — append through a compare-and-swap, so concurrent promotes (or a promote
      // racing an editor save) both land instead of one silently losing its task.
      const saved = await updateEvalSuite(tenantId, ref, (row) => {
        // Review L5 — a case captured from another agent would grade the wrong path. Same
        // escape hatch as `POST /runs {mode:"eval"}`; both spellings of one agent match (ADR 0763).
        const target = row.suite.targetAgentId;
        const foreign = target ? boundary.find((b) => agentStorageId(b.agentId) !== agentStorageId(target)) : undefined;
        if (target && foreign && body.overrideTargetAgent !== true) {
          throw new OpenwopError('validation_error', `That run's calls were made by ${foreign.agentId}, but suite ${ref} targets ${target}. Pass overrideTargetAgent: true to add it anyway.`, 400, { field: 'fromRunId', reason: 'agent_mismatch', params: { agentId: foreign.agentId, targetAgentId: target } });
        }
        return validateEvalSuite({ ...row.suite, tasks: [...row.suite.tasks, task] });
      });
      if (!saved) throw new OpenwopError('not_found', 'Eval suite not found.', 404, {});
      res.status(201).json(pub(saved));
    } catch (err) { next(err); }
  });

  // The Evals tab's history: this tenant's eval runs, content-free projections.
  app.get(`${BASE}/runs`, async (req, res, next) => {
    try {
      const tenantId = await requireTenantRead(req);
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : HISTORY_DEFAULT_LIMIT;
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > HISTORY_MAX_LIMIT) {
        throw new OpenwopError('validation_error', `limit must be an integer in [1, ${HISTORY_MAX_LIMIT}].`, 400, { field: 'limit', rule: 'range', params: { min: 1, max: HISTORY_MAX_LIMIT, integer: true } });
      }
      const before = decodeCursor(req.query.cursor);
      // Indexed per suite (`workflowId = eval:<ref>`), never a scan of the tenant's runs.
      // Architect amendment 2 — pack suites too, or their runs never show in history.
      // EVAL-10 — only the refs this agent can run (one query per suite, not per every
      // suite of the tenant), each paged by the SAME cursor, merged, then cut to `limit`.
      const refs = (await listResolvableSuites(tenantId, agentId)).map((r) => suiteRef(r.suite));
      const runs = (await Promise.all(refs.map((ref) => deps.storage.listRuns({ tenantId, workflowId: evalWorkflowId(ref), limit: limitRaw + 1, ...(before ? { before } : {}) })))).flat();
      const matching = runs
        .filter((r) => r.tenantId === tenantId && isAgentEvalRun(r))
        // EVAL-6 — both ADR 0763 spellings of one agent are one history.
        .filter((r) => !agentId || agentStorageId((r.metadata?.eval as AgentEvalMeta).agentId) === agentStorageId(agentId))
        .sort(newerFirst);
      const page = matching.slice(0, limitRaw);
      const items = page
        .map((r) => {
          const m = r.metadata?.eval as AgentEvalMeta;
          const s = r.metadata?.evalSummary as { aggregateScore?: number; passed?: boolean; taskCount?: number; passedCount?: number; regression?: unknown; trialStats?: unknown } | undefined;
          return {
            runId: r.runId, status: r.status, createdAt: r.createdAt, completedAt: r.completedAt,
            suiteRef: m.suiteRef, agentId: m.agentId, baselineRunId: m.baselineRunId,
            regressionReason: regressionReasonOf(m),
            ...(s ? { aggregateScore: s.aggregateScore, passed: s.passed, taskCount: s.taskCount, passedCount: s.passedCount, regression: s.regression, trialStats: s.trialStats } : {}),
          };
        });
      const last = page[page.length - 1];
      res.json({ items, ...(matching.length > limitRaw && last ? { nextCursor: encodeCursor(last) } : {}) });
    } catch (err) { next(err); }
  });

  // Live per-trial progress (host-internal detail incl. judge reasons) for the
  // Evals tab scorecard. Same read gate; another tenant's run is a 404.
  app.get(`${BASE}/runs/:runId/progress`, async (req, res, next) => {
    try {
      const tenantId = await requireTenantRead(req);
      const id = storedRunId(req.params.runId ?? '', tenantId);
      const run = id ? await deps.storage.getRun(id) : null;
      if (!run || run.tenantId !== tenantId || !isAgentEvalRun(run)) throw new OpenwopError('not_found', 'Eval run not found.', 404, {});
      const m = run.metadata.eval as AgentEvalMeta;
      res.json({ runId: run.runId, status: run.status, suiteRef: m.suiteRef, agentId: m.agentId, progress: m.progress ?? {}, summary: run.metadata.evalSummary ?? null, regressionReason: regressionReasonOf(m), error: run.error ?? null });
    } catch (err) { next(err); }
  });
}
