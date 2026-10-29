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

import { resolveFrozenAiDefault } from '../../host/runAiDefault.js';
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
import { candidateRunKey, createCandidate, getCandidate, listCandidates, ProhibitedTopicError } from './creatorService.js';
import { getPublication, publicationView } from './publishService.js';
import { ensureChallengeAuthor } from './challengeAuthorService.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID } from './builtinWorkflows.js';
import { dedicatedFactoryProvider, factoryCredentialRef } from '../kicktodoFactoryAi.js';
import { PLAN_DAILY_MINUTES, PLAN_DURATION_DAYS } from './planService.js';
import { toolError, untrustedToolError } from '../../host/agentToolKit.js';

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

type ToolResult = { content: string; isError?: boolean; hostMessage?: true; fromThrow?: true };

/** A compact, model-facing candidate projection (stage + spine + draft binding). */
async function projectCandidate(tenantId: string, candidateId: string): Promise<Record<string, unknown> | null> {
  const c = await getCandidate(tenantId, candidateId);
  if (!c) return null;
  const publication = await getPublication(tenantId, candidateId);
  return {
    id: c.id,
    topic: c.topic,
    audience: c.audience,
    // XCH-CA-2 — the intake the creator agreed, so the agent reads it back
    // rather than re-asking (and can see what a candidate made elsewhere holds).
    transformation: c.transformation,
    durationDaysTarget: c.durationDaysTarget,
    dailyMinutesTarget: c.dailyMinutesTarget,
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
  // XCH-CA-2 — the intake the prompt collects (transformation, duration, daily
  // minutes) reaches the candidate instead of being replaced by hard-coded
  // defaults. Bounds are the plan validator's own (PLAN_DURATION_DAYS /
  // PLAN_DAILY_MINUTES), so an accepted target is one a plan can satisfy.
  const transformation = typeof input.transformation === 'string' ? input.transformation.trim() : '';
  const durationDays = intakeInt(input.durationDays, PLAN_DURATION_DAYS, 'durationDays');
  const dailyMinutes = intakeInt(input.dailyMinutes, PLAN_DAILY_MINUTES, 'dailyMinutes');
  // XCH-CA-1 — the checkpoint cadence the creator chose. Only the two cadences
  // the executor honours exist (lessonAssembly.ts CheckpointCadence).
  const cadenceRaw = typeof input.checkpointEvery === 'string' ? input.checkpointEvery.trim() : '';
  if (cadenceRaw && cadenceRaw !== 'outline-only' && cadenceRaw !== 'batched') {
    return toolError('validation_error', '`checkpointEvery` must be "batched" or "outline-only".');
  }
  for (const v of [durationDays, dailyMinutes]) if (v !== undefined && typeof v !== 'number') return v;
  // Cheap, I/O-free argument validation runs BEFORE the adapter pre-flight so a
  // malformed call still gets the precise `validation_error` it deserves rather
  // than a config diagnosis that isn't its actual problem.
  if (!candidateIdInput && !topic) {
    return toolError('validation_error', 'Pass a `candidateId` or a `topic` to run the Factory.');
  }
  const imageArgs = imageArgsError(input);
  if (imageArgs) return imageArgs;
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
    // TOC2CD-11 (ADR 1000) — a host sentence the agent relays and acts on: vouched, so unfenced.
    return toolError(
      'research_adapter_unconfigured',
      // Written for the CREATOR who will read it in chat, not the operator who
          // configures the fix: no env-var names, no "dossier"/"demo source"
          // jargon, and it names the person to ask because a workspace member may
          // have no Secrets Vault access at all. It also says plainly that nothing
          // was consumed, so re-running after the fix is obviously safe.
          'I can\'t start the Challenge Factory yet. It only builds a plan from real sources it can cite, and this workspace has no web search set up that it\'s allowed to cite from. '
          + 'A workspace admin can fix it in Settings → Secrets Vault by adding a web-search key — Exa, Brave or Tavily all work, and Exa\'s free tier covers about 20,000 searches a month. '
      + 'Nothing was created and no run was started — your idea is safe to try again once that\'s sorted.',
    );
  }

  // AI PRE-FLIGHT (ADR 0706 §3.1). The factory's evidence nodes dispatch to a
  // provider FROZEN at ignition: the creator's explicit choice, else the
  // workspace's ADR 0110 default, else the chain's pinned defaults. Whatever is
  // resolved is checked HERE — capability and credential — with the same
  // "nothing was created" contract as the search pre-flight, because the old
  // failure (KTF-AG-1) was a run that started, burned a candidate and died at
  // `extract-claims` with `byok_required`.
  const ai = await resolveFactoryAi(scope.tenantId, input);
  if ('error' in ai) return ai.error;
  // KTF-LB-1 / XCH-CA-5 — lesson images only when the creator asked for them,
  // pre-flighted like the AI leg so a media run cannot start and then die at
  // the first lesson for want of an image key.
  const image = await resolveFactoryImage(scope.tenantId, input);
  if (image && 'error' in image) return image.error;

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
      const intake = {
        topic,
        audience,
        transformation,
        durationDaysTarget: typeof durationDays === 'number' ? durationDays : 14,
        dailyMinutesTarget: typeof dailyMinutes === 'number' ? dailyMinutes : 15,
      };
      // KTFAC-1 — nothing per-CALL reaches a tool (the tool dispatcher passes
      // only the name and input; the provider call id is not threaded through), so the most
      // stable key is the chat TURN's run id + the intake. A retried call in the
      // same turn converges on one candidate; a new turn is a new ask and mints
      // fresh. Runless callers (direct tests) keep the fresh-id behaviour.
      const created = await createCandidate({
        tenantId: scope.tenantId,
        createdBy: scope.actingUserId,
        ...intake,
        ...(scope.runId ? { idempotencyKey: candidateRunKey(scope.runId, KICKTODO_FACTORY_RUN_TOOL_ID, intake) } : {}),
      });
      candidateId = created.id;
    } catch (err) {
      if (err instanceof ProhibitedTopicError) {
        return { content: JSON.stringify({ error: 'prohibited_topic', message: err.message, signals: err.signals }), isError: true, fromThrow: true };
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
      // ADR 0975 D3 — disambiguates the research search query (research-frame@1.1.0).
      ...((cand?.transformation ?? transformation) ? { transformation: cand?.transformation ?? transformation } : {}),
      authorSubject: scope.actingUserId,
      ...(cadenceRaw ? { checkpointEvery: cadenceRaw } : {}),
      // ADR 0706 — the frozen binding rides the run record (replay-neutral):
      // the chain's `provider`/`model`/`credentialRef` params, which the four
      // LLM nodes and the lesson-batch child forward to `ctx.callAI`.
      ...ai.inputs,
      ...(image ? image.inputs : {}),
    },
    // …and the ref is REGISTERED on the run so `prepareRunSecrets` resolves it
    // into the run's secret set — an input alone never reaches dispatch
    // (`host/runCredentials.ts`). The image key, when there is one, joins it.
    configurable: image ? mergeCredentialRefs(ai.configurable, image.inputs.imageCredentialRef) : ai.configurable,
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
  return { content: JSON.stringify({ runId, candidateId, provider: ai.inputs.provider, model: ai.inputs.model, checkpointEvery: cadenceRaw || 'batched', generateMedia: image !== null, ...(image ? { imageProvider: image.inputs.imageProvider } : {}) }) };
}

/** The image providers a creator may name for lesson images. The host's image
 *  seam also accepts `mock` (test seam only), which is never offered here. */
const FACTORY_IMAGE_PROVIDERS = ['openai', 'google', 'replicate'] as const;
const FACTORY_IMAGE_DEFAULT_PROVIDER = 'openai';

type FactoryImageResolution =
  | { inputs: { generateMedia: true; imageProvider: string; imageCredentialRef: string } }
  | { error: ToolResult };

/** ADR 0910 D8 — the Factory's dedicated Vault ref for a provider. Kept apart from
 *  the workspace's chat keys so the Factory never borrows whichever provider key
 *  `pickCredentialRef` happens to list first, and chat never points at it.
 *  ADR 0975 D2 — defined once in `features/kicktodoFactoryAi.ts` (readiness reads it too). */
export { factoryCredentialRef };

/** ADR 0910 D8 — pick the Factory's key: an explicit ref wins (it was already
 *  checked to name the provider); else the dedicated `kicktodo-factory:<provider>`
 *  ref BY NAME when the Vault holds it; else the ordinary ladder, so a creator's
 *  personal workspace without a dedicated ref keeps working. */
export function pickFactoryCredentialRef(provider: string, explicit: string | undefined, refs: readonly string[]): ReturnType<typeof pickCredentialRef> {
  if (!explicit && refs.includes(factoryCredentialRef(provider))) return pickCredentialRef(provider, factoryCredentialRef(provider), refs);
  return pickCredentialRef(provider, explicit, refs);
}

/**
 * KTF-LB-1 / XCH-LB-6 — the lesson-image binding, or null when the creator did
 * not ask for images. The image leg never borrows the chat provider: image
 * generation is BYOK-only on this host (no managed image key), so the run needs
 * a Secrets Vault key for the image provider, checked here with the same
 * "nothing was created" contract as the AI pre-flight.
 */
async function resolveFactoryImage(tenantId: string, input: Record<string, unknown>): Promise<FactoryImageResolution | null> {
  if (input.generateMedia !== true) return null;
  const named = typeof input.imageProvider === 'string' ? input.imageProvider.trim() : '';
  const provider = named || FACTORY_IMAGE_DEFAULT_PROVIDER;
  const refuse = (why: string): FactoryImageResolution => ({
    error: {
      // TOC2CD-11 (ADR 1000) — `why` can name a tenant's secret ref: fenced detail.
      ...untrustedToolError(
        'image_credential_missing',
        'I can\'t build this challenge with lesson images yet: the image provider (below) has no usable key. '
          + 'A workspace admin can add that provider\'s key in Settings → Secrets Vault, or you can run it without images. '
          + NOTHING_CREATED,
        `${provider}: ${why}`,
        { provider },
      ),
    },
  });
  const refs = await listSecretRefs({ tenantId });
  const pick = pickFactoryCredentialRef(provider, undefined, refs);
  if (pick.ref === null || isManagedRef(pick.ref)) return refuse(`there's no ${provider} API key in the Secrets Vault`);
  if (!(await resolveSecret(pick.ref, { tenantId }))) return refuse(`its key (${pick.ref}) can't be read right now`);
  return { inputs: { generateMedia: true, imageProvider: provider, imageCredentialRef: pick.ref } };
}

/** The I/O-free half of the image arguments, checked with the other argument
 *  validation before any pre-flight. */
function imageArgsError(input: Record<string, unknown>): ToolResult | null {
  const named = typeof input.imageProvider === 'string' ? input.imageProvider.trim() : '';
  if (input.generateMedia !== undefined && typeof input.generateMedia !== 'boolean') {
    return toolError('validation_error', '`generateMedia` must be true or false.');
  }
  if (named && input.generateMedia !== true) {
    return toolError('validation_error', 'Pass `imageProvider` only with `generateMedia: true`; on its own it would be ignored.');
  }
  if (named && !(FACTORY_IMAGE_PROVIDERS as readonly string[]).includes(named)) {
    return toolError('validation_error', `\`imageProvider\` must be one of ${FACTORY_IMAGE_PROVIDERS.join(', ')}.`);
  }
  return null;
}

/** Add one more BYOK ref to a run's `configurable.credentialRefs`. */
function mergeCredentialRefs(configurable: Record<string, unknown>, ref: string): Record<string, unknown> {
  const existing = Array.isArray(configurable.credentialRefs) ? configurable.credentialRefs.filter((r): r is string => typeof r === 'string') : [];
  return { ...configurable, credentialRefs: existing.includes(ref) ? existing : [...existing, ref] };
}

/** An optional integer intake field: absent ⇒ undefined; present ⇒ the number,
 *  or the typed `validation_error` naming the plan validator's bounds. */
function intakeInt(raw: unknown, bounds: { min: number; max: number }, name: string): number | ToolResult | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < bounds.min || raw > bounds.max) {
    return toolError('validation_error', `\`${name}\` must be a whole number from ${bounds.min} to ${bounds.max}.`);
  }
  return raw;
}

/** Where a factory run's frozen AI binding came from. */
type FactoryAiSource = 'creator' | 'factory-key' | 'workspace-default' | 'host-default';

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
 *   1. binding: creator choice → workspace ADR 0110 default → the host default
 *      (ADR 0903: the workspace's active AI binding, else the catalog's
 *      recommended provider — the chain no longer pins one);
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
async function resolveFactoryAi(tenantId: string, input: Record<string, unknown>): Promise<FactoryAiResolution> {
  // A model or key named without a provider would be silently dropped and the
  // run would go ahead on the default — refuse instead, so the creator's words
  // are either honoured or rejected, never ignored (review of #3889, nit 6).
  const namedProvider = typeof input.provider === 'string' && input.provider.trim() !== '';
  if (!namedProvider && ((typeof input.model === 'string' && input.model.trim()) || (typeof input.credentialRef === 'string' && input.credentialRef.trim()))) {
    return { error: toolError('validation_error', 'Pass `provider` together with `model` or `credentialRef`; on their own they would be ignored.') };
  }
  // ADR 0975 D2 — with no creator choice, a stored Factory key (ADR 0910 D8) is the
  // Factory's binding, ahead of the workspace's general headless default: storing
  // it IS the operator saying which key the Factory runs on. Its credential is
  // left to `pickFactoryCredentialRef`, which takes the dedicated ref by name (the
  // ignition binding would otherwise inherit the default's own ref when the
  // providers coincide).
  const factoryProvider = namedProvider ? null : await dedicatedFactoryProvider(tenantId);
  const ignition = await resolveIgnitionAiBinding(tenantId, factoryProvider
    ? { provider: factoryProvider }
    : { provider: input.provider, model: input.model, credentialRef: input.credentialRef });
  const binding: { provider: string; model: string; credentialRef?: string; source: FactoryAiSource } | null = ignition && factoryProvider
    ? { provider: ignition.provider, model: ignition.model, source: 'factory-key' }
    : ignition;
  let provider = binding?.provider ?? '';
  let model = binding?.model ?? '';
  let source: FactoryAiSource = binding?.source ?? 'host-default';
  if (!binding) {
    // ADR 0903 — the factory chain no longer pins a vendor (its provider/model
    // params carry no default). With no creator choice and no ADR 0110 default,
    // use the SAME host default every other run gets: the workspace's active AI
    // binding, else the catalog's recommended provider. Resolved here, at
    // ignition, and passed explicitly — so the pre-flight checks the provider
    // the run will actually use.
    const host = await resolveFrozenAiDefault(tenantId);
    provider = host?.provider ?? '';
    model = host?.model ?? '';
    source = 'host-default';
  }
  if (!provider) {
    // No binding and no host default (an empty catalog). Refuse rather than
    // start a run that resolves "undefined".
    return { error: toolError('ai_provider_unresolved', `I can't start the Challenge Factory: this workspace has no AI provider set for it. A workspace admin can set a default AI provider in Settings → Secrets Vault. ${NOTHING_CREATED}`) };
  }

  if (!probeProviderCapabilities(provider).includes('structured-output')) {
    return {
      error: {
        // TOC2CD-11 (ADR 1000) — `provider` can be the creator's raw `provider` argument
        // (`resolveIgnitionAiBinding` does not validate it), so it is not host-only: fenced.
        ...untrustedToolError(
          'ai_provider_unsupported',
          'I can\'t start the Challenge Factory on this AI provider (named below): it needs an AI provider that returns structured JSON, and this one doesn\'t. '
            + 'Anthropic, OpenAI and Google all work — a workspace admin can set the default AI provider in Settings → Secrets Vault. '
            + NOTHING_CREATED,
          provider,
          { provider },
        ),
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
        // TOC2CD-11 (ADR 1000) — carries the unvalidated `provider` as a key: fenced whole.
        ...untrustedToolError(
          'ai_provider_unsupported',
          "I can't start the Challenge Factory on the free managed AI: it needs structured JSON answers, which the managed tier doesn't provide. "
            + 'A workspace admin can add an Anthropic, OpenAI or Google key in Settings → Secrets Vault. '
            + NOTHING_CREATED,
          undefined,
          { provider, reason: 'managed_tier_no_structured_output' },
        ),
      },
    };
  }

  const refuse = (reason: string, why: string): FactoryAiResolution => ({
    error: {
      // TOC2CD-11 (ADR 1000) — `provider` is not provably host-only and `why` can name a
      // tenant's secret ref: both go to the fenced detail, the instruction stays host text.
      ...untrustedToolError(
        'ai_credential_missing',
        'I can\'t start the Challenge Factory yet: its AI provider (below) has no usable key. '
          + 'A workspace admin can add that provider\'s key in Settings → Secrets Vault, or pick a different default AI provider there. '
          + NOTHING_CREATED,
        `${provider}: ${why}`,
        { provider, reason },
      ),
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
      || ref === factoryCredentialRef(provider) // ADR 0910 D8
      || (def !== null && def.provider === provider && def.credentialRef === ref);
    if (!ownsRef) {
      return refuse('ref_not_for_provider', `the key it was asked to use (${ref}) isn't a ${provider} key`);
    }
  }

  const refs = await listSecretRefs({ tenantId });
  const pick = pickFactoryCredentialRef(provider, binding?.credentialRef, refs);
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
    effect: 'read',
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
    effect: 'write',
    def: {
      name: KICKTODO_FACTORY_RUN_TOOL_ID,
      description:
        'Run the Challenge Factory for a challenge concept: deep web research → evidence → a plan outline you approve on an '
        + 'inline card → validated decomposition → a challenge-publish approval for a DIFFERENT person to decide. Pass an '
        + 'existing `candidateId`, OR a `topic` (with the agreed `audience`, `transformation`, `durationDays` and `dailyMinutes`) to create the candidate and run it in one step. '
        + 'Pass `checkpointEvery` as the creator chose: "batched" (the default — the build pauses for approval after each batch of lessons, at most four) or "outline-only" (approve the outline, then the lessons build without further stops). '
        + 'Pass `generateMedia: true` ONLY when the creator asked for lesson images; it REQUIRES a Secrets Vault key for the image provider, otherwise it returns `image_credential_missing` and starts nothing. Do NOT offer images unprompted. '
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
          transformation: { type: 'string', description: 'What a participant will be able to do at the end that they cannot do now (used when creating from a topic).' },
          durationDays: { type: 'integer', minimum: PLAN_DURATION_DAYS.min, maximum: PLAN_DURATION_DAYS.max, description: 'How many days the challenge runs (used when creating from a topic; default 14).' },
          dailyMinutes: { type: 'integer', minimum: PLAN_DAILY_MINUTES.min, maximum: PLAN_DAILY_MINUTES.max, description: 'Roughly how many minutes per day (used when creating from a topic; default 15).' },
          checkpointEvery: { type: 'string', enum: ['batched', 'outline-only'], description: 'The checkpoint cadence the creator chose. Omit for "batched".' },
          provider: { type: 'string', description: 'ONLY when the creator explicitly named an AI provider for this run (e.g. `google`). Otherwise omit — the workspace default applies.' },
          model: { type: 'string', description: 'ONLY with `provider`, when the creator named a specific model id. Otherwise omit.' },
          credentialRef: { type: 'string', description: 'ONLY with `provider`, when the creator named which Secrets Vault key to use. Otherwise omit.' },
          generateMedia: { type: 'boolean', description: 'true ONLY when the creator asked for an image with each lesson. Images are reviewed at each lesson checkpoint. Omit otherwise.' },
          imageProvider: { type: 'string', enum: [...FACTORY_IMAGE_PROVIDERS], description: 'ONLY with `generateMedia`, when the creator named an image provider. Otherwise omit (openai).' },
        },
        additionalProperties: false,
      },
    },
    run: (input, scope) => runFactoryRunTool(deps, input, scope),
  });
}
