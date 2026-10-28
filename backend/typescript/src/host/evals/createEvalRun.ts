/**
 * ADR 0889 D1 — create an eval run (`POST /runs {mode:"eval"}`, RFC 0081 §B).
 *
 * Called by the `/runs` handler AFTER its tenant/principal/scope checks and
 * INSIDE its idempotency claim; this owns everything eval-specific:
 *   - `evalSuiteRef` + `agentId` are REQUIRED (`spec/v2/core/runs.md` §Refusals);
 *   - the agent resolves through the SAME tenant gate as dispatch (404 for
 *     absent and not-yours alike — no cross-tenant existence leak);
 *   - requested modes ⊆ suite.modes ∩ host modes, else `400 validation_error`;
 *   - RFC 0251 (ADR 0983): `evalModes` / `baselineRunId` ride the body ROOT; an
 *     unusable baseline is ONE uniform refusal that never echoes the id;
 *   - a suite using an RFC 0244 feature the host does not advertise ⇒ `400`
 *     naming the field (RFC 0244 §G) — never graded as if the field were absent;
 *   - the scripted mock is test-seam only (`403` otherwise — runs.md §ai).
 * The run row goes through the ONE run-insert seam (`insertRunWithStartContext`,
 * so run-start contributors freeze compaction etc.) under the run limit, with
 * the idempotency commit in the same transaction. Execution starts after the
 * response, holding the dispatch lease (A1).
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../index.js';
import { buildRunRecord } from '../runDispatch.js';
import { insertRunWithStartContext } from '../runInsert.js';
import { withRunLimit } from '../runLimitSeam.js';
import { ownerStampFromRequest } from '../runOwner.js';
import { personalTenantOf } from '../requestSubject.js';
import { resolveAgentForTenant } from '../agentVisibility.js';
import { mockProviderEnabled } from '../../aiProviders/aiProvidersHost.js';
import { tenantEvalJudge } from '../workflowEvalJudge.js';
import { requestOrigin } from '../requestOrigin.js';
import { evalWorkflowId, IMPLEMENTED_MODES, MAX_TASKS_PER_SUITE, MAX_TRIALS, getEvalSuite, lockEvalSuite, suiteDigest, suiteFeatures, suiteRef, unlockEvalSuite, type AgentEvalSuite, type EvalMode, type StoredEvalSuite } from './suiteStore.js';
import { resolvePackSuite } from './packSuites.js';
import { agentStorageId } from '../../executor/agentIdAliases.js';
import { AGENT_SUITE_KIND, isAgentEvalRun, runAgentEval, type AgentEvalMeta } from './agentEvalRun.js';
import { evalSuiteCapability, rfc0244WireAvailable } from './evalCapability.js';
import { resolveFixtureSuite, scriptedEvalAgentFor } from './fixtureSuites.js';
import { storedRunId } from './runIds.js';
import { parseFixtureRuns, resolveRecordedFixtures, type SourceRunReader } from './recordedFixtures.js';
import { dropFrozenFixtures, freezeRecordedFixtures, type FrozenFixtureSet } from './toolBoundary.js';

/** taskId → source run of each frozen set (the run metadata keeps only these ids). */
const storedSources = (sets: Record<string, FrozenFixtureSet>): Record<string, string> =>
  Object.fromEntries(Object.entries(sets).map(([taskId, f]) => [taskId, f.sourceRunId]));
import { canonicalRequestDigest, idempotencyLeaseMs, RUNS_IDEMPOTENT_ENDPOINT, type IdempotentEndpoint } from '../idempotentResponse.js';
import { runWireUrls } from '../runWireUrls.js';


function bad(field: string, message: string, reason?: string, params?: Record<string, unknown>): never {
  throw new OpenwopError('validation_error', message, 400, { field, ...(reason ? { reason } : {}), ...(params ? { params } : {}) });
}

/**
 * WF-EV-9 — the `configurable` sections this lane honours. Anything else (run
 * timeouts, budgets, …) was accepted with a 201 and silently ignored; it is now
 * refused by name, never success-with-nothing.
 */
const EVAL_CONFIGURABLE_KEYS: ReadonlySet<string> = new Set(['evalModes', 'baselineRunId', 'ai', 'mockProvider']);

/** Who is creating the run — from an HTTP request (`callerFromRequest`) or a chat tool's scope. */
export interface EvalRunCaller {
  actingUserId: string;
  personalTenant?: string;
  owner?: ReturnType<typeof ownerStampFromRequest>;
  /** Origin for the response URLs; a chat tool has none and gets relative URLs. */
  origin?: string;
  /** The tenant the major-2 response projector binds ids with (`req.tenantId ??
   *  'default'`), so the URLs' run id equals the projected `runId` (ADR 0812 P4
   *  slice 2b). A chat tool has none and binds with the run's tenant. */
  wireTenant?: string;
}

export function callerFromRequest(req: Request, principalId: string): EvalRunCaller {
  const personalTenant = personalTenantOf(req);
  const owner = ownerStampFromRequest(req);
  return {
    actingUserId: req.userId ?? principalId,
    ...(personalTenant ? { personalTenant } : {}),
    ...(owner ? { owner } : {}),
    origin: requestOrigin(req),
    wireTenant: req.tenantId ?? 'default',
  };
}

export interface CreateEvalRunInput {
  caller: EvalRunCaller;
  storage: Storage;
  hostSuite?: Pick<HostAdapterSuite, 'providerPolicyResolver'>;
  body: Record<string, unknown>;
  tenantId: string;
  /** The negotiated major of an HTTP create. Under 2 the `configurable` spelling of
   *  `evalModes` / `baselineRunId` is refused (ADR 0983 D2); in-host callers omit it. */
  wireMajor?: 1 | 2;
  /** The `/runs` handler's claim; `endpoint` is ITS ledger literal, so a key replayed
   *  across the workflow and eval branches is one claim, not two. */
  idempotency?: { key: string; claimToken: string; endpoint: IdempotentEndpoint };
  /** ADR 0987 D2 — concurrency admission counted inside the run insert (the
   *  `/runs` handler passes the caller's scope; in-host callers omit it). A full
   *  scope throws `AdmissionRefusedError` and nothing is written. */
  admission?: { key: string; cap: number };
  /** RFC 0252 (ADR 0984) — reads a `fixtureRuns` source as THIS caller may (the
   *  run read's scope, tenant and payload checks). Absent ⇒ every source is refused. */
  readSourceRun?: SourceRunReader;
}

export interface CreateEvalRunResponse {
  runId: string;
  status: 'pending';
  eventsUrl: string;
  statusUrl: string;
}

/** Resolve a suite ref (D2): the tenant's store first, then the conformance fixture
 *  suites, then the requested agent's pack suite (`host/evals/packSuites.ts`). */
export async function resolveEvalSuite(
  tenantId: string,
  ref: string,
  agentId?: string,
): Promise<{ suite: AgentEvalSuite; source: 'tenant' | 'fixture' | 'pack'; pack?: string } | null> {
  const row = await getEvalSuite(tenantId, ref);
  if (row) return { suite: row.suite, source: 'tenant' };
  const fixture = resolveFixtureSuite(ref);
  if (fixture) return { suite: fixture, source: 'fixture' };
  if (agentId) {
    const packed = await resolvePackSuite(tenantId, agentId, ref);
    if (packed) return { suite: packed.suite, source: 'pack', pack: packed.pack };
  }
  return null;
}

export async function createAgentEvalRun(input: CreateEvalRunInput): Promise<CreateEvalRunResponse> {
  const { caller, storage, hostSuite, body, tenantId } = input;
  if (typeof body.evalSuiteRef !== 'string' || body.evalSuiteRef.length === 0) bad('evalSuiteRef', 'mode "eval" requires evalSuiteRef.');
  if (typeof body.agentId !== 'string' || body.agentId.length === 0) bad('agentId', 'mode "eval" requires agentId.');
  const suiteRefStr = body.evalSuiteRef;
  const agentId = body.agentId;

  const resolved = await resolveEvalSuite(tenantId, suiteRefStr, agentId);
  if (!resolved) throw new OpenwopError('not_found', `Eval suite ${suiteRefStr} was not found.`, 404, { evalSuiteRef: suiteRefStr });
  const { suite, source } = resolved;
  // A ref that names the pack's manifest path runs under the suite's canonical ref.
  const canonicalRef = source === 'pack' ? suiteRef(suite) : suiteRefStr;

  // The SAME tenant gate as `/agents/:agentId/dispatch` (404 covers absent AND not-yours).
  // ADR 0898 — under the eval-fixture opt-in the scripted agent is not in the
  // registry; it resolves here for a FIXTURE suite only, never for a tenant or pack suite.
  const agent = scriptedEvalAgentFor(agentId, source) ?? (await resolveAgentForTenant(agentId, tenantId));
  if (!agent) throw new OpenwopError('not_found', `agent '${agentId}' is not installed on this host`, 404, { agentId });
  // EVAL-6 / NP-EVAL-7 — both ADR 0763 spellings of one agent are the same target.
  if (suite.targetAgentId && agentStorageId(suite.targetAgentId) !== agentStorageId(agentId) && body.overrideTargetAgent !== true) {
    bad('agentId', `Suite ${suiteRefStr} targets ${suite.targetAgentId}; pass overrideTargetAgent: true to run it against ${agentId}.`, 'target_agent_mismatch', { targetAgentId: suite.targetAgentId });
  }
  // AEV-4 (create half) — `allowedModels` was validated and never read. The class
  // is the agent manifest's, the same source the runner stamps `evaluatedModelClass` from.
  if (suite.allowedModels && suite.allowedModels.length > 0 && !suite.allowedModels.includes(agent.modelClass)) {
    bad('agentId', `Suite ${suiteRefStr} allows model classes ${suite.allowedModels.join(', ')}; agent ${agentId} is ${agent.modelClass}.`, 'model_class_not_allowed', { modelClass: agent.modelClass, allowedModels: suite.allowedModels });
  }

  // Modes: requested ⊆ suite ∩ host (RFC 0081 §D).
  const configurable = (body.configurable && typeof body.configurable === 'object' ? body.configurable : {}) as Record<string, unknown>;
  for (const k of Object.keys(configurable)) {
    if (!EVAL_CONFIGURABLE_KEYS.has(k)) bad(`configurable.${k}`, `configurable.${k} is not supported on an eval run (supported: ${[...EVAL_CONFIGURABLE_KEYS].join(', ')}).`, 'unsupported_configurable');
  }
  // ADR 0983 D1/D2 — RFC 0251 puts both on the body ROOT. Under major 2 the old
  // `configurable` spelling was a bypass of the closed v2 body, so it is refused;
  // major 1 (open `configurable`) and the in-host callers keep it, with its old rules.
  if (input.wireMajor === 2) {
    for (const k of ['evalModes', 'baselineRunId'] as const) {
      if (configurable[k] !== undefined) bad(`configurable.${k}`, `Send ${k} at the body root (RFC 0251), not in configurable.`, 'moved_to_root');
    }
  }
  const rootModes = body.evalModes;
  const rootBaseline = body.baselineRunId;
  if (rootModes !== undefined && (!Array.isArray(rootModes) || rootModes.length === 0 || rootModes.some((m) => typeof m !== 'string') || new Set(rootModes).size !== rootModes.length)) {
    bad('evalModes', 'evalModes must be a non-empty array of distinct modes.');
  }
  const modesField = rootModes !== undefined ? 'evalModes' : 'configurable.evalModes';
  const modesIn = rootModes ?? configurable.evalModes;
  const requested = Array.isArray(modesIn) ? (modesIn as unknown[]) : suite.modes;
  for (const m of requested) {
    if (!suite.modes.includes(m as EvalMode)) bad(modesField, `Mode ${String(m)} is not declared by suite ${suiteRefStr}.`);
    if (!IMPLEMENTED_MODES.includes(m as EvalMode)) bad(modesField, `Mode ${String(m)} is not advertised by this host (agents.evalSuite.modes).`);
  }
  // RFC 0251 §B — on the wire spelling a baseline and `regression` come together.
  if (rootBaseline !== undefined && !requested.includes('regression')) {
    bad('baselineRunId', 'baselineRunId needs regression in evalModes.', 'baseline_without_regression');
  }
  if (Array.isArray(rootModes) && rootModes.includes('regression') && rootBaseline === undefined && configurable.baselineRunId === undefined) {
    bad('evalModes', 'regression in evalModes needs a baselineRunId.', 'regression_without_baseline');
  }

  // Host limits + RFC 0244 §G: a feature this host does not advertise is refused.
  const cap = evalSuiteCapability();
  if (suite.tasks.length > MAX_TASKS_PER_SUITE) bad('tasks', `Suite has ${suite.tasks.length} tasks; this host runs at most ${MAX_TASKS_PER_SUITE}.`);
  const f = suiteFeatures(suite);
  if (f.trajectory && cap.trajectory !== true) bad('tasks.expected.trajectory', 'This host does not advertise agents.evalSuite.trajectory.');
  if (f.trials > 1 && !cap.trials) bad('trials.count', 'This host does not advertise agents.evalSuite.trials.');
  if (cap.trials && f.trials > cap.trials.maxTrials) bad('trials.count', `trials.count ${f.trials} exceeds this host's maxTrials ${MAX_TRIALS}.`);
  if (f.fixtureMatching && cap.fixtureMatching !== true) bad('tasks.fixtures', 'This host does not advertise agents.evalSuite.fixtureMatching.');
  if (f.fixtureErrors && cap.fixtureErrors !== true) bad(firstIsErrorField(suite), 'This host does not advertise agents.evalSuite.fixtureErrors (RFC 0245 §C).');

  // Baseline (regression): a COMPLETED agent eval run of THIS tenant whose summary
  // graded the SAME suiteId (review L3 — pairing across suites is meaningless;
  // EVD-3 / EVAL-4 — a baseline with no summary produced no verdict).
  // ADR 0983 D3 (RFC 0251 §C) — every unusable value is ONE refusal, never echoing
  // the id: unknown, foreign or malformed (`storedRunId` → null), not an eval run,
  // another suite, not completed. A foreign run must read exactly as an unknown id,
  // or `scoreDelta` would leak its aggregate.
  // Architect finding: compare the summary's suiteId, never `suiteRef` — a fixture
  // run's ref is the conformance URI, not `suiteId@version`.
  let baselineRunId: string | undefined;
  const baselineIn = rootBaseline ?? configurable.baselineRunId;
  if (baselineIn !== undefined) {
    const id = typeof baselineIn === 'string' ? storedRunId(baselineIn, tenantId) : null;
    const base = id ? await storage.getRun(id) : null;
    const baseSummary = base?.metadata?.evalSummary as { suiteId?: unknown } | undefined;
    if (!base || base.tenantId !== tenantId || !isAgentEvalRun(base) || base.status !== 'completed' || !baseSummary || baseSummary.suiteId !== suite.suiteId) {
      bad(rootBaseline !== undefined ? 'baselineRunId' : 'configurable.baselineRunId', 'The baseline run cannot be used.', 'baseline_unusable');
    }
    baselineRunId = base.runId;
  }

  // RFC 0252 (ADR 0984) — tasks whose fixtures come from a recorded run. Every
  // refusal is before the run exists; an unusable source is one uniform refusal.
  let fixtureRuns: Record<string, string> | undefined;
  let recordedFixtures: AgentEvalMeta['recordedFixtures'];
  // ADR 0984 D7 — record-derived tasks: frozen in the governed store, not in metadata.
  let storedFixtures: Record<string, FrozenFixtureSet> | undefined;
  if (body.fixtureRuns !== undefined) {
    if (cap.recordedFixtures !== true) bad('fixtureRuns', 'This host does not advertise agents.evalSuite.recordedFixtures.');
    if (requested.includes('live-shadow')) bad(modesField, 'A live-shadow eval ignores fixtures, so it cannot take fixtureRuns.');
    fixtureRuns = parseFixtureRuns(body.fixtureRuns, new Map(suite.tasks.map((t) => [t.taskId, t.fixtures])));
    const resolvedFx = await resolveRecordedFixtures(fixtureRuns, input.readSourceRun, agentId, { allowErrors: cap.fixtureErrors === true, actingUserId: caller.actingUserId });
    recordedFixtures = {};
    for (const [taskId, entries] of Object.entries(resolvedFx.byTask)) {
      const rec = resolvedFx.fromRecord[taskId];
      if (rec) (storedFixtures ??= {})[taskId] = { ...rec, entries };
      else recordedFixtures[taskId] = entries;
    }
  }

  // Model: `configurable.ai` pin, or the scripted mock (test seams only).
  const ai = (configurable.ai && typeof configurable.ai === 'object' ? configurable.ai : {}) as Record<string, unknown>;
  const mockProvider = (configurable.mockProvider ?? ai.mockProvider) as Record<string, unknown> | undefined;
  let mock: AgentEvalMeta['mock'];
  if (mockProvider !== undefined) {
    if (!mockProviderEnabled()) throw new OpenwopError('forbidden', 'mockProvider is available on test hosts only.', 403, { field: 'configurable.mockProvider' });
    if (mockProvider.id !== 'tool-calls' || !mockProvider.rounds || typeof mockProvider.rounds !== 'object') bad('configurable.mockProvider', 'Expected { id: "tool-calls", rounds: { <taskId>: [ ...rounds ] } }.');
    mock = { rounds: mockProvider.rounds as Record<string, unknown[]> };
  }
  const model: AgentEvalMeta['model'] = {
    ...(typeof ai.provider === 'string' ? { provider: ai.provider } : {}),
    ...(typeof ai.model === 'string' ? { model: ai.model } : {}),
    ...(typeof ai.credentialRef === 'string' ? { credentialRef: ai.credentialRef } : {}),
  };

  const digest = suiteDigest(suite);
  const evalMeta: AgentEvalMeta = {
    kind: AGENT_SUITE_KIND,
    suiteRef: canonicalRef,
    suiteSource: source,
    // EVD-1 / WF-EV-8 — EVERY source is digest-stamped (it was pack-only), so resume
    // refuses a tenant suite redacted by erasure, or a fixture suite changed by a pin bump.
    ...(source === 'pack' ? { suitePack: resolved.pack } : {}),
    suiteDigest: digest,
    agentId,
    ...(baselineRunId ? { baselineRunId } : {}),
    ...(fixtureRuns ? { fixtureRuns, recordedFixtures } : {}),
    ...(storedFixtures ? { recordedFixturesStored: storedSources(storedFixtures) } : {}),
    ...(Object.keys(model).length > 0 ? { model } : {}),
    ...(mock ? { mock } : {}),
    rfc0244Wire: rfc0244WireAvailable(),
  };

  const now = new Date().toISOString();
  const run = buildRunRecord({
    workflowId: evalWorkflowId(canonicalRef),
    tenantId,
    scopeId: typeof body.scopeId === 'string' ? body.scopeId : undefined,
    inputs: { evalSuiteRef: canonicalRef, agentId },
    metadata: {
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { callerMetadata: body.metadata as Record<string, unknown> } : {}),
    },
    actingUserId: caller.actingUserId,
    ...(caller.personalTenant ? { personalTenant: caller.personalTenant } : {}),
    ...(caller.owner ? { owner: caller.owner } : {}),
    configurable: {},
    ...(input.idempotency ? { idempotencyKey: input.idempotency.key } : {}),
    now,
  });
  // A3 — the reserved `metadata.eval` key, with a kind. `buildRunRecord` strips
  // reserved keys from caller metadata, so this cannot be forged by the caller.
  run.metadata = { ...(run.metadata ?? {}), mode: 'eval', eval: evalMeta };

  const origin = caller.origin ?? '';
  const response: CreateEvalRunResponse = {
    runId: run.runId,
    status: 'pending',
    ...runWireUrls(origin, run.runId, caller.wireTenant ?? input.tenantId),
  };
  // Review M2 + EVD-1 — lock BEFORE the run row exists, and only if the stored
  // content is still the content resolved above (one compare-and-swap): a PUT in
  // between is `409 suite_changed`, never a run of one suite filed under another.
  let ourLock: StoredEvalSuite | undefined;
  if (source === 'tenant') {
    const lock = await lockEvalSuite(tenantId, suiteRefStr, digest);
    if (lock.lockedByUs) ourLock = lock.row;
  }
  try {
    // Frozen BEFORE the row exists, so the trial (started after the insert) finds them.
    if (storedFixtures) await freezeRecordedFixtures(tenantId, run.runId, storedFixtures);
    await withRunLimit(tenantId, () => insertRunWithStartContext(storage, run, {
      ...(input.admission ? { admission: input.admission } : {}),
      ...(input.idempotency
        ? {
            idempotencyCommit: {
              tenantId,
              endpoint: input.idempotency.endpoint,
              key: input.idempotency.key,
              claimToken: input.idempotency.claimToken,
              responseStatus: 201,
              responseBody: JSON.stringify(response),
              updatedAt: now,
            },
          }
        : {}),
    }));
  } catch (err) {
    // EVD-9 — a refused insert (run limit, quota) must not leave a draft locked forever.
    if (ourLock) await unlockEvalSuite(ourLock);
    if (storedFixtures) await dropFrozenFixtures(tenantId, run.runId, storedSources(storedFixtures)).catch(() => undefined);
    throw err;
  }

  const fresh = (await storage.getRun(run.runId)) ?? run;
  // In-request start, after the response is built; the runner never throws.
  setImmediate(() => {
    void runAgentEval({
      storage,
      run: fresh,
      suite,
      judge: tenantEvalJudge(tenantId),
      ...(hostSuite?.providerPolicyResolver ? { policyResolver: hostSuite.providerPolicyResolver } : {}),
    });
  });
  return response;
}

/** The `/runs` ledger the HTTP eval create claims under, so one ledger holds every lane. */
const RUNS_ENDPOINT: IdempotentEndpoint = RUNS_IDEMPOTENT_ENDPOINT;

/**
 * EVD-7 — create an eval run at most once per `dedupeKey`, for an in-app caller
 * with no HTTP `Idempotency-Key`: the chat `run` tool (keyed by its conversation
 * run + the args) and a chain node (keyed by `${parentRunId}:${nodeId}`). A model
 * re-issuing a call, or a crash-retried node, then gets the SAME eval run instead
 * of starting a second one that spends up to the suite ceiling again.
 *
 * It claims the SAME ledger `POST /runs` does (namespaced `eval-once:` so it can
 * never collide with a client's key): a completed claim replays its response
 * (`replayed: true`), a live one is `409 in_flight`, and a refusal before the
 * commit releases the key so a corrected retry is not locked out. With no
 * `dedupeKey` it is exactly `createAgentEvalRun`.
 */
export async function createAgentEvalRunOnce(
  input: Omit<CreateEvalRunInput, 'idempotency'> & { dedupeKey?: string },
): Promise<CreateEvalRunResponse & { replayed?: true }> {
  const { dedupeKey, ...rest } = input;
  if (!dedupeKey) return createAgentEvalRun(rest);
  const key = `eval-once:${dedupeKey}`;
  const claim = await rest.storage.claimIdempotentResponse({
    tenantId: rest.tenantId, endpoint: RUNS_ENDPOINT, key,
    requestDigest: canonicalRequestDigest(rest.body, RUNS_ENDPOINT),
    createdAt: new Date().toISOString(), leaseMs: idempotencyLeaseMs(),
  });
  if (claim.outcome === 'replay') return { ...(JSON.parse(claim.responseBody) as CreateEvalRunResponse), replayed: true };
  if (claim.outcome === 'in-flight') throw new OpenwopError('conflict', 'This eval run is already being started; read it again shortly.', 409, { reason: 'in_flight' });
  if (claim.outcome === 'mismatch') throw new OpenwopError('idempotency_key_mismatch', 'A different eval run was already started under this key.', 409, {});
  let held: string | undefined = claim.claimToken;
  try {
    const created = await createAgentEvalRun({ ...rest, idempotency: { key, claimToken: claim.claimToken, endpoint: RUNS_ENDPOINT } });
    held = undefined; // committed in the run-insert transaction
    return created;
  } finally {
    if (held) await rest.storage.releaseIdempotentResponse({ tenantId: rest.tenantId, endpoint: RUNS_ENDPOINT, key, claimToken: held }).catch(() => undefined);
  }
}

/** RFC 0245 §C — the refusal names the field: the first `isError: true` entry. */
function firstIsErrorField(suite: { tasks: ReadonlyArray<{ fixtures?: { toolResponses?: ReadonlyArray<{ isError?: boolean }> } }> }): string {
  for (let i = 0; i < suite.tasks.length; i += 1) {
    const j = (suite.tasks[i]!.fixtures?.toolResponses ?? []).findIndex((r) => r.isError === true);
    if (j >= 0) return `tasks[${i}].fixtures.toolResponses[${j}].isError`;
  }
  return 'tasks.fixtures.toolResponses.isError';
}
