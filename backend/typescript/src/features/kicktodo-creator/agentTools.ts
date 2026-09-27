/**
 * Challenge Author chat tools (ADR 0458 §2.1; ADR 0308 seam) — the two tools
 * that let the named Challenge Author read its candidates and IGNITE the
 * Challenge Factory from the ONE chat. Registered via `registerFeatureAgentTool`
 * and pack-allowlisted onto the Challenge Author ONLY (never the ADR 0315
 * default-on baseline; pinned by `kicktodo-challenge-author-prompt-parity.test`).
 *
 * Authorization is the ROUTE's predicate, shared (ADR 0458 CRITICAL-3): both
 * tools call the SAME `hasKicktodoManageAuthority` the authoring routes use, and
 * FAIL CLOSED without an acting human holding manage authority — a participant
 * who reaches the agent cannot drive the Factory. The READ tool fails EMPTY; the
 * ACTION tool returns a typed error.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { hasKicktodoManageAuthority } from '../featureRoute.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { surfaceDispatchedRun, type TurnRunDispatchSink } from '../../host/turnRunDispatch.js';
import { liveWebSearchConfigured } from '../../host/webResearchSurface.js';
import { getHeadlessAiDefault, resolveIgnitionAiBinding } from '../../host/headlessAi.js';
import { byokRunConfigurable } from '../../host/runCredentials.js';
import { probeProviderCapabilities } from '../../host/modelCapabilityProbe.js';
import { listSecretRefs, resolveSecret } from '../../byok/secretResolver.js';
import { isManagedRef, pickCredentialRef, refNamesProvider } from '../../aiProviders/credentialRefLadder.js';
import { createLogger } from '../../observability/logger.js';
import { createCandidate, getCandidate, listCandidates, ProhibitedTopicError } from './creatorService.js';
import { getPublication, publicationView } from './publishService.js';
import { ensureChallengeAuthor } from './challengeAuthorService.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID } from './builtinWorkflows.js';

const log = createLogger('kicktodo.challenge-author-tools');

export const KICKTODO_CANDIDATES_TOOL_ID = 'openwop:kicktodo.candidates';
export const KICKTODO_FACTORY_RUN_TOOL_ID = 'openwop:kicktodo.factory.run';

/** The scope every conversational tool call carries (ADR 0324 composer). */
export interface ToolScope {
  tenantId: string;
  actingUserId?: string | undefined;
  agentProfileId?: string | undefined;
  conversationId?: string | undefined;
  runId?: string | undefined;
  /** Present on the conversation transport — see `host/turnRunDispatch.ts`. */
  onRunDispatched?: TurnRunDispatchSink | undefined;
}

type ToolResult = { content: string; isError?: boolean };

/** A compact, model-facing candidate projection (stage + spine + draft binding). */
async function projectCandidate(tenantId: string, candidateId: string): Promise<Record<string, unknown> | null> {
  const c = await getCandidate(tenantId, candidateId);
  if (!c) return null;
  const publication = await getPublication(tenantId, candidateId);
  return {
    id: c.id,
    topic: c.topic,
    audience: c.audience,
    state: c.state,
    riskTier: c.riskTier,
    hasDossier: Boolean(c.dossier),
    sourceCount: c.dossier?.sources.length ?? 0,
    unsupportedClaimIds: c.dossier?.unsupportedClaimIds ?? [],
    ...(c.draft ? { draft: c.draft } : {}),
    ...(publication ? { publication: { approvalId: publication.approvalId, state: publicationView(publication).state } } : {}),
  };
}

/**
 * READ — own candidates + stage/spine state + draft binding. Fails EMPTY without
 * manage authority (the participant-reaching-the-agent guard). Exported for
 * direct authz testing (the `conveneSpecialist` precedent).
 */
export async function runCandidatesTool(_input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  if (!(await hasKicktodoManageAuthority(scope.tenantId, scope.actingUserId))) {
    return { content: JSON.stringify({ candidates: [] }) };
  }
  const candidates = await listCandidates(scope.tenantId);
  const projected: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const p = await projectCandidate(scope.tenantId, c.id);
    if (p) projected.push(p);
  }
  return { content: JSON.stringify({ candidates: projected }) };
}

/**
 * ACTION — ignite the Challenge Factory for a candidate (or create one from a
 * topic/audience and run it). Requires manage authority else a typed error;
 * ensures the named Challenge Author is provisioned; starts an ORDINARY run
 * (every run-level gate applies) and persists the inline `workflow_run` turn.
 * `deps` (the run-starter) is closure-bound at registration; exposed as the
 * first argument for direct testing.
 */
export async function runFactoryRunTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  if (!scope.actingUserId) {
    return { content: JSON.stringify({ error: 'acting_user_required' }), isError: true };
  }
  if (!(await hasKicktodoManageAuthority(scope.tenantId, scope.actingUserId))) {
    return { content: JSON.stringify({ error: 'forbidden', message: 'You need KickTodo manage authority to run the Challenge Factory.' }), isError: true };
  }
  const candidateIdInput = typeof input.candidateId === 'string' ? input.candidateId.trim() : '';
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  const audience = typeof input.audience === 'string' ? input.audience.trim() : '';
  // Cheap, I/O-free argument validation runs BEFORE the adapter pre-flight so a
  // malformed call still gets the precise `validation_error` it deserves rather
  // than a config diagnosis that isn't its actual problem.
  if (!candidateIdInput && !topic) {
    return { content: JSON.stringify({ error: 'validation_error', message: 'Pass a `candidateId` or a `topic` to run the Factory.' }), isError: true };
  }
  // PRE-FLIGHT (2026-07-25 incident). The Factory's research spine is fail-closed
  // on demo sources — `recordDossier` throws `StubSourceError` when any source
  // carries `engine: 'stub' | 'demo'`. With no live search adapter configured
  // EVERY source is demo, so the run is dead on arrival: it burns a candidate,
  // executes a node or two, then dies with nothing to show. Refuse up front —
  // BEFORE creating a candidate — and say exactly what the operator must
  // configure, instead of starting a run whose only possible outcome is a silent
  // failure the agent then narrates to the user as success.
  // 'durable': the dossier STORES these citations and a human approves a
  // publication on them, so a provider whose terms license its links only for
  // display alongside the grounded answer must not qualify here.
  if (!(await liveWebSearchConfigured(scope.tenantId, 'durable'))) {
    return {
      content: JSON.stringify({
        error: 'research_adapter_unconfigured',
        message:
          // Written for the CREATOR who will read it in chat, not the operator who
          // configures the fix: no env-var names, no "dossier"/"demo source"
          // jargon, and it names the person to ask because a workspace member may
          // have no Secrets Vault access at all. It also says plainly that nothing
          // was consumed, so re-running after the fix is obviously safe.
          'I can\'t start the Challenge Factory yet. It only builds a plan from real sources it can cite, and this workspace has no web search set up that it\'s allowed to cite from. '
          + 'A workspace admin can fix it in Settings → Secrets Vault by adding a web-search key — Exa, Brave or Tavily all work, and Exa\'s free tier covers about 20,000 searches a month. '
          + 'Nothing was created and no run was started — your idea is safe to try again once that\'s sorted.',
      }),
      isError: true,
    };
  }

  // AI PRE-FLIGHT (ADR 0706 §3.1). The factory's evidence nodes dispatch to a
  // provider FROZEN at ignition: the creator's explicit choice, else the
  // workspace's ADR 0110 default, else the chain's pinned defaults. Whatever is
  // resolved is checked HERE — capability and credential — with the same
  // "nothing was created" contract as the search pre-flight, because the old
  // failure (KTF-AG-1) was a run that started, burned a candidate and died at
  // `extract-claims` with `byok_required`.
  const ai = await resolveFactoryAi(deps, scope.tenantId, input);
  if ('error' in ai) return ai.error;

  // Resolve the candidate: an existing id, or create one from a topic.
  let candidateId: string;
  if (candidateIdInput) {
    const existing = await getCandidate(scope.tenantId, candidateIdInput);
    if (!existing) {
      return { content: JSON.stringify({ error: 'not_found', message: `Candidate ${candidateIdInput} not found.` }), isError: true };
    }
    candidateId = existing.id;
  } else if (topic) {
    try {
      const created = await createCandidate({
        tenantId: scope.tenantId,
        createdBy: scope.actingUserId,
        topic,
        audience,
        transformation: '',
        durationDaysTarget: 14,
        dailyMinutesTarget: 15,
      });
      candidateId = created.id;
    } catch (err) {
      if (err instanceof ProhibitedTopicError) {
        return { content: JSON.stringify({ error: 'prohibited_topic', message: err.message, signals: err.signals }), isError: true };
      }
      throw err;
    }
  } else {
    // Unreachable: the guard above returned when BOTH were empty, so `topic` is
    // non-empty here. Kept as a typed exhaustiveness stop rather than a duplicate
    // error string — if the guard above is ever weakened, this throws loudly in
    // tests instead of silently dispatching without a candidate.
    throw new Error('unreachable: runFactoryRunTool reached candidate resolution with neither candidateId nor topic');
  }

  // Ensure the named Challenge Author exists (idempotent — first manage touch).
  const author = await ensureChallengeAuthor(scope.tenantId);

  const cand = await getCandidate(scope.tenantId, candidateId);
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: CHALLENGE_FACTORY_WORKFLOW_ID,
    inputs: {
      candidateId,
      topic: cand?.topic ?? topic,
      audience: cand?.audience ?? audience,
      authorSubject: scope.actingUserId,
      // ADR 0706 — the frozen binding rides the run record (replay-neutral):
      // the chain's `provider`/`model`/`credentialRef` params, which the four
      // LLM nodes and the lesson-batch child forward to `ctx.callAI`.
      ...ai.inputs,
    },
    // …and the ref is REGISTERED on the run so `prepareRunSecrets` resolves it
    // into the run's secret set — an input alone never reaches dispatch
    // (`host/runCredentials.ts`).
    configurable: ai.configurable,
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      challengeFactory: { candidateId, agentId: author.rosterId },
    },
  });
  if (!runId) {
    return { content: JSON.stringify({ error: 'dispatch_failed', message: 'The Challenge Factory workflow could not start.' }), isError: true };
  }
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId: author.rosterId, workflowId: CHALLENGE_FACTORY_WORKFLOW_ID, workflowName: 'Challenge Factory' }, 'kicktodo-factory-run');
  log.info('challenge_factory_dispatched', { tenantId: scope.tenantId, candidateId, runId, provider: ai.inputs.provider, model: ai.inputs.model, aiSource: ai.source });
  return { content: JSON.stringify({ runId, candidateId, provider: ai.inputs.provider, model: ai.inputs.model }) };
}

/** Where a factory run's frozen AI binding came from. */
type FactoryAiSource = 'creator' | 'workspace-default' | 'chain-pin';

/** The frozen AI binding for one factory run, or the typed refusal. */
type FactoryAiResolution =
  | {
      inputs: { provider: string; model: string; credentialRef?: string };
      configurable: Record<string, unknown>;
      source: FactoryAiSource;
    }
  | { error: ToolResult };

const NOTHING_CREATED = 'Nothing was created and no run was started — your idea is safe to try again once that\'s sorted.';

/**
 * ADR 0706 §3.1 — resolve the provider/model/credential a factory run will
 * dispatch with, and refuse (typed, creator-facing, "nothing was created") when
 * it cannot work:
 *
 *   1. binding: creator choice → workspace ADR 0110 default → the chain's own
 *      pinned defaults (read from the registered definition's `variables[]`,
 *      never duplicated here);
 *   2. capability: the provider must advertise `structured-output` — every
 *      evidence node dispatches with a `responseSchema`, and the RFC 0031 gate
 *      is host-scoped (ADR 0505 correction) so it cannot protect a per-run
 *      provider. `openwop-free` advertises nothing ⇒ refused (ADR 0505 OQ3
 *      stays honest);
 *   3. credential: the SAME ladder the dispatcher runs (`pickCredentialRef`),
 *      over the tenant's vault refs — an explicit ref must exist, else the
 *      provider's exact/prefixed ref; a managed ref needs no vault entry.
 *
 * The ref it picks is passed EXPLICITLY (input + `configurable.credentialRefs`),
 * so the run uses exactly the key the pre-flight checked — not whichever
 * prefixed ref happens to sort first at dispatch.
 */
async function resolveFactoryAi(deps: StartRunDeps, tenantId: string, input: Record<string, unknown>): Promise<FactoryAiResolution> {
  // A model or key named without a provider would be silently dropped and the
  // run would go ahead on the default — refuse instead, so the creator's words
  // are either honoured or rejected, never ignored (review of #3889, nit 6).
  const namedProvider = typeof input.provider === 'string' && input.provider.trim() !== '';
  if (!namedProvider && ((typeof input.model === 'string' && input.model.trim()) || (typeof input.credentialRef === 'string' && input.credentialRef.trim()))) {
    return { error: { content: JSON.stringify({ error: 'validation_error', message: 'Pass `provider` together with `model` or `credentialRef`; on their own they would be ignored.' }), isError: true } };
  }
  const binding = await resolveIgnitionAiBinding(tenantId, { provider: input.provider, model: input.model, credentialRef: input.credentialRef });
  let provider = binding?.provider ?? '';
  let model = binding?.model ?? '';
  let source: FactoryAiSource = binding?.source ?? 'chain-pin';
  if (!binding) {
    // The chain's pinned defaults are the SSoT for "no binding" — read them
    // from the registered definition rather than restating them here.
    const wf = await deps.hostSuite.workflowCatalog.getWorkflow(CHALLENGE_FACTORY_WORKFLOW_ID);
    const vars = wf?.definition.variables ?? [];
    const dflt = (name: string): string => {
      const v = vars.find((x) => x.name === name);
      return v && typeof v.defaultValue === 'string' ? v.defaultValue : '';
    };
    provider = dflt('provider');
    model = dflt('model');
    source = 'chain-pin';
  }
  if (!provider) {
    // No binding and no pinned default — the definition is not the factory we
    // know. Refuse rather than start a run that resolves "undefined".
    return { error: { content: JSON.stringify({ error: 'ai_provider_unresolved', message: `I can't start the Challenge Factory: this workspace has no AI provider set for it. A workspace admin can set a default AI provider in Settings → Secrets Vault. ${NOTHING_CREATED}` }), isError: true } };
  }

  if (!probeProviderCapabilities(provider).includes('structured-output')) {
    return {
      error: {
        content: JSON.stringify({
          error: 'ai_provider_unsupported',
          provider,
          message:
            `I can't start the Challenge Factory on ${provider}: it needs an AI provider that returns structured JSON, and this workspace's choice doesn't. `
            + 'Anthropic, OpenAI and Google all work — a workspace admin can set the default AI provider in Settings → Secrets Vault. '
            + NOTHING_CREATED,
        }),
        isError: true,
      },
    };
  }

  // A managed ref (`managed:*`) routes to the managed tier, which refuses any
  // request carrying a `responseSchema` (`callAIManaged` → host_capability_missing)
  // — and every factory AI node sends one. Admitting it would start a run that
  // can only die at extract-claims (review of #3889, finding 1).
  if (binding?.credentialRef && isManagedRef(binding.credentialRef)) {
    return {
      error: {
        content: JSON.stringify({
          error: 'ai_provider_unsupported',
          provider,
          reason: 'managed_tier_no_structured_output',
          message:
            "I can't start the Challenge Factory on the free managed AI: it needs structured JSON answers, which the managed tier doesn't provide. "
            + 'A workspace admin can add an Anthropic, OpenAI or Google key in Settings → Secrets Vault. '
            + NOTHING_CREATED,
        }),
        isError: true,
      },
    };
  }

  const refuse = (reason: string, why: string): FactoryAiResolution => ({
    error: {
      content: JSON.stringify({
        error: 'ai_credential_missing',
        provider,
        reason,
        message:
          `I can't start the Challenge Factory yet. It runs on ${provider} for this workspace, and ${why}. `
          + `A workspace admin can add a ${provider} key in Settings → Secrets Vault, or pick a different default AI provider there. `
          + NOTHING_CREATED,
      }),
      isError: true,
    },
  });

  // An explicit ref must belong to the provider it is sent to: the provider's
  // own name, a `provider-*` / `provider:*` ref, or the workspace default's
  // bound ref for that provider. Otherwise a creator-named ref such as a payment
  // key would be sent to Google as its API key (review of #3889, finding 3).
  if (binding?.credentialRef) {
    const ref = binding.credentialRef;
    const def = await getHeadlessAiDefault(tenantId);
    const ownsRef = refNamesProvider(ref, provider)
      || (def !== null && def.provider === provider && def.credentialRef === ref);
    if (!ownsRef) {
      return refuse('ref_not_for_provider', `the key it was asked to use (${ref}) isn't a ${provider} key`);
    }
  }

  const refs = await listSecretRefs({ tenantId });
  const pick = pickCredentialRef(provider, binding?.credentialRef, refs);
  if (pick.ref === null) {
    return refuse(pick.reason, pick.reason === 'explicit_ref_unresolved'
      ? `the key it's set to use (${binding?.credentialRef}) isn't in the Secrets Vault any more`
      : `there's no ${provider} API key in the Secrets Vault`);
  }
  // Listed is not the same as usable: with KMS unconfigured or a decrypt
  // failure, `prepareRunSecrets` would throw credential_unavailable AFTER the
  // candidate exists. Resolve it now, the way `setHeadlessAiDefault` does
  // (review of #3889, finding 5). The value never leaves this check.
  if (!(await resolveSecret(pick.ref, { tenantId }))) {
    return refuse('ref_unresolvable', `the key it's set to use (${pick.ref}) can't be read right now`);
  }
  const credentialRef = pick.ref;

  return {
    inputs: { provider, model, credentialRef },
    configurable: byokRunConfigurable(credentialRef),
    source,
  };
}

export function registerKicktodoCreatorAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_CANDIDATES_TOOL_ID,
      description:
        'List the workspace\'s Challenge Factory candidates with their pipeline stage (intake/researched/planned/published), '
        + 'risk tier, evidence-dossier state, the decomposed draft binding, and any pending publication approval. '
        + 'Use it to ground what the creator has in flight before proposing or running the Factory. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: runCandidatesTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_FACTORY_RUN_TOOL_ID,
      description:
        'Run the Challenge Factory for a challenge concept: deep web research → evidence → a plan outline you approve on an '
        + 'inline card → validated decomposition → a challenge-publish approval for a DIFFERENT person to decide. Pass an '
        + 'existing `candidateId`, OR a `topic` (and optional `audience`) to create the candidate and run it in one step. '
        + 'The run NEVER publishes on its own. Returns the started `runId` + `candidateId`. '
        // The model narrates from this text, so the preconditions and the honest
        // limits of the return value belong IN it: a `runId` means the run STARTED,
        // it does not mean the run will succeed. Telling the user an outline or an
        // approval card is coming is a claim this tool cannot support — the chat
        // renders the run bubble, which is the authoritative status surface.
        + 'REQUIRES a configured live web-search provider; without one it returns `research_adapter_unconfigured` and starts nothing. '
        // ADR 0706 — the AI leg is pre-flighted the same way. The model reads this
        // to narrate a refusal honestly; it must NOT turn it into a question — the
        // provider choice is honoured when the creator raises it, never prompted for.
        + 'Runs on the workspace\'s default AI provider (or the chain\'s pinned one); it REQUIRES a Secrets Vault key for that provider and a provider with structured output — otherwise it returns `ai_credential_missing` / `ai_provider_unsupported` and starts nothing. '
        + 'Do NOT ask the creator which AI provider to use; only pass `provider`/`model` when they explicitly named one. '
        + 'A returned `runId` means the run STARTED, not that it will succeed — do NOT promise an outline, an approval card, or a completion time. '
        + 'The run renders as a live progress bubble in this chat; let it report its own outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'An existing candidate to run the Factory for.' },
          topic: { type: 'string', description: 'A new challenge concept — creates the candidate, then runs the Factory.' },
          audience: { type: 'string', description: 'Who the challenge is for (optional; used when creating from a topic).' },
          provider: { type: 'string', description: 'ONLY when the creator explicitly named an AI provider for this run (e.g. `google`). Otherwise omit — the workspace default applies.' },
          model: { type: 'string', description: 'ONLY with `provider`, when the creator named a specific model id. Otherwise omit.' },
          credentialRef: { type: 'string', description: 'ONLY with `provider`, when the creator named which Secrets Vault key to use. Otherwise omit.' },
        },
        additionalProperties: false,
      },
    },
    run: (input, scope) => runFactoryRunTool(deps, input, scope),
  });
}
