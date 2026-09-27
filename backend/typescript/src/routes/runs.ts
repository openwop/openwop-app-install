/**
 * Canonical run-lifecycle routes:
 *   POST   /v1/runs                       — create
 *   GET    /v1/runs/{runId}               — snapshot
 *   POST   /v1/runs/{runId}/cancel        — cancel
 *   POST   /v1/runs/{runId}:fork          — fork from sequence
 *
 * Idempotency: HTTP layer keyed on `Idempotency-Key`; engine layer
 * keyed on `invocationId` per `spec/v1/idempotency.md` (the engine
 * layer lives in src/executor/invocationLog.ts and is invoked by node
 * implementations that make external calls).
 */

import { takeIdempotencyHold } from '../host/idempotencyHold.js';
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import type {
  CreateRunRequest,
  CreateRunResponse,
  ForkRunRequest,
  ForkRunResponse,
  RunSnapshot,
} from '@openwop/openwop';
import { IdempotentCommitRejectedError, type Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import { OpenwopError, type RunRecord } from '../types.js';
import { seedRunVariables, snapshotRunVariables, hydrateRunVariables, deferredConfigurableInputs } from '../host/variablesRuntime.js';
import { snapshotRunChannels, hydrateRunChannels } from '../host/channelsRuntime.js';
import { getRunAgent } from '../host/runAgentRuntime.js';
import type { AgentRef } from '../executor/types.js';
import { getChildParentNodeId } from '../executor/subWorkflowDispatcher.js';
// RFC 0151 §D — the rollup and the advert predicate it is paired with.
import { compensationStatusForRuns, type CompensationStatus } from '../host/compensationLedger.js';
import { advertisesCompensation } from '../host/compensationCapability.js';
import { snapshotCostRollup } from '../observability/costEmitter.js';
import { workflowBudgetExhausted } from '../host/workflowBudgets.js';
import { executeRun, snapshotFromEventPrefix, type SerializedSnapshot } from '../executor/executor.js';
import { forkDispatchOptions } from '../executor/forkInterrupts.js';
import { requestRunPause, clearRunPause, abortRunForPause, type RunPauseRequest } from '../executor/runLifecycle.js';
import { buildRunRecord, dispatchRunInBackground } from '../host/runDispatch.js';
import { ownerStampFromRequest, runOwner, runOwnerV2, type RunOwnerBlock, type RunOwnerBlockV2 } from '../host/runOwner.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { traceContextFromHeaders } from '../host/traceContext.js';
import { eraOf } from '../storage/eventEra.js';
import { currentContract } from '../storage/eventEraAdapter.js';
import { closeV2Snapshot } from '../host/v2Snapshot.js';
import {
  currentAuthority,
  forkAuthorityMetadata,
  readRecordedAuthority,
  RUN_AUTHORITY_METADATA_KEY,
} from '../host/authorityContext.js';
import { resolveRunDefinition } from '../host/resolveRunDefinition.js';
import { resolveLaunchWorkflow } from '../host/resolveLaunchDefinition.js';
import { approvalGatesWithGroupRole, validateApproverResolvability } from '../host/approverResolution.js';
import { listOrgs } from '../host/accessControlService.js';
import { CROSS_HOST_CAUSATION_HOST_ID, isPhase3Enabled } from './discovery.js';
import { getEventLog } from '../executor/eventLog.js';
import { runEtag, ifNoneMatchSatisfied, sendNegotiatedRunJson } from '../host/restTransport.js';
import { detectAndRecordReplayDivergence } from '../executor/replayDivergence.js';
import { validateRunInputs } from '../host/runInputValidation.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { resolveSecret } from '../byok/secretResolver.js';
import { runAiCredentialRefViolation } from '../host/runCredentials.js';
import { advertisedByokProviders } from '../aiProviders/aiProvidersHost.js';
import { createLogger } from '../observability/logger.js';
import { runQuotaMiddleware, reserveConcurrentSlot } from '../middleware/rateLimit.js';
import { negotiatedMajor, v2ErrorCode, v1, vendorTwin } from '../middleware/protocolVersion.js';
import { RUN_LIST, mintRunListCursor, parseRunListCursor } from '../host/runList.js';
import { requestOrigin } from '../host/requestOrigin.js';
import { fromWireRunId, toWireRunId } from '../host/v2Ids.js';
import { v2ConfigurableViolation } from '../host/v2Configurable.js';
import { cancelRunAndCascade, isTerminalRunStatus } from '../host/runCancel.js';
import { isManagedCredentialRef, MANAGED_DEFAULTING_TYPE_IDS } from '../providers/managedProvider.js';
import { managedAnonSignInRequired } from '../host/deployPosture.js';
import { requireProtocolScope, requireKeyLaneScope, holdsProtocolScope } from '../host/protocolAuthorization.js';
import { dataResidencyEnabled, dataResidencyRegions, residencyRegionAdmissible, readResidencyRegion } from '../features/cdp/dataResidency.js';
import { loadReadableRun, loadOwnedRun } from '../host/runAccess.js';
import { resolveRunArtifact } from '../host/runArtifactRead.js';
import { artifact10 } from '../host/a2aCodec10.js';
import { personalTenantOf } from '../host/requestSubject.js';
import {
  canonicalRequestDigest,
  idempotencyLeaseMs,
  redactKey,
  type IdempotentEndpoint,
} from '../host/idempotentResponse.js';
import { idempotencyOutcomeOf, recordIdempotencyClaim } from '../observability/metricSeams.js';
import { scrubSecretShaped } from '../host/redactSecrets.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { isForkMode } from '../host/forkModes.js';
import { effectIdFor } from '../host/effectIdentity.js';

const log = createLogger('routes.runs');

/** ADR 0549 P0 — this route's entry in the ledger's closed endpoint union. */
const RUNS_ENDPOINT: IdempotentEndpoint = 'POST:/v1/runs';

/* ADR 0549 P0 — the process-local `idempotencyBodyHashes` Map and this module's
 * private `hashRequestBody` are GONE, along with the comment that licensed
 * them ("the body-mismatch detection is a bonus, not a primary correctness
 * signal"). The digest is now a durable column on `idempotent_response`, so
 * mismatch detection survives a restart and is a primary signal. Body
 * canonicalization moved to the one owner, `host/idempotentResponse.ts`, which
 * both participating routes import — it used to be copy-pasted here and in
 * `routes/userAgents.ts`, two copies of one contract free to drift apart. */

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

/**
 * `CreateRunRequest` with `configurable` widened, because ONE handler serves
 * BOTH majors.
 *
 * SDK 2.x types `configurable` as `RunConfigurable` — the CLOSED, versioned
 * RFC 0171 §D.1 object (`version: 1` required, unknown root keys and dotted
 * keys refused). That is an accurate description of the major-2 wire, and this
 * host enforces it: `host/v2Configurable.ts` runs `v2ConfigurableViolation`
 * under major 2.
 *
 * It is NOT an accurate description of what this handler receives. Under major
 * 1 `configurable` is an open map validated against the workflow's own
 * `configurableSchema`, and the deferred-alias substitution below walks
 * arbitrary keys. Typing the parameter as the closed shape and then casting at
 * each use would assert something false three times over; the host's own
 * checker already takes `unknown` for precisely this reason.
 *
 * So the static type says "open map" and the RUNTIME decides which contract
 * applies, per major. Surfaced by the 1.7 -> 2.1 SDK bump, which narrowed the
 * type and made the old `as Record<string, unknown>` casts unsound.
 */
type HostCreateRunRequest = Omit<CreateRunRequest, 'configurable'> & {
  configurable?: Record<string, unknown>;
};


export function registerRunRoutes(app: Express, deps: Deps): void {
  const { storage, hostSuite } = deps;
  /**
   * `details.retryAfter` (seconds) on the in-flight 409 — `idempotency.md`
   * §Concurrent duplicates names the field ("retry briefly"). The in-flight
   * holder is bounded by the request timeout, but a caller that waits the
   * whole timeout is a caller that could have blocked instead; one second is
   * the "briefly" the spec means, and the conformance scenario asserts only
   * that it is a positive number.
   */
  const IDEMPOTENCY_IN_FLIGHT_RETRY_AFTER_S = 1;

  // ── RFC 0049 scope inventory for the protocol run/artifact surface ──────────
  // (ADR 0006 Phase 3; enforced only when OPENWOP_AUTHORIZATION_ENFORCEMENT=on).
  // EVERY run/artifact route below carries an explicit `requireProtocolScope`.
  // Keep this table in sync when adding a route — an ungated route is an
  // authorization hole the moment enforcement is turned on (code-review #8):
  //   runs:create  → POST /v1/runs · POST /v1/runs/{id}:fork
  //   runs:read    → GET  /v1/runs · GET /v1/runs/{id} · GET /v1/runs/{id}:diff ·
  //                  GET  /v1/runs/{id}/ancestry · …/events/poll · …/debug-bundle
  //   runs:cancel  → POST /v1/runs/{id}/cancel · POST /v1/runs:bulk-cancel ·
  //                  DELETE /v1/runs/{id} (destructive ≥ cancel)
  //   artifacts:read → GET /v1/runs/{id}/artifacts/{aid} (its own middleware)
  // DELIBERATELY UNGATED: /v1/runs/{id}/annotations is RFC 0056 *feedback*
  // surface (capabilities.feedback), NOT the RFC 0049 run-lifecycle vocabulary —
  // it has no run-scope mapping and gating it would over-reach RFC 0049.

  app.post(v1('/runs'), runQuotaMiddleware(), async (req, res, next) => {
    // ADR 0549 P1 — hoisted ABOVE the try so the `finally` can see them. The
    // release is owed by whoever wins a claim, and the only scope that reliably
    // runs on every exit path is a `finally` sibling to the try.
    let heldClaimToken: string | undefined;
    let heldKey: string | undefined;
    let heldTenantId: string | undefined;
    try {
      const body = req.body as HostCreateRunRequest;
      if (!body || typeof body !== 'object' || !body.workflowId) {
        throw new OpenwopError('invalid_request', 'workflowId is required', 400);
      }
      // `inputs`, when present, is the per-run variable map — `inputs[name]` seeds the
      // variable bag (host/variablesRuntime.ts). It MUST be a JSON object, never an
      // array or primitive. Reject a malformed shape with a clean 400 rather than
      // accepting it (and silently dropping every value) or letting it reach a node
      // that dereferences it as a map — a client that posts the workflow's
      // `variables[]` CONTRACT as `inputs` is the reported failure mode.
      if (body.inputs !== undefined && body.inputs !== null && (typeof body.inputs !== 'object' || Array.isArray(body.inputs))) {
        throw new OpenwopError('invalid_request', 'inputs must be a JSON object mapping variable names to values (not an array or primitive).', 400);
      }
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);

      // WHD-14 — `callbackUrl` is REFUSED, not accepted. Until this guard the host
      // copied `body.callbackUrl` onto the RunRecord, persisted it in both storage
      // adapters, and NOTHING ever read it back: a client that asked for a callback
      // got a `201` and a callback that never came. That is success-with-nothing —
      // the accepted request is a promise this host has no code to keep.
      //
      // What the wire says (read before "fixing" this by delivering): both majors
      // DEFINE the member and neither defines a delivery contract for it. It is
      // `callbackUrl: { type: string, format: uri }` described only as "Signed-token
      // HITL callback URL (see `interrupt.md`)" (`api/openapi.yaml:248-251`,
      // `api/v2/openapi.yaml:220-223`; `spec/v2/core/runs.md:40` lists it among the
      // closed create-body members as "the signed-token callback, interrupt.md").
      // Neither `spec/v1/interrupt.md` nor `spec/v2/core/interrupt.md` mentions the
      // member at all: they specify the INBOUND token surface
      // (`POST /interrupts/{token}`, itself only a SHOULD) and say nothing about
      // what a host POSTs to a caller-supplied URL, when, with what body, signed
      // how, or retried how often. The one sentence that touches it
      // (`spec/v1/rest-endpoints.md:229`, "…where the server POSTed a callback URL
      // to an external system at suspension time") is descriptive, carries no RFC
      // 2119 keyword, and there is no capability flag a host could use to say
      // "I deliver these". So delivery is undefined host behaviour, and inventing a
      // payload here would be minting wire shape without an RFC.
      //
      // Refusing is therefore the smallest honest behaviour, and it is a
      // `validation_error` on BOTH majors: the member is optional and
      // capability-less, so `capability_not_provided` (which names an ADVERTISED
      // capability id) has nothing to name, and the v2 registry has no
      // "defined-but-unimplemented member" row. `details.field` follows the
      // run-options guards below. The refusal sits before tenant/workflow
      // resolution and before the Idempotency-Key claim, so it creates no run and
      // strands no ledger row. `null` and non-strings are refused by the same arm —
      // they are schema-invalid anyway, and the message stays true for them.
      //
      // Measured before shipping (a refusal that broke a caller would be worse than
      // the lie): no conformance scenario in the pinned suite, no SPA code, no pack
      // and no example sends `callbackUrl` on run creation. The suite's only use of
      // the word is `interrupt-external-event-correlation`, which READS
      // `interrupt.callbackUrl` off the snapshot — a different, host-minted field
      // (see the GET projection below) that this guard does not touch.
      //
      // If a future RFC gives the member delivery semantics, do NOT build a second
      // sender: ride the ONE outbound path (`host/webhookDeliveryWorker.ts` behind
      // `host/webhookEgressGuard.ts` — SSRF-guarded, signed, durable) and delete
      // this guard in the same change.
      if (body.callbackUrl !== undefined) {
        sendError(
          res,
          400,
          'validation_error',
          'This host does not deliver run callbacks, so `callbackUrl` is refused rather than accepted and ignored. Register a webhook subscription (POST /webhooks) for run events, or resolve interrupts through the signed-token surface (POST /interrupts/{token}).',
          { field: 'callbackUrl', reason: 'callback_delivery_not_supported' },
        );
        return;
      }

      // RFC 0129 (Active) / ADR 0290 — data-residency admission control. This is the
      // SINGLE run-admission owner honoring the residency contract: when the host
      // ADVERTISES residency (flag on) AND the request pins a `residency.region`, the
      // region MUST be one this host advertises, else reject FAIL-CLOSED here — before
      // any run is created (no runId in the response). An unadvertised host (flag off)
      // makes no residency promise and IGNORES the field entirely. Only admission is
      // enforced; physical byte-location is out-of-band (operator SHOULD), per ADR 0290.
      //
      // Envelope: the canonical FLAT `{ error: "<code>", message, details }`
      // (`schemas/error-envelope.schema.json`, `rest-endpoints.md` §"Error response
      // shape"). CORRECTED 2026-08-16 (H27 / S22): this comment used to claim RFC 0129 §3
      // and rest-endpoints.md "pin the NESTED `{ error: { code } }` shape … NOT this
      // app's legacy flat" one. Both halves were false — the flat shape is the SCHEMA,
      // not a local legacy, and the nested form was 2026-06→08 drift in the prose that
      // S22 removed. The `data-residency-admission` witness reads the code through the
      // corpus's `readErrorCode`, which takes the flat shape first.
      //
      // Emitted inline (never thrown) because admission must create no run; `sendError`
      // is the same envelope owner the middleware uses, so there is one shape either way.
      // The #815 "envelope-not-status" convention still holds: the witness asserts the
      // CODE, not the numeric status.
      if (dataResidencyEnabled()) {
        const region = readResidencyRegion(req.body);
        if (region !== undefined && !residencyRegionAdmissible(region)) {
          sendError(
            res,
            422,
            'residency_unavailable',
            'This host cannot honor the requested data-residency region.',
            { requestedRegion: region, availableRegions: dataResidencyRegions() },
          );
          return;
        }
      }

      // Tenant id: session-authed callers get their cookie-derived
      // tenant by default; explicit body.tenantId still works but the
      // principalAuthorizer rejects a mismatch. Bearer-authed callers
      // fall back to the body field or 'default'. Closes the
      // cross-tenant impersonation hole flagged in the P0.2 deploy
      // hardening for app.openwop.dev.
      // Empty-string body.tenantId (e.g., SPA submitting under the
      // authenticated session) falls through to req.tenantId. Non-empty
      // body.tenantId is honored verbatim and may be rejected by
      // principalAuthorizer if it doesn't match the principal's
      // allow-list.
      const bodyTenant = typeof body.tenantId === 'string' && body.tenantId.length > 0 ? body.tenantId : undefined;
      const tenantId = bodyTenant ?? req.tenantId ?? 'default';
      const allowed = await hostSuite.principalAuthorizer.authorize(
        principal,
        'run.create',
        { tenantId, scopeId: body.scopeId },
      );
      if (!allowed) throw new OpenwopError('forbidden_tenant', `principal cannot operate under tenant ${tenantId}`, 403);

      // RFC 0049 (ADR 0006 Phase 3) — membership-derived scope check, layered
      // ABOVE the principal/tenant authorize. No-op unless
      // OPENWOP_AUTHORIZATION_ENFORCEMENT is on (back-compat); then a caller
      // without `runs:create` in their resolved scopes is denied fail-closed.
      await requireProtocolScope(req, 'runs:create');

      const tenant = await hostSuite.tenantResolver.resolveTenant(tenantId);
      if (!tenant) throw new OpenwopError('forbidden_tenant', `tenant ${tenantId} not found`, 403);

      if (body.scopeId) {
        const scope = await hostSuite.scopeResolver.resolveScope(tenantId, body.scopeId);
        if (!scope) throw new OpenwopError('forbidden_scope', `scope ${body.scopeId} not in tenant ${tenantId}`, 403);
      }

      // ADR 0474 P1b — production launches run the PUBLISHED revision once one
      // exists; `metadata.launch === 'draft'` (host-local convention — the
      // builder's test-run) opts back into the head. Substitution happens
      // BEFORE validation/gates so every check sees the definition that runs.
      const launchDraft = (body.metadata as Record<string, unknown> | undefined)?.launch === 'draft';
      const wf = await resolveLaunchWorkflow(hostSuite.workflowCatalog, tenantId, body.workflowId, { launch: launchDraft ? 'draft' : 'published' });
      // ADR 0197 Phase 3 — best-effort input validation for schema-bearing
      // workflows. Always-on since ADR 0434 (the `run-input-forms` toggle
      // graduated; it was an explicit opt-in "until the toggle GAs"). Same 400
      // boundary as the inputs-shape check above; schema-less workflows are
      // untouched, and an uncompilable schema fails open in `validateRunInputs`.
      if (wf?.definition.inputSchema) {
        const inputErrors = validateRunInputs(wf.definition.inputSchema, body.inputs ?? {});
        if (inputErrors && inputErrors.length > 0) {
          throw new OpenwopError(
            'validation_error',
            `inputs do not satisfy the workflow's inputSchema: ${inputErrors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
            400,
            { errors: inputErrors },
          );
        }
      }
      // Capability-gated typeId refusal per `capabilities.md §"Unsupported
      // capability — refusal contract"`. When the workflow references a
      // gated typeId AND the host doesn't advertise the gating capability,
      // refuse with `validation_error + details.requiredCapability` at
      // run-create (one of the two boundaries the spec allows). The
      // workflow-register handler does the same check at register time.
      // ADR 0075 §D4 — HITL approver pre-flight + fail-closed org stamp. Resolved
      // here so it can flow into the run metadata; used by the interrupt-path
      // group/role eligibility + targeting once they promote (RFC 0104).
      let approverOrgId: string | undefined;
      if (wf) {
        const refusal = capabilityGatedTypeIdRefusal(wf.definition.nodes);
        if (refusal) throw refusal;
        // ADR 0504 — a run-start REFUSAL was built here and deliberately NOT
        // shipped. Measured first: `seedWorkflows.ts` expands every chain with
        // `{}`, so 114 of 169 seeded chains carry unfilled required params.
        // Refusing would have broken two thirds of every tenant's gallery —
        // a cure far worse than the disease. The finding is surfaced instead
        // (`metadata.unresolvedParams`, the `from-chain` response, and the
        // `seeded-chain-unfilled-params` ratchet), and the real fix is upstream:
        // seed in RFC 0124 DEFERRED mode so params become run-overridable
        // variables rather than freezing to `undefined`. See ADR 0504 §Open-1.
        // Scan approval gates that name group/role approvers; resolve the run's
        // org FAIL-CLOSED (the tenant's sole accessControl org, else none — never
        // guessed) and reject at create if any such approver resolves to nobody,
        // so a workflow can't suspend forever at a gate with no reachable human.
        const groupRoleGates = approvalGatesWithGroupRole(wf.definition.nodes);
        if (groupRoleGates.length > 0) {
          const tenantOrgs = await listOrgs(tenantId);
          approverOrgId = tenantOrgs.length === 1 ? tenantOrgs[0]!.orgId : undefined;
          await validateApproverResolvability(groupRoleGates, { tenantId, ...(approverOrgId ? { orgId: approverOrgId } : {}) });
        }
        // Managed-provider preflight: workflows that include any node
        // pinned to a `managed:*` credentialRef (the "Try it free" tile
        // and any future managed tile) require a signed-in user — the
        // managed dispatch path enforces a per-user-tenant daily token
        // cap which is meaningless for anon tenants. Without this
        // gate, an anon caller burns workflow-engine cycles on the
        // preceding non-LLM nodes and only fails mid-execution at the
        // first managed chat node. Surface the same `sign_in_required`
        // code at run-create so the UI can prompt for sign-in before
        // any work is done. Symmetrical with the capability-gated
        // refusal above.
        if (managedAnonSignInRequired()
          && tenantId.startsWith('anon:')
          && hasManagedCredentialRef(wf.definition.nodes)
        ) {
          throw new OpenwopError(
            'sign_in_required',
            'Sign in to use the free tier.',
            401,
          );
        }
        // `spec/v2/core/runs.md` §configurable — under major 2 `configurable` is
        // a CLOSED, nested, versioned object, so a dotted key or an unknown root
        // key that v1's open bag accepts is a `400 validation_error` here. Major
        // 1 skips this entirely: the v1 contract's `configurable` is open and
        // narrowing it would be a breaking change to a shipped wire.
        // `runs.md` §Run options (both majors' run-options schemas agree):
        // `tags` ≤ 100 entries, each a string of 1–256 chars, NEVER rejected on
        // format; `metadata` a plain object (≤ 50 KB serialized). Over a limit →
        // 400 validation_error. Measured 2026-09-05 (`4f74`): 101 tags → 201.
        const runOptionsViolation = validateRunOptionTagsAndMetadata(body);
        if (runOptionsViolation) {
          sendError(res, 400, 'validation_error', runOptionsViolation, { field: runOptionsViolation.startsWith('tags') ? 'tags' : 'metadata' });
          return;
        }
        // `runs.md` §Run options / `api/v2/openapi.yaml` createRun — the v2 create body is
        // the allOf of the base request (workflowId, inputs, mode, residency, scopeId,
        // tenantId, agentId, callbackUrl, evalSuiteRef) and `run-options.schema.json`
        // (tags, metadata, configurable), CLOSED at the composition: an unknown ROOT
        // key is 400 validation_error. Found by rc.54's `v2-run-options-limits`
        // (201 for `conformanceUnknownRootKey`). v1's open bag is untouched.
        if (negotiatedMajor(req) === 2) {
          const unknownRoot = Object.keys(body as Record<string, unknown>).find((k) => !V2_CREATE_ROOT_KEYS.has(k));
          if (unknownRoot !== undefined) {
            sendError(res, 400, 'validation_error', `Unknown root key "${unknownRoot}" on the create body (closed at the composition).`, { field: unknownRoot });
            return;
          }
        }
        if (negotiatedMajor(req) === 2 && body.configurable !== undefined) {
          const v2Violation = v2ConfigurableViolation(body.configurable);
          if (v2Violation) {
            throw new OpenwopError(
              'validation_error',
              `configurable is not valid under the v2 contract: ${v2Violation}`,
              400,
              { violation: v2Violation },
            );
          }
        }
        // Per-workflow configurableSchema validation per
        // `run-options.md §"Per-workflow configurableSchema"`: the
        // workflow MAY declare a JSON Schema; when present, the
        // request's `configurable` overlay MUST match. Mismatch
        // surfaces as 400 + validation_error with the schema's
        // first failure path in details.
        const schema = (wf.definition as { configurableSchema?: Record<string, unknown> }).configurableSchema;
        if (schema && body.configurable && typeof body.configurable === 'object') {
          const violation = validateAgainstSchema(schema, body.configurable as Record<string, unknown>);
          if (violation) {
            throw new OpenwopError(
              'validation_error',
              `Request configurable violates workflow's configurableSchema: ${violation}`,
              400,
              { workflowId: body.workflowId, violation },
            );
          }
        }
        // RFC 0124 §Security amendment — a SENSITIVE deferred param's `configurable`
        // value MUST be a resolvable secret REFERENCE (credentialRef), never a
        // plaintext: the value is seeded into the per-run variable bag (→
        // RunSnapshot.variables + at-rest persistence), so a plaintext secret would
        // leak exactly the way source:secret exists to prevent. A credentialRef is
        // opaque, so the only check is resolution — reject fail-closed if it doesn't
        // resolve in the caller's secret store (a plaintext / invalid ref won't).
        const deferredAliases = (wf.definition.metadata?.deferredParameterAliases ?? {}) as Record<string, string>;
        const sensitiveVarNames = new Set(
          (wf.definition.variables ?? [])
            .filter((v) => (v as { sensitive?: boolean }).sensitive === true)
            .map((v) => v.name),
        );
        if (sensitiveVarNames.size > 0 && body.configurable && typeof body.configurable === 'object') {
          const cfg = body.configurable as Record<string, unknown>;
          for (const [bare, varName] of Object.entries(deferredAliases)) {
            if (!sensitiveVarNames.has(varName)) continue;
            if (!Object.prototype.hasOwnProperty.call(cfg, bare)) continue;
            const ref = cfg[bare];
            const resolved =
              typeof ref === 'string' && ref.length > 0 ? await resolveSecret(ref, { tenantId }) : null;
            if (resolved === null) {
              throw new OpenwopError(
                'validation_error',
                `configurable['${bare}'] must be a resolvable secret reference (credentialRef) for the x-openwop-sensitive parameter — a plaintext value is not permitted (it would be persisted/exposed).`,
                400,
                { param: bare },
              );
            }
          }
        }
        // ADR 0712 — `configurable.ai.credentialRef` (v1 `run-options.md`, v2
        // `runs.md` §configurable): the run names the stored key its AI nodes use.
        // It MUST name a key of an advertised BYOK provider that resolves in the
        // tenant this route already authorized, else `403 credential_forbidden` —
        // BEFORE a run exists, so a picker run cannot start and die at its first
        // AI node. `prepareRunSecrets` then registers it (`declaredRunCredentialRefs`).
        {
          const credViolation = await runAiCredentialRefViolation(
            body.configurable as Record<string, unknown> | undefined, tenantId, advertisedByokProviders(),
          );
          if (credViolation) throw new OpenwopError('credential_forbidden', credViolation, 403);
        }
      }
      if (!wf) {
        throw new OpenwopError(
          'workflow_not_found',
          // Don't echo body.workflowId in the message — defense-in-depth
          // against credential-shaped canaries planted in user input.
          // The `details` field carries it through the sanitizer.
          'Workflow not found in this catalog.',
          404,
          { workflowId: body.workflowId },
        );
      }

      // Idempotency-Key handling per spec/v1/idempotency.md: atomic
      // claim → first caller proceeds, concurrent callers either get
      // the cached response (final) or 409 (still in flight). Body
      // hash check per `idempotency.md §Layer 1`: same key + different
      // body MUST return 409 idempotency_key_mismatch.
      //
      // ADR 0549 P0 — the claim is keyed (tenantId, endpoint, key), NOT the raw
      // header. `tenantId` here is the AUTHORIZED tenant: it has already passed
      // the `forbidden_tenant` check above, so it cannot be steered by the
      // request. Keying on the raw header alone let tenant B replay tenant A's
      // cached response, and let any caller collide with the daemons'
      // fire-once mutex keys.
      const idempotencyKey = req.header('idempotency-key') ?? undefined;
      // ADR 0549 P1 — set once this caller WINS a claim, cleared once the
      // response is committed. While it is set, the `finally` below owes the
      // key a release: without that, an exception between claim and commit
      // stranded the row `pending` and 409-locked the caller forever.
      if (idempotencyKey) {
        heldKey = idempotencyKey;
        heldTenantId = tenantId;
        const claim = await storage.claimIdempotentResponse({
          tenantId,
          endpoint: RUNS_ENDPOINT,
          key: idempotencyKey,
          requestDigest: canonicalRequestDigest(req.body, RUNS_ENDPOINT),
          createdAt: new Date().toISOString(),
          leaseMs: idempotencyLeaseMs(),
        });
        // ADR 0556 P1 — the ledger counters ADR 0549 P2 deferred here. Emitted
        // at the CLAIM, before any branch returns, so every outcome is counted
        // exactly once including the two that leave via a thrown 409.
        recordIdempotencyClaim(RUNS_ENDPOINT, idempotencyOutcomeOf(claim));
        if (claim.outcome === 'claimed') {
          heldClaimToken = claim.claimToken;
          // RFC 0213 §B witness (seams-v2 `armIdempotencyHold`, test seams only):
          // keep THIS claim in flight for the armed window, so a concurrent
          // same-key create meets the production in-flight branch below.
          const holdMs = takeIdempotencyHold(tenantId, idempotencyKey);
          if (holdMs !== undefined) await new Promise((r) => setTimeout(r, holdMs));
        }
        if (claim.outcome === 'mismatch') {
          throw new OpenwopError(
            // The canonical spelling (`idempotency.md` v1.5 §Layer 1, SP-03).
            // This PR originally left the old `idempotency_key_replay_mismatch`
            // in place on purpose — the rename is a wire-visible contract
            // decision and did not belong inside an atomicity change. It landed
            // as H63 (`92a3141e6`) while this branch was in flight, so the
            // revert has served its purpose and the canonical name is adopted
            // here rather than re-introduced.
            'idempotency_key_mismatch',
            'Idempotency-Key was previously used with a different request body.',
            409,
            { idempotencyKey },
          );
        }
        if (claim.outcome === 'replay') {
          // Per `rest-endpoints.md` POST /v1/runs response headers:
          // cache-served responses MUST carry `openwop-Idempotent-Replay:
          // true` so the client distinguishes a replayed response from
          // a fresh one (same runId, same status — header is the only
          // observable signal).
          //
          // Served through `res.json`, NOT `res.send(raw)`. The stored body is the
          // handler's response BEFORE the major-2 projection (`protocolVersion.ts`
          // wraps `res.json` to tenant-bind run ids and reshape the envelope), so
          // `send`-ing the raw string skipped it: the ORIGINAL answered
          // `runId: "default/<uuid>"` and the REPLAY answered `"<uuid>"`, which a
          // v2 client (and the 2.38.0 suite's `v2-idempotency-in-flight`) reads as
          // TWO runs for one key — RFC 0213 §B / idempotency.md Concurrency.
          // Major 1 is unaffected: its `res.json` leaves the body as it was.
          res.status(claim.responseStatus).set('openwop-Idempotent-Replay', 'true');
          let replayBody: unknown;
          try {
            replayBody = JSON.parse(claim.responseBody);
          } catch {
            // A stored body this host did not write as JSON: return it verbatim
            // rather than inventing one (the pre-fix behaviour).
            res.type('application/json').send(claim.responseBody);
            return;
          }
          res.json(replayBody);
          return;
        }
        if (claim.outcome === 'in-flight') {
          // Concurrent request still in flight. Per `idempotency.md` we
          // don't speculatively wait — return 409 and let the caller retry.
          // ADR 0744 — retry timing ALSO rides `Retry-After` (v2 `errors.md`
          // §Retry timing): the v2 negotiator strips `details.retryAfter`, so
          // without the header a major-2 loser learned nothing about when.
          res.setHeader('Retry-After', String(IDEMPOTENCY_IN_FLIGHT_RETRY_AFTER_S));
          throw new OpenwopError(
            'idempotency_in_flight',
            'A request with this Idempotency-Key is currently in flight; retry after it completes.',
            409,
            { idempotencyKey, retryAfter: IDEMPOTENCY_IN_FLIGHT_RETRY_AFTER_S },
          );
        }
      }

      // ADR 0482 §5 — daily hard cap. Review M1: checked AFTER the
      // idempotency-cache hit path — an Idempotency-Key retry of a run that
      // already created must return the cached 201 (idempotency.md), never a
      // 429 minted by the run's own spend. FAIL-OPEN inside the helper (a
      // budget-store outage never blocks production); debug/eval/redrive
      // lanes have their own routes and are deliberately not checked.
      if (await workflowBudgetExhausted(tenantId, body.workflowId)) {
        throw new OpenwopError(
          'rate_limited',
          'This workflow\'s daily budget is exhausted. Runs resume tomorrow (UTC), or raise the budget.',
          429,
          { reason: 'workflow_budget_exhausted', workflowId: body.workflowId },
        );
      }

      const now = new Date().toISOString();
      // ADR 0024 §4/D2 — stamp the AUTHENTICATED human onto the run so node
      // execution can resolve per-user credentials + `connections:use` as the
      // run owner. Host-authoritative: derived from the principal, overriding any
      // client-supplied metadata.actingUserId (a caller MUST NOT name another user).
      const actingUserId = req.userId ?? principal.principalId;
      // ADR 0627 D3 (review S2) — and the caller's OWN personal tenant, the same
      // `req.personalTenant` the HTTP lane's `isOwnPersonalWorkspace` reads, so a
      // req-less tenant gate in the tool lane can grant the implicit owner of an
      // `anon:<sid>` / `user:<hash>` sandbox (an anon principal has no user row
      // to derive it from). Host-authoritative + a reserved metadata key.
      const personalTenant = personalTenantOf(req);
      // Core seam (host/runDispatch.ts) — the one RunRecord constructor, shared
      // with the workflow-author draft route.
      const run = buildRunRecord({
        workflowId: body.workflowId,
        tenantId,
        scopeId: body.scopeId,
        inputs: body.inputs ?? null,
        metadata: {
          // §Run options — the caller's `tags` and `metadata`, persisted on the
          // run and surfaced UNCHANGED on the snapshot. Kept under the host bag
          // (no storage migration) but under their own keys, so the host's own
          // stamps (engineVersion, variants) never leak as the caller's metadata.
          ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
          ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { callerMetadata: body.metadata as Record<string, unknown> } : {}),
          ...((body.metadata as Record<string, unknown>) ?? {}),
          // ADR 0075 §D3/§D4 — the run's resolved approver org, read verbatim by
          // group/role eligibility + targeting (replay-safe; never re-resolved).
          ...(approverOrgId ? { approverOrgId } : {}),
        },
        actingUserId,
        ...(personalTenant ? { personalTenant } : {}),
        // RFC 0165 §B (ADR 0625) — the owner + Subject, minted from the same
        // principal `actingUserId` comes from; read back by the snapshot, the
        // `run.started` echo, and copied verbatim onto forks.
        owner: ownerStampFromRequest(req),
        configurable: (body.configurable as Record<string, unknown>) ?? {},
        // No `callbackUrl` — WHD-14: the guard at the top of this handler refuses
        // it, so there is never a value to copy. The RunRecord field and its
        // storage column stay (rows written before the guard may carry one, and
        // dropping a column is a migration, not a bug fix) but nothing populates
        // them from the wire any more.
        idempotencyKey,
        now,
      });
      // ADR 0474 P1b (review F5) — stamped AFTER the build so the reserved-key
      // strip has run and a client value can never pose as the host's resolution.
      run.metadata = { ...(run.metadata ?? {}), launchResolved: wf.launchResolved };
      // RFC 0207 — the W3C trace context this run was CREATED under, persisted
      // so an outbound MCP request or A2A message made LATER (the executor runs
      // on `setImmediate`, and the durable path is redelivered by a timer
      // daemon with no request context at all) can still carry a child of the
      // caller's trace. Stamped here for the same reason `launchResolved` is:
      // AFTER the reserved-key strip, so a client-supplied `traceContext` can
      // never pose as the header the request actually arrived with.
      // Correlation only — never read as tenant, principal or scope.
      {
        const tc = traceContextFromHeaders((n) => req.header(n) ?? undefined);
        if (tc) run.metadata = { ...run.metadata, traceContext: tc };
      }
      const runId = run.runId;
      // The response is built BEFORE the insert (it needs only `runId` and the
      // request host) so that, when the caller holds an Idempotency-Key claim,
      // the ledger can be committed `completed` with this exact body INSIDE the
      // run insert's transaction (ADR 0549 H56, below).
      const response: CreateRunResponse = {
        runId,
        status: 'pending',
        eventsUrl: `${requestOrigin(req)}/v1/runs/${runId}/events`,
        statusUrl: `${requestOrigin(req)}/v1/runs/${runId}`,
      };
      // ADR 0551 P1 — `enqueueDispatch` makes the 201 below honest: the run row
      // and the dispatch-outbox row commit together, so a process death between
      // here and `dispatchRunInBackground` no longer strands an accepted run
      // `pending` forever. The setImmediate dispatch is now a wakeup hint.
      //
      // ADR 0549 H56 — `idempotencyCommit` makes the LEDGER honest the same way:
      // the run row and the completed ledger row commit together. Before this,
      // `completeIdempotentResponse` ran ~40 lines later, and both a crash and a
      // throw in between minted a SECOND run for one key (crash: the retry
      // reclaimed the expired pending row; throw: the `finally` released it).
      // Now either both landed or neither did. If another caller RECLAIMED the
      // key while this request ran (lease lapsed — a dead-holder signal that
      // was, this once, wrong), the compare-and-set inside the transaction
      // matches nothing, the run insert is rolled back, and the reclaimer's run
      // is the one that exists: mapped to the protocol's in-flight 409 below.
      try {
        await insertRunWithStartContext(storage, run, {
          enqueueDispatch: true,
          ...(wf ? { definition: wf.definition } : {}),
          ...(idempotencyKey && heldClaimToken
            ? {
                idempotencyCommit: {
                  tenantId,
                  endpoint: RUNS_ENDPOINT,
                  key: idempotencyKey,
                  claimToken: heldClaimToken,
                  responseStatus: 201,
                  responseBody: JSON.stringify(response),
                  updatedAt: now,
                },
              }
            : {}),
        });
      } catch (err) {
        if (err instanceof IdempotentCommitRejectedError) {
          // Nothing of ours exists — the insert rolled back. The `finally`
          // release with our (stale) token is a guaranteed no-op, so it is safe
          // to leave `heldClaimToken` set.
          res.setHeader('Retry-After', String(IDEMPOTENCY_IN_FLIGHT_RETRY_AFTER_S));
          throw new OpenwopError(
            'idempotency_in_flight',
            'A request with this Idempotency-Key was reclaimed by another caller while this one ran; retry to receive its result.',
            409,
            { idempotencyKey, retryAfter: IDEMPOTENCY_IN_FLIGHT_RETRY_AFTER_S },
          );
        }
        throw err;
      }
      // Committed — the `finally` must NOT release it now (release refuses a
      // completed row anyway; clearing the token keeps the intent legible).
      if (idempotencyKey && heldClaimToken) heldClaimToken = undefined;
      // Seed the per-run variable bag from workflow defaults +
      // request inputs. Per `host/variablesRuntime.ts`: `inputs[name]`
      // overrides `variables[].defaultValue` by variable name; vars
      // without an override and without a default are not seeded
      // (read surface returns undefined → key absent in JSON).
      // RFC 0124 — a deferred workflow ALSO accepts a `configurable` override
      // keyed by the BARE param name, mapped onto the prefixed variable via
      // `metadata.deferredParameterAliases` (configurable wins over inputs).
      seedRunVariables(
        runId,
        wf.definition.variables,
        deferredConfigurableInputs(wf.definition, body.configurable as Record<string, unknown> | undefined, body.inputs),
      );
      // Bind the run to a concurrent-runs slot (P0.4 rate limit) — the
      // middleware reserved abstract capacity in its pre-flight check,
      // and this call ties the reservation to the actual runId so the
      // runLifecycle bus can auto-release on run.completed / run.failed
      // / run.cancelled. No-op for routes outside the rate-limit
      // middleware (e.g., conformance harness bypass).
      reserveConcurrentSlot(req, runId);
      hostSuite.auditSink.record({
        principalId: principal.principalId,
        action: 'run.create',
        resource: `run:${runId}`,
        outcome: 'success',
        payload: { workflowId: body.workflowId, tenantId, scopeId: body.scopeId },
      });

      // (H56) The ledger was committed INSIDE the run insert above; there is
      // no separate `completeIdempotentResponse` step left to fail or to be
      // skipped by a crash.
      res.status(201).json(response);

      // Dispatch inline (core seam, shared with the workflow-author draft route).
      dispatchRunInBackground({ storage, run, definition: wf.definition, hostSuite });
    } catch (err) {
      next(err);
    } finally {
      if (heldKey && heldClaimToken && heldTenantId) {
        // Copied into consts so the narrowing survives into the `.catch`
        // closure — TS cannot prove a mutable binding is still set there.
        const key = heldKey;
        // Best-effort: a failed release just means the key stays 409-locked
        // until its lease expires, which is the pre-P1 behaviour, and never a
        // reason to mask the original error. This release can only ever hit a
        // `pending` row that has NO run behind it: since H56 the run row and the
        // ledger's `completed` land in one transaction, so a run that exists is
        // never released (release refuses a completed row) and a released row
        // never had a run. The earlier "strictly no worse" wording was wrong for
        // a run row that had already committed — that case no longer exists.
        await storage
          .releaseIdempotentResponse({
            tenantId: heldTenantId,
            endpoint: RUNS_ENDPOINT,
            key,
            claimToken: heldClaimToken,
          })
          .catch((e: unknown) =>
            log.warn('idempotency_release_failed', {
              key: redactKey(key),
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      }
    }
  });

  /**
   * GET /v1/runs — list recent runs for the authenticated tenant.
   *
   * Tenant scope is taken from req.tenantId (set by auth middleware
   * from the OIDC bearer or session cookie). Wildcard-tenant Bearer
   * callers (the conformance harness) can pass `?tenantId=foo` to
   * filter explicitly; otherwise tenant=* sees everything.
   *
   * Query params:
   *   status   optional run status filter
   *   limit    max rows (default 50, capped to 200)
   */
  app.get([v1('/runs'), vendorTwin('/runs')], async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read'); // RFC 0049 (ADR 0006 Phase 3) — owk_ key scopes always (ADR 0745 D2); membership only when enforced
      // RFC 0182 `listRuns` (ADR 0658) — under major 2, `GET /runs` is the
      // manifest-named protocol operation: tenant-scoped by construction,
      // closed snapshots, ids bound by the response projector, `limit`
      // clamped to the advertised `runList.maxPageSize`, a host-minted opaque
      // cursor (a foreign one is `400 validation_error`), and only the
      // advertised filters honoured. The v1 / vendor-twin list below is the
      // host-extension list it always was.
      if (negotiatedMajor(req) === 2) {
        const tenantId = req.tenantId ?? 'default';
        const rawLimit = req.query.limit;
        let limit: number = RUN_LIST.defaultPageSize;
        if (rawLimit !== undefined) {
          const n = Number(rawLimit);
          if (typeof rawLimit !== 'string' || !Number.isInteger(n) || n < 1) {
            throw new OpenwopError('validation_error', '`limit` MUST be a positive integer.', 400, { field: 'limit' });
          }
          limit = Math.min(n, RUN_LIST.maxPageSize);
        }
        let before: { createdAt: string; runId: string } | undefined;
        if (req.query.cursor !== undefined) {
          const parsed = typeof req.query.cursor === 'string' ? parseRunListCursor(req.query.cursor) : null;
          if (parsed === null) {
            throw new OpenwopError('validation_error', '`cursor` was not minted by this host.', 400, { field: 'cursor' });
          }
          before = parsed;
        }
        const filters: { workflowId?: string; status?: string } = {};
        for (const f of RUN_LIST.filters) {
          const v = req.query[f];
          if (typeof v === 'string' && v.length > 0) filters[f] = v;
        }
        const rows = await storage.listRuns({ tenantId, limit, ...filters, ...(before ? { before } : {}) });
        const runs = rows.map((r) => closeV2Snapshot(projectRunSnapshot(r)));
        const last = rows[rows.length - 1];
        const nextCursor = rows.length === limit && last !== undefined
          ? mintRunListCursor({ createdAt: last.createdAt, runId: last.runId })
          : undefined;
        res.json({ runs, ...(nextCursor !== undefined ? { nextCursor } : {}) });
        return;
      }
      const requestedTenant = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
      const principalTenants = req.principal?.tenants ?? [];
      const principalIsWildcard = principalTenants.includes('*');
      const tenantFilter = principalIsWildcard
        ? requestedTenant
        : (req.tenantId ?? undefined);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      // ADR 0482 review M2 — a server-side workflow filter so "this
      // workflow's recent runs" never depends on the tenant's global page
      // (the cost heatmap's 'latest run' was wrong for busy tenants).
      const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId : undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const runs = await storage.listRuns({
        ...(tenantFilter ? { tenantId: tenantFilter } : {}),
        ...(status ? { status } : {}),
        ...(workflowId ? { workflowId } : {}),
        limit,
      });
      // RFC 0151 §D — ONE ledger scan for the whole page. `listRuns` may filter
      // across tenants for a superadmin read, so the rollup is resolved per
      // tenant bucket rather than assuming one; a run whose tenant produced no
      // obligations still projects `none`, which is the §D value for it.
      const byTenant = new Map<string, string[]>();
      for (const r of runs) {
        const list = byTenant.get(r.tenantId);
        if (list) list.push(r.runId);
        else byTenant.set(r.tenantId, [r.runId]);
      }
      const compensation = new Map<string, CompensationStatus>();
      for (const [tid, ids] of byTenant) {
        for (const [runId, status] of await resolveCompensationStatuses(tid, ids)) {
          compensation.set(runId, status);
        }
      }
      res.json({ runs: runs.map((r) => projectRunSnapshot(r, compensation.get(r.runId))) });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0054 — GET /v1/runs/{runId}:diff?against={otherRunId}. MUST be
  // registered BEFORE the generic `GET /v1/runs/:runId` below, which
  // would otherwise match `{uuid}:diff` as a `:runId` path segment (the
  // colon is legal inside an Express path segment). Regex-literal pinned
  // like :fork. Returns a deterministic, replay-aware structured diff of
  // the two runs' event logs + terminal states.
  app.get(/^\/v1\/runs\/([^/:]+):diff$/, async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read'); // RFC 0049 (ADR 0006 Phase 3) — owk_ key scopes always (ADR 0745 D2); membership only when enforced
      const runId = (req.params as Record<string, string>)['0'];
      const against = typeof req.query.against === 'string' ? req.query.against : '';
      if (!runId) throw new OpenwopError('invalid_request', 'runId path segment required', 400);
      if (!against) throw new OpenwopError('invalid_request', 'against query parameter required', 400);

      const [runA, runB] = await Promise.all([storage.getRun(runId), storage.getRun(against)]);
      if (!runA) throw new OpenwopError('run_not_found', `run ${runId} not found`, 404);
      if (!runB) throw new OpenwopError('run_not_found', `run ${against} not found`, 404);

      // runs:read on BOTH runs (RFC 0054 §A; composes with RFC 0048
      // cross-workspace isolation). Wildcard principals (conformance /
      // admin) bypass the tenant scoping like the list-runs route.
      const tenants = req.principal?.tenants ?? [];
      const wildcard = tenants.includes('*');
      if (!wildcard && (!tenants.includes(runA.tenantId) || !tenants.includes(runB.tenantId))) {
        // Canonical `forbidden` (the RFC text says `run_forbidden`, but
        // that isn't in the canonical error vocabulary; using the generic
        // resource-forbidden code rather than expanding the set here).
        throw new OpenwopError('forbidden', 'caller lacks runs:read on both runs', 403);
      }

      const [eventsA, eventsB] = await Promise.all([
        getEventLog().list(runId, { fromSeq: -1, limit: 100_000 }),
        getEventLog().list(against, { fromSeq: -1, limit: 100_000 }),
      ]);
      // CS-WF-1/2 — the diff projects both snapshots; hydrate the durable
      // caches first so a cross-instance read doesn't diff against absence.
      await Promise.all([
        hydrateRunVariables(runId), hydrateRunVariables(against),
        hydrateRunChannels(runId), hydrateRunChannels(against),
      ]);
      // Both runs in one scan when they share a tenant (the ordinary case), two
      // when a superadmin diffs across tenants — never one scan per snapshot.
      const compA = await resolveCompensationStatuses(
        runA.tenantId,
        runA.tenantId === runB.tenantId ? [runA.runId, runB.runId] : [runA.runId],
      );
      const compB = runA.tenantId === runB.tenantId
        ? compA
        : await resolveCompensationStatuses(runB.tenantId, [runB.runId]);
      const diff = computeRunDiff(
        runId,
        against,
        eventsA,
        eventsB,
        projectRunSnapshot(runA, compA.get(runA.runId)),
        projectRunSnapshot(runB, compB.get(runB.runId)),
      );
      res.json(diff);
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/runs/:runId'), async (req, res, next) => {
    try {
      // Scope seam (RFC 0049) + tenant ownership — adds the tenant check this
      // read previously lacked (architecture review #1).
      const run = await loadReadableRun(req, storage, req.params.runId);
      // RFC 0115 — conditional GET. The ETag is a STRONG validator over the
      // run's latest persisted event-log sequence (architect pin: not a
      // wall-clock / cached projection), so it advances on every observable
      // transition and is stable while none occurs. Evaluate `If-None-Match`
      // FIRST and short-circuit a `304` before the snapshot projection + the
      // O(N) tenant-sibling scan below, so an unchanged poll is cheap.
      const etag = runEtag(run.runId, await storage.getMaxSequence(run.runId));
      res.setHeader('ETag', etag);
      res.setHeader('Vary', 'Accept-Encoding');
      if (ifNoneMatchSatisfied(req, etag)) {
        res.status(304).end();
        return;
      }
      // CS-WF-1/2 — a snapshot read may land on an instance that never
      // executed this run (multi-instance Cloud Run): hydrate the durable
      // write-through caches before projecting, so variables + channels
      // don't silently read as absent. No-op when already cached.
      await hydrateRunVariables(run.runId);
      await hydrateRunChannels(run.runId);
      const compensation = await resolveCompensationStatuses(run.tenantId, [run.runId]);
      const snapshot = projectRunSnapshot(run, compensation.get(run.runId));
      // Surface the current open interrupt (if any) for waiting-*
      // runs per `interrupt.md §Signed-token callback`. The first
      // open interrupt's token + callbackUrl is the externally-
      // observable handle clients use to resolve via
      // POST /v1/interrupts/{token}. `RunSnapshot.interrupt` is the
      // canonical shape (sdk/typescript/src/types.ts:RunSnapshot).
      // Surface spawned children per `interrupt-profiles.md
      // §openwop-interrupt-parent-child` so callers can reach the
      // child run for resolve / inspection. Indexed by parent_run_id —
      // the previous O(tenant) listRuns+filter scan blew the 30s
      // statement timeout at ~4k runs/tenant and 500ed EVERY snapshot
      // read (the 2026-07-14 silent-board incident). Parent and child
      // always share a tenant by construction (subWorkflowDispatcher).
      const children = await storage.listRunsByParent(run.runId);
      if (children.length > 0) {
        // The projection's OWN type, not the SDK's: `projectRunSnapshot` omits
        // `owner` and `agent` from `RunSnapshot` (see its docblock), so
        // asserting the SDK shape here would re-introduce exactly the two
        // claims that function is careful not to make.
        (snapshot as HostRunSnapshot & { childRuns?: Array<{ runId: string; status: string }> }).childRuns =
          children.map((c) => ({ runId: c.runId, status: c.status }));
      }
      if (run.status.startsWith('waiting-')) {
        const openInterrupts = await storage.listOpenInterrupts(run.runId);
        if (openInterrupts.length > 0) {
          const first = openInterrupts[0]!;
          // ADR 0755 D3 — the resume token IS the authority to answer the gate
          // (`POST /v1/interrupts/{token}` checks nothing else), so it is
          // projected only to a caller who could resolve it on the run-scoped
          // route: `approvals:respond`, not the `runs:read` this read needed. A
          // `?streamToken` read never gets it (a stream grant is not an approval
          // grant — runAccess.ts's own rule for `loadOwnedRun`).
          const mayResolve = typeof req.query?.streamToken !== 'string' && (await holdsProtocolScope(req, 'approvals:respond'));
          snapshot.interrupt = {
            kind: first.kind,
            nodeId: first.nodeId,
            ...(mayResolve
              ? {
                  interruptToken: first.token,
                  callbackUrl: `${req.protocol}://${req.get('host')}/v1/interrupts/${encodeURIComponent(first.token)}`,
                }
              : {}),
            data: first.data,
          };
        }
      }
      // RFC 0115 — negotiate `Content-Encoding` (gzip/zstd where the runtime
      // supports it); the decoded body is byte-identical to the identity JSON.
      //
      // `runs.md` §Snapshot — the v2 object is CLOSED, and the two additions
      // above (`childRuns`, `interrupt`) are host extensions v2 declares no seat
      // for. The projector already closed its own fields; closing again here is
      // what makes the CLOSURE hold over the body the route actually sends
      // rather than over an intermediate value.
      sendNegotiatedRunJson(req, res, currentContract() === 2 ? closeV2Snapshot(snapshot) : snapshot);
    } catch (err) {
      next(err);
    }
  });

  // `getArtifact` — RFC 0205 §A (ADR 0746). Auth stacks ABOVE existence
  // (`auth.md` §"Error envelope"; the `artifact-auth` scenario): 401 without a
  // Bearer → 405 for any other method → `artifacts:read` → tenant-scoped run
  // load → the announced artifact, every miss a non-disclosing 404. The Bearer
  // check is explicit because the auth middleware auto-issues anon cookies and
  // so never 401s on a missing Authorization header by itself.
  //
  // Content negotiation is major-2 only (§A.4: "This RFC changes nothing in
  // v1"): when `Accept` prefers `application/a2a+json` the body is an A2A
  // `Artifact` (`schemas/v2/artifact.schema.json`), else the host-defined JSON
  // object. `Vary: Accept` rides every negotiated answer (§A.2).
  const artifactPathRe = /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/;
  const A2A_MEDIA = 'application/a2a+json';
  app.use((req, res, next) => {
    const m = artifactPathRe.exec(req.path);
    if (!m) return next();
    const header = req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({
        error: 'unauthenticated',
        message: 'Artifact endpoint requires a Bearer token (anon session cookie is not sufficient).',
      });
      return;
    }
    // HEAD is GET without a body — Express answers it through the same handler
    // and drops the body itself, so it is served, not refused (ADR 0755, WIT-ART-9).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // RFC 9110 §15.5.6 — a 405 MUST name the methods the resource supports.
      res.setHeader('Allow', 'GET, HEAD');
      sendError(res, 405, 'method_not_allowed', `Artifact endpoint accepts GET only; received ${req.method}.`);
      return;
    }
    void (async () => {
      // Inside the async body so a malformed escape (`%E0`) is a 404 through
      // `next(err)`, not a synchronous URIError → 500.
      let runId: string;
      let artifactId: string;
      try {
        runId = decodeURIComponent(m[1] ?? '');
        artifactId = decodeURIComponent(m[2] ?? '');
      } catch {
        throw new OpenwopError('not_found', 'artifact not found', 404);
      }
      // RFC 0049 — `artifacts:read`, fail-closed (an `owk_` key's declared
      // scopes always, ADR 0745 D2; the insufficient_scope challenge rides the
      // refusal via next(err), #4113). The SSE stream grant does not open this
      // door (ADR 0746).
      const run = await loadReadableRun(req, storage, runId, { scope: 'artifacts:read', streamToken: false });
      const artifact = await resolveRunArtifact({
        storage,
        run,
        artifactId,
        subject: req.userId ?? req.principal?.principalId,
      });
      if (!artifact) {
        throw new OpenwopError('not_found', `artifact '${artifactId}' not found on run '${runId}'`, 404);
      }
      const negotiated = currentContract() === 2;
      if (negotiated) res.setHeader('Vary', 'Accept');
      if (negotiated && req.accepts(['application/json', A2A_MEDIA]) === A2A_MEDIA) {
        res.status(200).type(A2A_MEDIA).send(JSON.stringify(artifact10({
          artifactId: artifact.artifactId,
          ...(artifact.name ? { name: artifact.name } : {}),
          ...(artifact.description ? { description: artifact.description } : {}),
          body: artifact.body,
          ...(artifact.artifactType ? { artifactTypeId: artifact.artifactType } : {}),
        })));
        return;
      }
      res.status(200).json({
        artifactId: artifact.artifactId,
        runId,
        ...(artifact.nodeId ? { nodeId: artifact.nodeId } : {}),
        ...(artifact.artifactType ? { artifactType: artifact.artifactType } : {}),
        ...(artifact.name ? { name: artifact.name } : {}),
        mediaType: artifact.body.kind === 'data' ? 'application/json' : artifact.body.mediaType,
        payload: artifact.body.kind === 'data' ? artifact.body.data : artifact.body.text,
      });
    })().catch(next);
  });

  // RFC 0040 §C — cross-host run-ancestry endpoint. Opt-in within Phase 3:
  // served ONLY when this host advertises
  // `crossHostCausation.ancestryEndpointSupported: true` (gated on the
  // OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3 / _PHASE_4 envs, matching
  // discovery.ts); returns 404 otherwise. Returns the cross-host parent chain
  // per `run-ancestry-response.schema.json`: a top-level run → `parent: null`;
  // a dispatched/sub-workflow child → `parent: { runId, hostId, cause }`. This
  // single-host reference app never sets `wellKnownUrl` (same-host parents
  // only); a real cross-host deployer sets it for off-host parents.
  /**
   * RFC 0173 §C.2 — `GET /runs/{runId}/effects`, the Layer-2 effect ledger
   * projection. Content-free of provider payloads by construction: the storage
   * read returns identity and timing only, never the recorded `result`.
   *
   * TENANT-SCOPED THROUGH THE SHARED PREDICATE, not a copy of it. This read
   * leaks per-node effect timing, so it takes exactly the gate every other run
   * read takes — `loadReadableRun` 404s a non-owned run rather than answering
   * an empty projection, which would be a cross-tenant existence oracle.
   *
   * `keying` is `activity-recipe`, and that is the honest value rather than a
   * downgrade. `host/effectIdentity.ts` composes
   * `sha256(tenantId, runId, nodeId, ordinal, providerKey)` and deliberately
   * EXCLUDES `attempt` (RFC 0150 §B retired attempt-varying identity as a
   * safety fix). That is run-scoped — the activity recipe the schema names as
   * the documented fallback — and excluding `attempt` is precisely what makes
   * `v2-effect-identity-business-key`'s real requirement true here: the key is
   * stable across both transport attempts.
   */
  app.get(v1('/runs/:runId/effects'), async (req, res, next) => {
    try {
      const run = await loadReadableRun(req, storage, req.params.runId);
      const rows = await storage.listRunEffects(run.runId);
      res.json({
        runId: toWireRunId(run.runId, run.tenantId),
        effects: rows.map((r) => ({
          // Deterministic and tenant-bound (`ids.schema.json` §effectId):
          // a projection re-read must name the same effect, so the id is
          // DERIVED from the identity tuple rather than minted per request.
          // `attempt` is DELIBERATELY ABSENT from this preimage, and it used to be
          // present — which was a defect in the rule this projection exists to
          // witness. `idempotency.md` §Layer 2: the effect is "identified once and
          // stable across every transport or provider retry", and "the retry
          // counter MUST NOT participate in the identity". With `attempt` hashed
          // in, two attempts of ONE logical effect received two different
          // `effectId`s, so the ledger reported two effects where the spec says
          // there is one.
          //
          // The schema is built for the corrected shape: each record carries
          // `attempt` as its OWN field and there is no uniqueness constraint on
          // `effectId`, so N attempt-rows sharing one `effectId` is the intended
          // reading — the id names the effect, the field names the attempt.
          //
          // `invocationId` was already attempt-free by construction
          // (`host/effectIdentity.ts`: "`attempt` itself never enters the
          // preimage"), so the host's real identity was correct all along and only
          // this projection re-introduced the counter.
          effectId: effectIdFor({
            tenantId: run.tenantId,
            runId: run.runId,
            nodeId: r.nodeId,
            invocationId: r.invocationId,
          }),
          nodeId: r.nodeId,
          attempt: r.attempt,
          keying: 'activity-recipe' as const,
          // `invocationId` is what this host stores; `providerKey` is OPTIONAL
          // in the schema and is deliberately OMITTED rather than filled with
          // the invocation id under a different name. Migration 39 renamed the
          // provider-key column to `invocation_id`, so there is no provider key
          // to report — and an omitted optional field is honest where a
          // mislabelled one is not.
          invocationId: r.invocationId,
          // Only two states are reachable from this table, and that is a
          // faithful report rather than a gap: `state`'s own description says
          // the enum is "the VOCABULARY a host must label attempts with, not a
          // set of states every host must produce".
          state: r.completed ? ('completed' as const) : ('claimed' as const),
          at: r.at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/runs/:runId/ancestry'), async (req, res, next) => {
    try {
      if (!isPhase3Enabled()) {
        // Capability not advertised — the endpoint is opt-in even within
        // Phase 3 (RFC 0040 §C). 404 regardless of run existence.
        throw new OpenwopError('not_found', 'run-ancestry endpoint not enabled', 404);
      }
      // Tenant-ownership gate (2026-07 vuln-scan): ancestry is a READ that leaks
      // run existence + parentRunId, so it must be owner-scoped like every other
      // run read. loadReadableRun enforces tenant (wildcard-operator + streamToken
      // escape hatches) and 404s a non-owned run — no cross-tenant existence oracle.
      const run = await loadReadableRun(req, storage, req.params.runId);
      const parent =
        run.parentRunId !== undefined && run.parentRunId !== null
          ? {
              runId: run.parentRunId,
              // Same-host parent on this single-host reference app: hostId
              // equals our own, and `wellKnownUrl` is omitted (off-host
              // parents would set it).
              hostId: CROSS_HOST_CAUSATION_HOST_ID,
              // LIMITATION: `cause` is reported as the nominal same-host value
              // `core.subWorkflow`. `RunRecord` (src/executor/types.ts) tracks
              // only `parentRunId` and does not retain which composition
              // primitive created the child — both the `core.subWorkflow` and
              // `core.dispatch` dispatchers set `parentRunId` identically. The
              // schema enum (`run-ancestry-response.schema.json`) also admits
              // `core.dispatch`; distinguishing the two on the wire requires
              // persisting the composition mechanism on `RunRecord`, deferred
              // to a follow-up. Both values denote same-host composition, so
              // the nominal value is accurate at the cross-host boundary this
              // endpoint exists to serve.
              cause: 'core.subWorkflow' as const,
            }
          : null;
      res.status(200).json({
        runId: run.runId,
        hostId: CROSS_HOST_CAUSATION_HOST_ID,
        parent,
      });
    } catch (err) {
      next(err);
    }
  });

  // Bulk-cancel per `rest-endpoints.md §"POST /v1/runs:bulk-cancel"`.
  // Top-level 200 when the request reached the host (per-id outcomes
  // carry partial failure); 400 on empty / oversized runIds. The
  // canonical URL uses the `:bulk-cancel` action segment, which
  // Express 4 doesn't accept directly in a path string (path-to-regexp
  // treats `:` as a param prefix) — use a literal regex to match.
  const MAX_RUN_IDS = 100;
  app.post(/^\/v1\/runs:bulk-cancel$/, async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:cancel'); // RFC 0049 (ADR 0006 Phase 3) — owk_ key scopes always (ADR 0745 D2); membership only when enforced
      const body = (req.body ?? {}) as { runIds?: unknown; reason?: unknown };
      if (!Array.isArray(body.runIds) || body.runIds.length === 0) {
        throw new OpenwopError(
          'validation_error',
          'runIds MUST be a non-empty array of run-id strings.',
          400,
          { maxRunIds: MAX_RUN_IDS },
        );
      }
      if (body.runIds.length > MAX_RUN_IDS) {
        throw new OpenwopError(
          'validation_error',
          `runIds length ${body.runIds.length} exceeds maxRunIds ${MAX_RUN_IDS}.`,
          400,
          { maxRunIds: MAX_RUN_IDS },
        );
      }
      const reason = (typeof body.reason === 'string' ? body.reason : 'bulk cancel');
      const terminal = ['completed', 'failed', 'cancelled'];
      // Per-item tenant scoping (2026-07 vuln-scan): a bare getRun let a caller
      // bulk-cancel arbitrary CROSS-TENANT runs. Resolve the caller's authority
      // once, then report a non-owned run with the SAME `not_found` result as an
      // absent one (no existence oracle). Wildcard operators act across tenants.
      const callerTenant = req.tenantId ?? 'default';
      const isOperator = req.principal?.tenants?.includes('*') === true;
      const results: Array<{ runId: string; ok: boolean; status?: string; error?: Record<string, unknown> }> = [];
      // `identity.md` §5 — a major-2 caller holds the TENANT-BOUND id this host
      // handed it (`default/<uuid>`), and sends that back here. The path guard
      // (`middleware/v2Identity.ts`) resolves ids in the URL only; a BODY-borne
      // id reached `storage.getRun` raw, so every id a v2 client owned answered
      // `not_found` on the one bulk surface it could cancel them through — the
      // webhook defect inverted: projection applied on the way out and not on
      // the way in. Resolved through the same seam as the path, so the grammar
      // and the tenant check are one predicate, not a second drifting copy.
      const major = negotiatedMajor(req);
      // ADR 0632 (bus finding `cea0`) — under major 2 an `ok: false` entry's
      // `error` is the v2 ERROR ENVELOPE (`api/v2/openapi.yaml` bulkCancelRuns
      // results[].error $refs error-envelope.schema.json): `{ error, message,
      // details? }` with the code passed through the registry (unregistered
      // host codes vendor-prefixed), never the v1 `{ code, message }` object.
      // The v1 shape is unchanged on the v1 mount (its suite pins it).
      const entryError = (code: string, message: string, details?: Record<string, unknown>): Record<string, unknown> =>
        major === 2 ? { error: v2ErrorCode(code), message, ...(details ? { details } : {}) } : { code, message };
      for (const rawId of body.runIds) {
        if (typeof rawId !== 'string' || rawId.length === 0) {
          results.push({ runId: String(rawId), ok: false, error: entryError('invalid_request', 'runId MUST be a non-empty string') });
          continue;
        }
        let lookupId = rawId;
        if (major === 2 && rawId.includes('/')) {
          const resolved = fromWireRunId(rawId, callerTenant);
          if (!resolved.ok) {
            // Same non-disclosing shape as the path guard: a foreign or
            // malformed tenant-bound id is indistinguishable from a missing run.
            results.push({ runId: rawId, ok: false, error: entryError('not_found', `run ${rawId} not found`) });
            continue;
          }
          lookupId = resolved.runId;
        }
        const run = await storage.getRun(lookupId);
        if (!run || (!isOperator && run.tenantId !== callerTenant)) {
          results.push({ runId: rawId, ok: false, error: entryError('not_found', `run ${rawId} not found`) });
          continue;
        }
        if (terminal.includes(run.status)) {
          // Idempotent: re-cancelling an already-terminal run returns
          // ok with the existing terminal status. Conformance asserts
          // this directly per the "re-bulk-cancel after first cancel"
          // subtest.
          // `runs.md` §Cancel: `ok: true` carries `cancelling | cancelled` only. Under
          // major 2 an already-terminal run is `ok: false` + `run_terminal` (the bulk
          // twin of the single-cancel 409, #3650); v1 keeps its idempotent `ok: true`.
          if (major === 2) results.push({ runId: rawId, ok: false, error: entryError('run_terminal', `run ${rawId} is already ${run.status}`, { status: run.status }) });
          else results.push({ runId: rawId, ok: true, status: run.status });
          continue;
        }
        try {
          // ONE cancel recipe (host/runCancel.ts), the same as the single-cancel
          // route and A2A `CancelTask`. This loop used to carry its OWN copy,
          // which (a) skipped the normative child cascade and (b) turned a lost
          // race into `internal_error`: MEASURED in production (2026-09-22, rev
          // 00734), a run completing on another instance between the status read
          // above and the append made the store refuse `run.cancelled` (RFC 0194)
          // and the entry answered 500-shaped instead of `run_terminal`.
          const outcome = await cancelRunAndCascade(storage, run, reason);
          if (outcome === 'already-terminal') {
            const now = (await storage.getRun(lookupId))?.status ?? run.status;
            if (major === 2) results.push({ runId: rawId, ok: false, error: entryError('run_terminal', `run ${rawId} is already ${now}`, { status: now }) });
            else results.push({ runId: rawId, ok: true, status: now });
            continue;
          }
          results.push({ runId: rawId, ok: true, status: 'cancelled' });
        } catch (err) {
          results.push({ runId: rawId, ok: false, error: entryError('internal_error', err instanceof Error ? err.message : String(err)) });
        }
      }
      res.status(200).json({ results });
    } catch (err) {
      next(err);
    }
  });

  app.post(v1('/runs/:runId/cancel'), async (req, res, next) => {
    try {
      // Tenant-ownership gate (2026-07 vuln-scan): cancel is a MUTATION, so it uses
      // loadOwnedRun — which enforces run.tenantId ownership WITHOUT honoring the
      // read-only ?streamToken (a read grant must never authorize a cancel).
      const run = await loadOwnedRun(req, storage, req.params.runId, 'runs:cancel');
      if (isTerminalRunStatus(run.status)) {
        // `runs.md` §Cancel: the 200 grammar is `{ runId, status: cancelling | cancelled }`;
        // echoing `completed` is outside it, so under major 2 the conforming
        // refusal is the registered `409 run_terminal` (`4f74`). The 1.x mount
        // keeps its idempotent 200 — that contract never said otherwise.
        if (negotiatedMajor(req) === 2) {
          sendError(res, 409, 'run_terminal', `Run ${run.runId} is already ${run.status}.`, { status: run.status });
          return;
        }
        res.json({ runId: run.runId, status: run.status });
        return;
      }
      // The effect — including the normative child cascade — lives in
      // host/runCancel.ts so A2A 1.0's `CancelTask` (ADR 0552 P2) drives the
      // same recipe instead of a second one. This route keeps authorization
      // and the response shape.
      await cancelRunAndCascade(storage, run, (req.body?.reason as string) ?? 'cancelled by request');
      res.json({ runId: run.runId, status: 'cancelled' });
    } catch (err) {
      next(err);
    }
  });

  // Host-extension (NOT in the v1 wire contract): permanently delete a run
  // and its events/interrupts/invocation-log rows. The protocol has no run-
  // deletion surface (see admin.ts); this is sample-app cleanup UX. Tenant-
  // scoped: a caller may only delete a run under its own tenant, and a miss
  // returns 404 (never reveal another tenant's run by id). Returns 204.
  app.delete([v1('/runs/:runId'), vendorTwin('/runs/:runId')], async (req, res, next) => {
    try {
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);
      // Destructive run removal ≥ cancel authority (RFC 0049 has no `runs:delete`;
      // `runs:cancel` is the run-termination scope). No-op unless enforced.
      await requireProtocolScope(req, 'runs:cancel');
      const tenantId = req.tenantId ?? 'default';
      const run = await storage.getRun(req.params.runId);
      if (!run || run.tenantId !== tenantId) {
        throw new OpenwopError('run_not_found', `run ${req.params.runId} not found`, 404);
      }
      const deleted = await storage.deleteRun(run.runId);
      if (!deleted) throw new OpenwopError('run_not_found', `run ${req.params.runId} not found`, 404);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── ADR 0371 — retention pin (host-extension). A pinned run is exempt from
  //    the retention sweep forever (a user promise). Tenant-scoped via the
  //    same readable-run gate as the rest of the run surface; the pin lives on
  //    run.metadata.pinned so it survives replay/fork verbatim.
  app.post('/v1/host/openwop-app/runs/:runId/pin', async (req, res, next) => {
    try {
      // ADR 0755 (WIT-AUTH-2) — a mutation: the SSE `?streamToken` read grant
      // must not authorize it.
      const run = await loadReadableRun(req, storage, req.params.runId, { streamToken: false });
      const pinned = (req.body as { pinned?: unknown } | undefined)?.pinned !== false; // default true
      // Atomic single-key merge (grade-code H2) — the previous whole-metadata
      // write raced concurrent stamps (cost, connectionUse). null = delete.
      await storage.mergeRunMetadata(run.runId, { pinned: pinned ? true : null });
      res.json({ runId: run.runId, pinned });
    } catch (err) {
      next(err);
    }
  });

  // ── Run feedback / annotations (RFC 0056) ────────────────────────────
  // Per-run side-store (advertised via capabilities.feedback in
  // routes/discovery.ts). `signal.correction` + `note` are untrusted user
  // content: scrubbed for secret-shaped tokens AND run through SR-1
  // (resolved-secret redaction) before persistence — SECURITY invariant
  // `annotation-content-redaction`. Annotations are NOT appended to the
  // replayable event log (RFC 0056 §B/§D); tenant-scoped (CTI-1).
  const SIGNAL_KINDS = ['rating', 'correction', 'label', 'flag'] as const;

  app.post(v1('/runs/:runId/annotations'), async (req, res, next) => {
    try {
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);
      // ADR 0755 D1 — `runs:annotate` (auth.md extension scope), key lane.
      requireKeyLaneScope(req, 'runs:annotate');
      const tenantId = req.tenantId ?? 'default';
      const run = await storage.getRun(req.params.runId);
      if (!run || run.tenantId !== tenantId) {
        throw new OpenwopError('run_not_found', `run ${req.params.runId} not found`, 404);
      }
      const body = (req.body ?? {}) as {
        target?: { eventId?: string; nodeId?: string };
        signal?: { kind?: string; rating?: number; label?: string; correction?: string };
        note?: string;
      };
      const kind = body.signal?.kind;
      if (!kind || !SIGNAL_KINDS.includes(kind as (typeof SIGNAL_KINDS)[number])) {
        throw new OpenwopError('invalid_request', `signal.kind must be one of ${SIGNAL_KINDS.join(', ')}`, 400);
      }
      const signal: Record<string, unknown> = { kind };
      if (kind === 'rating') {
        const r = body.signal?.rating;
        if (typeof r !== 'number' || r < 1 || r > 5) throw new OpenwopError('invalid_request', 'signal.rating must be 1..5', 400);
        signal.rating = Math.round(r);
      } else if (kind === 'label') {
        if (typeof body.signal?.label !== 'string') throw new OpenwopError('invalid_request', 'signal.label is required', 400);
        signal.label = body.signal.label;
      } else if (kind === 'correction') {
        if (typeof body.signal?.correction !== 'string') throw new OpenwopError('invalid_request', 'signal.correction is required', 400);
        signal.correction = scrubSecretShaped(body.signal.correction);
      }
      const principalRef = principal.principalId || tenantId;
      const createdAt = new Date().toISOString();
      const annotation = stripSecretsFromPersisted({
        annotationId: randomUUID(),
        target: {
          runId: run.runId,
          ...(body.target?.eventId ? { eventId: body.target.eventId } : {}),
          ...(body.target?.nodeId ? { nodeId: body.target.nodeId } : {}),
        },
        signal,
        actor: { principalRef },
        ...(typeof body.note === 'string' ? { note: scrubSecretShaped(body.note) } : {}),
        createdAt,
      }) as { annotationId: string; createdAt: string };
      await storage.insertAnnotation({ annotationId: annotation.annotationId, runId: run.runId, tenantId, payload: annotation, createdAt });
      res.status(201).json(annotation);
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/runs/:runId/annotations'), async (req, res, next) => {
    try {
      const principal = req.principal;
      if (!principal) throw new OpenwopError('unauthenticated', 'Bearer token required', 401);
      // ADR 0755 D1 — rest-endpoints.md names `runs:read` for the list.
      await requireProtocolScope(req, 'runs:read');
      const tenantId = req.tenantId ?? 'default';
      const run = await storage.getRun(req.params.runId);
      if (!run || run.tenantId !== tenantId) {
        throw new OpenwopError('run_not_found', `run ${req.params.runId} not found`, 404);
      }
      const records = await storage.listAnnotations(run.runId);
      // Defense-in-depth tenant scope (CTI-1) on top of the per-run query.
      const annotations = records.filter((r) => r.tenantId === tenantId).map((r) => r.payload);
      res.json({ annotations });
    } catch (err) {
      next(err);
    }
  });

  // OpenWOP canonical URL is /v1/runs/{runId}:fork. Express
  // path-to-regexp parses `:fork` as a second parameter, so we pin the
  // route via regex literal. Captures runId in match[1].
  // ── ADR 0632 — `runs.md` §Pause and resume ─────────────────────────────
  // Operator-driven pause, distinct from cancel (terminal) and from an
  // interrupt (workflow-driven, resolved with a value). A pause is a durable
  // REQUEST the scheduler honours at its dispatch point (`executor.ts`); the
  // route answers the requested state (202 `status: 'paused'`) and the
  // transition emits `run.paused` when the drain completes. `immediate` fires
  // the run's abort signal for nodes that observe `ctx.signal`.
  app.post(/^\/v1\/runs\/([^/:]+):pause$/, async (req, res, next) => {
    try {
      const runId = (req.params as Record<string, string>)['0'];
      const run = await loadOwnedRun(req, storage, runId, 'runs:cancel');
      const body = (req.body ?? {}) as { reason?: unknown; drainPolicy?: unknown };
      const drainPolicy = body.drainPolicy === undefined ? 'drain-current-node' : body.drainPolicy;
      if (drainPolicy !== 'immediate' && drainPolicy !== 'drain-current-node') {
        sendError(res, 400, 'validation_error', "drainPolicy must be 'immediate' or 'drain-current-node'.", { field: 'drainPolicy' }); return;
      }
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        sendError(res, 400, 'validation_error', 'reason must be a string.', { field: 'reason' }); return;
      }
      if (isTerminalRunStatus(run.status)) {
        sendError(res, 409, negotiatedMajor(req) === 2 ? 'run_terminal' : 'conflict', `Run ${run.runId} is already ${run.status}.`, { runStatus: run.status }); return;
      }
      const meta = (run.metadata ?? {}) as Record<string, unknown>;
      const idemKey = req.header('idempotency-key');
      if (run.status === 'paused' || meta.pauseRequest !== undefined) {
        // `rest-endpoints.md` :pause (line 169, ruled normative on the bus, `d4e4`): a :pause
        // against an already-paused run is 409 with `details.runStatus` (+ the existing
        // pause's `pausedAt`) UNLESS the request carries the Idempotency-Key of the original
        // pause, in which case the host returns 202 with the cached response. Same on both
        // majors; only the code differs (v1 names none — `conflict` is this host's v1 409
        // convention; v2 uses `runs.md`'s `run_state_conflict`).
        if (idemKey !== undefined && idemKey !== '' && meta.pauseIdempotencyKey === idemKey && meta.pauseResponse !== undefined) {
          res.status(202).json(meta.pauseResponse); return;
        }
        sendError(res, 409, negotiatedMajor(req) === 2 ? 'run_state_conflict' : 'conflict', `Run ${run.runId} is ${run.status === 'paused' ? 'already paused' : 'already pausing'}.`, { runStatus: run.status, ...(typeof meta.pausedAt === 'string' ? { pausedAt: meta.pausedAt } : {}) }); return;
      }
      const request: RunPauseRequest = { ...(typeof body.reason === 'string' ? { reason: body.reason } : {}), drainPolicy, requestedAt: new Date().toISOString() };
      const response = { runId: run.runId, status: 'paused' };
      await storage.updateRun(run.runId, { metadata: { ...meta, pauseRequest: request, ...(idemKey ? { pauseIdempotencyKey: idemKey, pauseResponse: response } : {}) } as never });
      requestRunPause(run.runId, request);
      if (drainPolicy === 'immediate') {
        abortRunForPause(run.runId);
        // An IMMEDIATE pause answers `202 { status: 'paused' }`, so make that true
        // before saying it: the abort lands the run in `paused` within moments on
        // the instance executing it, and a caller's very next request (a second
        // `:pause`, a `:resume`) must see the state this response claimed —
        // `runs.md` §Pause and resume has the second pause refused with
        // `runStatus: 'paused'`. MEASURED on the production cut of ad3717cde:
        // the second pause arrived first and read `running`. Bounded, and never a
        // refusal: a run executing on another instance (whose abort is not ours to
        // fire) still gets its 202 and pauses at its next node boundary.
        await settleImmediatePause(storage, run.runId);
      }
      res.status(202).json(response);
    } catch (err) { next(err); }
  });

  app.post(/^\/v1\/runs\/([^/:]+):resume$/, async (req, res, next) => {
    try {
      const runId = (req.params as Record<string, string>)['0'];
      const run = await loadOwnedRun(req, storage, runId, 'runs:cancel');
      const body = (req.body ?? {}) as { reason?: unknown };
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        sendError(res, 400, 'validation_error', 'reason must be a string.', { field: 'reason' }); return;
      }
      if (run.status !== 'paused') {
        // `runs.md` §Pause and resume: a resume refused because the run is TERMINAL carries
        // `run_terminal`; any other non-paused status is `run_state_conflict` (v1: `conflict`).
        const code = negotiatedMajor(req) !== 2 ? 'conflict' : (isTerminalRunStatus(run.status) ? 'run_terminal' : 'run_state_conflict');
        sendError(res, 409, code, `Run ${run.runId} is ${run.status}, not paused.`, { runStatus: run.status }); return;
      }
      const resolved = await resolveRunDefinition(run, hostSuite.workflowCatalog);
      if (!resolved) { sendError(res, 404, 'not_found', `workflow ${run.workflowId} not found`); return; }
      const wf = { workflowId: run.workflowId, definition: resolved.definition };
      const meta = { ...((run.metadata ?? {}) as Record<string, unknown>) };
      delete meta.pauseRequest; delete meta.pausedAt; delete meta.pauseIdempotencyKey; delete meta.pauseResponse; delete meta.pausedNodeIds;
      const resumedAt = new Date().toISOString();
      await storage.updateRun(run.runId, { metadata: meta as never });
      clearRunPause(run.runId);
      const serialized = (run as unknown as { schedulerSnapshot?: string }).schedulerSnapshot;
      // Re-enter through `executeRun` — the same path HITL resume takes: it
      // emits `run.resumed`, sets `running`, and drains from the ready set.
      void executeRun(storage, { ...run, metadata: meta as never }, wf.definition, {
        ...(serialized ? { resumeSnapshot: JSON.parse(serialized) as SerializedSnapshot } : { resumeFromNodeIndex: 0 }),
        ...(hostSuite.providerPolicyResolver ? { policyResolver: hostSuite.providerPolicyResolver } : {}),
      }).catch((err) => log.warn('run_resume_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) }));
      res.status(202).json({ runId: run.runId, status: 'running', resumedAt });
    } catch (err) { next(err); }
  });

  app.post(/^\/v1\/runs\/([^/:]+):fork$/, async (req, res, next) => {
    try {
      // Express regex routes expose captures via req.params['0'], ['1'], …
      const runId = (req.params as Record<string, string>)['0'];
      if (!runId) throw new OpenwopError('invalid_request', 'runId path segment required', 400);
      // Fork materializes a NEW run from a checkpoint — `runs:create` (ADR 0006
      // Phase 3). Tenant-ownership gate (2026-07 vuln-scan): loadOwnedRun refuses
      // to fork a run the caller doesn't own (a bare getRun let a caller fork
      // another tenant's run, copying its event prefix + re-executing). Pre-fork
      // gate only — the forked run still inherits sourceRun.tenantId (now provably
      // the caller's), so :fork replay/determinism is unchanged.
      const sourceRun = await loadOwnedRun(req, storage, runId, 'runs:create');
      // Partial on the wire: `fromSeq` is omittable for replay mode (see
      // the replay-mode default below), so don't pretend the inbound body
      // already satisfies the full ForkRunRequest shape.
      const body = (req.body ?? {}) as Partial<ForkRunRequest>;
      if (!isForkMode(body.mode)) {
        throw new OpenwopError('fork_unsupported_mode', `mode must be one of replay|branch`, 400);
      }
      // `replay.md §"Replay-mode defaults"`: fromSeq is OPTIONAL for
      // `replay` (defaults to 0 — full re-execution); REQUIRED for
      // `branch` (a branch point has no natural default).
      if (body.fromSeq === undefined && body.mode === 'replay') {
        body.fromSeq = 0;
      }
      // `api/v2/openapi.yaml` pins `fromSeq` to `{ type: integer, minimum: 0 }`,
      // so a non-integer OR a negative value violates the request schema and is
      // malformed input — 400. That is a different fault from a well-formed,
      // in-range sequence that happens to name no event, which the spec gives
      // its own code below.
      //
      // I originally routed negatives to 422 `fork_point_invalid` too, reasoning
      // that a negative "names no event in the log". An existing test pinning
      // 400 caught it, and the test was right: the schema excludes negatives at
      // the validation layer, so they never reach the semantic question. Worth
      // recording because I nearly overrode a CORRECT test as one pinning a
      // defect — the check that settled it was reading the request schema, not
      // re-reading the prose.
      if (typeof body.fromSeq !== 'number' || !Number.isInteger(body.fromSeq) || body.fromSeq < 0) {
        throw new OpenwopError('validation_error', 'fromSeq must be an integer >= 0', 400);
      }
      const fromSeq: number = body.fromSeq;
      // `runs.md` §Fork: "A `fromSeq` not in the source log MUST be rejected
      // with `422 fork_point_invalid`." This host answered 422
      // `openwop-app.fork_invalid_seq` — the right STATUS under the wrong code.
      // `fork_invalid_seq` is not in `spec/v2/errors.json`, so `v2ErrorCode`
      // namespaced it, which is the honest treatment of a code a host invents;
      // the defect was inventing one where the protocol already had a name.
      // Caught by `v2-run-fork-refusals` when `replay` was briefly advertised.
      const maxSeq = await storage.getMaxSequence(sourceRun.runId);
      if (fromSeq > maxSeq) {
        throw new OpenwopError(
          'fork_point_invalid',
          `fromSeq ${fromSeq} names no event in the source log (0..${maxSeq})`,
          422,
        );
      }
      // `replay.md` §Endpoint: `runOptionsOverlay` MUST be omitted or empty
      // for `replay` — replay is deterministic re-execution and an overlay
      // would break that. Overlays are a `branch`-only feature.
      if (
        body.mode === 'replay' &&
        body.runOptionsOverlay !== undefined &&
        Object.keys(body.runOptionsOverlay).length > 0
      ) {
        throw new OpenwopError(
          'fork_unsupported_mode',
          'runOptionsOverlay MUST be omitted or empty for mode=replay (overlay is branch-only; replay must be deterministic)',
          400,
          { mode: body.mode },
        );
      }
      // ADR 0712 — a branch overlay may carry a NEW `ai.credentialRef`, and the
      // fork copies the overlay onto `configurable` below. Check it exactly as run
      // create does, against the source run's tenant (which `loadOwnedRun` proved
      // is the caller's); an inherited ref was already checked when it was created.
      if (body.runOptionsOverlay && typeof body.runOptionsOverlay === 'object') {
        const credViolation = await runAiCredentialRefViolation(
          body.runOptionsOverlay as Record<string, unknown>, sourceRun.tenantId, advertisedByokProviders(),
        );
        if (credViolation) throw new OpenwopError('credential_forbidden', credViolation, 403);
      }
      // Honest capability split (mirrors discovery `replay.modes:
      // ['replay']` + `fork: false`): deterministic `replay` is supported
      // only as a FULL re-execution from sequence 0. A mid-sequence replay
      // would require reconstructing the executor's resume position from
      // the event log — without that, the sample re-executes the whole
      // workflow and double-emits the inherited prefix, which violates the
      // `replay.md §"Replay determinism"` per-event guarantee past the
      // fork point. Refuse with 501 (the conformance suite treats 501 as
      // "advertised but not implemented for this range" — skip-equivalent)
      // rather than serving a silently non-deterministic replay.

      // ADR 0326 P3b — a BRANCH fork from a mid-run checkpoint re-executes
      // from a snapshot reconstructed out of the copied prefix (no more
      // double-emitted prefix). Validate the checkpoint BEFORE creating the
      // fork run so an unrepresentable one (an open interrupt at fromSeq)
      // refuses honestly with no orphan run.
      const prefixEvents = fromSeq > 0
        ? await storage.listEvents(sourceRun.runId, { fromSeq: -1, limit: fromSeq })
        : [];
      // MID-SEQUENCE REPLAY WAS REFUSED WITH 501 UNTIL 2026-09-05, and the
      // refusal was correct at the time. What it did NOT contain was a diagnosis.
      //
      // The 501 named two harms: a re-executed prefix would (a) double-emit the
      // inherited history and (b) violate replay.md §"Replay determinism" past
      // the fork point. An earlier attempt disproved (a), removed the refusal,
      // and had to retract when `replay-fork-arbitrary.test.ts` went RED — two
      // replay forks at the same `fromSeq` produced different tails. That
      // retraction recorded the right conclusion ("a refusal can have a second
      // justification the first one hid") and the wrong CAUSE: it read the red as
      // proof of genuine non-determinism and stopped there.
      //
      // MEASURED instead of inferred, by dumping both event streams: the fixture
      // is three `core.noop` nodes. Nothing in it can diverge. The red was THREE
      // compounding host defects, none of them non-determinism:
      //
      //   1. Replay derived no snapshot, so `executeRun` began at node index 0
      //      and re-ran the WHOLE workflow after the copied prefix — the tail
      //      started `node.started@a` where the source had `node.started@c`.
      //      (Fixed here: both modes now resume from the prefix projection.)
      //   2. Replay re-emitted `run.started` on top of a prefix that already
      //      carried one, so the log held two starts. (executor.ts.)
      //   3. Divergence detection read the SOURCE from `fromSeq` but the REPLAY
      //      from 0, so it compared the prefix's first event against the source's
      //      fork-point event. (replayDivergence.ts.)
      //
      // Each produced a spurious `replay.diverged` whose payload carries a fresh
      // random `replayEventId` — and that UUID was the ONLY field differing
      // between two replays. The "non-determinism" was a bug report the host
      // wrote about itself, in an event whose id could not be stable.
      //
      // The lesson is narrower and more useful than the one recorded before: a
      // red witness proves the DECISION was right without telling you WHY, and
      // "the tails differ" is a symptom, not a cause. Diffing the two streams
      // took one probe and would have found this at the first attempt.

      // BOTH MODES resume from the projected state at `fromSeq`. Replay used to
      // derive no snapshot at all, so `executeRun` started at node index 0 and
      // re-ran the ENTIRE workflow after the copied prefix: for
      // `conformance-multi-node` at `fromSeq=5` the replay's tail began
      // `node.started@a` where the source has `node.started@c`. That is not a
      // determinism problem, it is a re-execution STARTING POINT problem —
      // replay.md §Endpoint: "Events with `sequence < fromSeq` are fixed history;
      // events `>= fromSeq` are re-executed", and §Modes: replay "re-executes the
      // workflow against current code FROM `fromSeq`".
      //
      // The snapshot is the same pure `snapshotFromEventPrefix` branch already
      // used; what differs between the modes is everything else — replay takes no
      // `runOptionsOverlay` and reads the source's Layer-2 invocations, branch
      // takes the overlay and mints its own.
      //
      // ADR 0751 — a checkpoint INSIDE a suspended run is forkable. This used to
      // answer `501 fork_checkpoint_unsupported`, a refusal neither `runs.md`
      // §Fork nor `replay.md` licenses (their refusals are 400/422/404/409). The
      // snapshot now restores an open gate as `'suspended'`; the fork's executor
      // re-creates the live interrupt row with a fresh token (never re-executing
      // the gate node), and the fork resumes through the normal resolve path.
      const branchSnapshot: SerializedSnapshot | undefined = fromSeq > 0 ? snapshotFromEventPrefix(prefixEvents) : undefined;

      const newRunId = randomUUID();
      const now = new Date().toISOString();
      // ADR 0024 §4/D2 confused-deputy guard: a fork acts as the FORKING caller,
      // never the source run's owner. `...sourceRun` copies `metadata.actingUserId`
      // verbatim, so re-stamp it to this principal — otherwise user B forking user
      // A's run would inherit A's identity and resolve A's per-user credentials.
      //
      // RFC 0165 §B.4 (ADR 0625) — ORTHOGONAL to the guard above: the run's
      // OWNER (`metadata.owner`: opaque principal + Subject) is copied VERBATIM
      // from the source, never re-minted from the forker. `actingUserId` is the
      // credential-resolution identity; `owner` is the identity of record. Both
      // hosts' leaver contracts depend on "nothing rewrites a subject key already
      // stamped on a run".
      const forkingUserId = req.userId ?? req.principal?.principalId;
      const forkedRun: RunRecord = {
        ...sourceRun,
        runId: newRunId,
        parentRunId: sourceRun.runId,
        parentSeq: fromSeq,
        forkMode: body.mode,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        completedAt: undefined,
        error: undefined,
        // ADR 0476 — a fork's cost is its OWN: the copied stamp would freeze
        // the source's spend under the terminal stamp's never-overwrite rule.
        // Grade-data M8 — debug/eval/redrive provenance is the SOURCE run's
        // story, not the fork's; carrying it would poison stats segmentation.
        metadata: (() => {
          const m: Record<string, unknown> = { ...((sourceRun.metadata as Record<string, unknown> | undefined) ?? {}), actingUserId: forkingUserId };
          delete m.costUsd; delete m.costTokens; delete m.costByNode; delete m.debug; delete m.eval; delete m.redriveOf; delete m.onlineEvalScored;
          // ADR 0627 D3 (review S2) — the personal tenant is the FORKING caller's
          // too (the same confused-deputy rule as `actingUserId`): a copied value
          // would let user B's fork hold A's implicit-owner authority in A's sandbox.
          const forkingPersonalTenant = personalTenantOf(req);
          if (forkingPersonalTenant) m.personalTenant = forkingPersonalTenant; else delete m.personalTenant;
          // ADR 0556 P3 / RFC 0154 — the same confused-deputy reasoning as
          // `actingUserId` above, one layer down. `...sourceRun` copies the
          // recorded AUTHORITY verbatim, which is right for the delegation depth
          // and the identity facts (they describe a chain verified once, in the
          // past) and WRONG for the scopes: copied verbatim, a caller who has
          // since lost a scope re-exercises it by forking. `authorityForReplay`
          // intersects the recorded set with the forking caller's, so the fork
          // can never hold more than EITHER — never re-minting broader
          // authority, and never laundering authority through the endpoint.
          const recordedAuthority = readRecordedAuthority(m);
          if (recordedAuthority) {
            m[RUN_AUTHORITY_METADATA_KEY] = forkAuthorityMetadata(recordedAuthority, currentAuthority());
          }
          return m;
        })(),
        configurable: { ...sourceRun.configurable, ...(body.runOptionsOverlay ?? {}) },
        idempotencyKey: undefined,
        // ADR 0751 — the fork's resume state is ITS checkpoint, not the source's
        // current one: `...sourceRun` copied the source's live snapshot, which a
        // resolve on the fork would hydrate before the fork's executor had
        // persisted its own. An open gate at `fromSeq` makes that window real.
        schedulerSnapshot: branchSnapshot ? JSON.stringify(branchSnapshot) : undefined,
      };
      // ADR 0099 — fork preserves the source's frozen decision (stamp never
      // overwrites an existing key).
      //
      // ADR 0604 (TOCWF-1) — CORRECTION. This comment used to end "…; a fork
      // that never had one stays uncompacted," and that half was FALSE, proved
      // by execution on this very line. The no-overwrite merge only protects a
      // key that EXISTS. A run born while the toggle was off carries NO key, so
      // the insert below re-ran the contributor and the fork ACQUIRED
      // `{mode:'lossless'}` — compaction the source was never created under.
      // `derivedFromRun` is what makes the sentence true: it tells the
      // per-run-decision contributors that this metadata is a verbatim copy, so
      // an ABSENT key is inherited state and must stay absent.
      //
      // ADR 0474 — resolve BEFORE the insert (review H1: a post-insert metadata
      // mutation is never persisted): the pinned revision when the copied
      // metadata carries one, else head — and the honesty stamp rides the SAME
      // insert. No definition arg: the copied pin must be preserved verbatim.
      const resolvedFork = await resolveRunDefinition(forkedRun, hostSuite.workflowCatalog);
      if (!resolvedFork) {
        throw new OpenwopError(
          'workflow_not_found',
          'Workflow not found in this catalog.',
          404,
          { workflowId: forkedRun.workflowId },
        );
      }
      forkedRun.metadata = { ...(forkedRun.metadata ?? {}), definitionResolvedFrom: resolvedFork.resolvedFrom };
      await insertRunWithStartContext(storage, forkedRun, { derivedFromRun: true });

      // Replay events up to fromSeq into the new run, then re-dispatch.
      // Sample-grade: copies events as-is. Real impls re-execute pure
      // nodes deterministically (the `replay` mode) vs. branching from
      // a checkpoint (the `branch` mode).
      for (const ev of prefixEvents) {
        await getEventLog().append({
          runId: newRunId,
          type: ev.type,
          nodeId: ev.nodeId,
          payload: ev.payload,
          causationId: ev.eventId,
          // ADR 0687 — the inherited prefix carries the SOURCE event's
          // timestamp. This loop used to omit it and take the log's default
          // `now`, so every copied event claimed to have happened at fork time:
          // `persistence.md` §"The reader rule" says `timestamp` passes through
          // untouched, and the corpus asserts it on exactly this prefix
          // (`v2-v1-events-translated`, "timestamp passes through untouched at
          // sequence 0" — expected the seeded 2026-01-15T10:00:00.000Z, got the
          // fork's wall clock). A copy that re-stamps is not a copy.
          //
          // It stayed invisible because the scenario failed EARLIER, on a 404:
          // the era-2 translation never refused, so the fork found nothing to
          // read and the timestamp leg was never reached. Closing the refusal
          // is what exposed it.
          timestamp: ev.timestamp,
        });
      }

      // ADR 0474 — replay/branch re-execute the resolution made above (pinned
      // revision when inherited; head otherwise).
      const wf = { workflowId: forkedRun.workflowId, definition: resolvedFork.definition };
      // The per-run variable bag is keyed per-runId and is NOT carried by the
      // `...sourceRun` record spread — re-seed it from the inherited inputs so
      // `{{inputs.*}}` config tokens and `{type:'variable'}` refs resolve on the
      // fork exactly as on the original run (replay/fork determinism).
      // RFC 0124 — the fork's `configurable` (inherited from the source +
      // `runOptionsOverlay`) re-applies the deferred bare-param override, so a
      // fork replays the same bound value (or a re-parameterized one) deterministically.
      seedRunVariables(
        newRunId,
        wf.definition.variables,
        deferredConfigurableInputs(wf.definition, forkedRun.configurable, forkedRun.inputs),
      );

      const response: ForkRunResponse = {
        runId: newRunId,
        sourceRunId: sourceRun.runId,
        fromSeq,
        mode: body.mode,
        status: 'pending',
        eventsUrl: `${requestOrigin(req)}/v1/runs/${newRunId}/events`,
      };
      res.status(201).json(response);

      setImmediate(() => {
        executeRun(storage, forkedRun, wf.definition, {
          policyResolver: hostSuite.providerPolicyResolver,
          // ADR 0326 P3b — branch: resume from the checkpoint snapshot (the
          // copied prefix never re-executes); replay: read the SOURCE run's
          // Layer-2 invocations so the re-execution is provider-deterministic
          // (incl. P3a's recorded failures — attempt sequences reproduce).
          //
          // ADR 0755 (FORKINT-2) — derived from the PERSISTED fork, by the same
          // helper the orphan sweeper uses, so a crash between the 201 and this
          // dispatch recovers the identical run instead of re-executing the prefix.
          ...forkDispatchOptions(forkedRun),
        })
          .then(async (result) => {
            // replay.md §"Failure surfaces": after a deterministic re-execution,
            // compare the observable sequence against the source and emit
            // `replay.diverged` if they differ. Replay-only (branch changes
            // inputs by design, so divergence is expected, not reported).
            //
            // ADR 0751 — and only once the fork is TERMINAL. A fork that settles
            // on an inherited open gate has re-executed nothing yet; comparing
            // its empty tail against the source's continuation would report a
            // divergence the fork has not had the chance to make.
            const terminal = result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled';
            if (body.mode === 'replay' && terminal) {
              const div = await detectAndRecordReplayDivergence(
                storage,
                getEventLog(),
                sourceRun.runId,
                newRunId,
                fromSeq,
              );
              if (div.diverged) {
                log.info('replay diverged', { runId: newRunId, divergencePoint: div.index });
              }
            }
          })
          .catch((err) => {
            log.error('fork dispatch failed', {
              runId: newRunId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });
    } catch (err) {
      next(err);
    }
  });

  app.get(v1('/runs/:runId/events/poll'), async (req, res, next) => {
    try {
      const run = await loadReadableRun(req, storage, req.params.runId);
      // Accept both `lastSequence` (spec-canonical: version-negotiation.md
      // §"Poll cursor" — the highest sequence the caller has ALREADY observed;
      // the response carries events with sequence > N) and the sample's
      // legacy `fromSeq`. Every storage backend's `listEvents` is already
      // exclusive (`WHERE sequence > fromSeq`), so the cursor maps 1:1.
      // ADR 0625: the route used to add 1 here, which double-skipped — with
      // this host's first event at sequence 1, `lastSequence=0` silently
      // dropped `run.started` on every run. The RFC 0165 §B.2 echo scenario
      // (the first suite leg to read the FIRST event through this cursor)
      // caught it. Beyond-the-end values return an empty events array per
      // the forward-compat contract — NOT a 4xx.
      // `spec/v2/core/events.md` §Poll renames the cursor to `afterSequence`
      // and closes the response to `{ runId, events, lastSequence, status,
      // isTerminal }`. Both are major-2 shapes; the v1 wire above keeps
      // `lastSequence`/`fromSeq` and `{ events, isComplete }` untouched, so the
      // two contracts read the SAME exclusive `listEvents` cursor and differ
      // only in what they call it and what they wrap it in.
      const major = negotiatedMajor(req);
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
      if (major === 2) {
        // Omission means "from the first event": `listEvents` is exclusive
        // (`WHERE sequence > fromSeq`), so the floor is −1, not 0 — a log whose
        // first event is sequence 0 must not be skipped by an absent cursor.
        const afterRaw = req.query.afterSequence;
        const afterSequence = afterRaw === undefined ? -1 : (Number(afterRaw) || 0);
        const events = await storage.listEvents(run.runId, { fromSeq: afterSequence, limit });
        // §Poll: the highest sequence in the log at the time of the response,
        // −1 when the log is empty. A cursor past the end therefore still
        // answers 200 with an empty `events` array — never a 4xx.
        const maxSequence = await storage.getMaxSequence(run.runId);
        respondJson(res, 200, {
          runId: run.runId,
          events,
          // `getMaxSequence` already answers -1 for an empty log; `> 0 ? … : -1`
          // reported an empty log for a log holding exactly event 0.
          lastSequence: maxSequence,
          status: run.status,
          isTerminal: ['completed', 'failed', 'cancelled'].includes(run.status),
        });
        return;
      }
      // v1 numbers from 0 too (`schemas/run-event.schema.json`: "First event is 0"),
      // and the cursor is exclusive, so an ABSENT cursor is -1, not 0.
      const lastSeqRaw = req.query.lastSequence;
      const fromSeq = lastSeqRaw !== undefined
        ? (Number(lastSeqRaw) || 0)
        : (req.query.fromSeq !== undefined ? (Number(req.query.fromSeq) || 0) : -1);
      const events = await storage.listEvents(run.runId, { fromSeq, limit });
      const isComplete = ['completed', 'failed', 'cancelled'].includes(run.status);
      respondJson(res, 200, { events, isComplete });
    } catch (err) {
      next(err);
    }
  });

  // Debug-bundle export per `spec/v1/debug-bundle.md`. Returns the full
  // event log for a run plus run metadata + truncation metadata. The
  // optional `?maxEvents=N` query forces truncation (implementation-
  // defined per spec: "Hosts MAY raise the cap via implementation-
  // defined configuration") so conformance can drive the truncation
  // contract deterministically.
  // ADR 0730 C.1 — a HOST-EXTENSION twin, registered alongside the v1 path.
  // `/runs/{runId}/debug-bundle` is absent from the v2 path manifest (43 paths,
  // measured at 2.5.0), and ADR 0654 already moved run-list/delete and the
  // events token to `/host/<org>/…` for the same reason: a v1 operation with no
  // v2 home is host-extension surface, non-normative, and needs no RFC. The v2
  // `capabilities.production.debugBundle` block advertises truncation and
  // redaction BEHAVIOUR, not an endpoint — raised with the corpus steward, and
  // the twin is the honest form either way: if the corpus later gives the
  // operation a protocol path, the twin becomes the overlap spelling.
  // Same handler, both paths: one owner, no drift.
  app.get([v1('/runs/:runId/debug-bundle'), vendorTwin('/runs/:runId/debug-bundle')], async (req, res, next) => {
    try {
      const run = await loadReadableRun(req, storage, req.params.runId);
      const allEvents = await storage.listEvents(run.runId, { fromSeq: -1, limit: 100_000 });
      const cap = req.query.maxEvents !== undefined ? Number(req.query.maxEvents) : Number.POSITIVE_INFINITY;
      const events = Number.isFinite(cap) && cap >= 0 ? allEvents.slice(0, cap) : allEvents;
      const truncated = events.length < allEvents.length;
      respondJson(res, 200, {
        runId: run.runId,
        workflowId: run.workflowId,
        status: run.status,
        events,
        truncated,
        ...(truncated ? { truncatedReason: `Bundle capped at maxEvents=${cap} (configured via query param).` } : {}),
        metrics: { eventCount: allEvents.length },
      });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * The §D compensation rollup for `run`, or `undefined` to omit the field.
 *
 * Resolved by the CALLER and passed in, because the fold is an async ledger read
 * and this projector is synchronous on a route that maps over a whole page. The
 * batch resolver (`compensationStatusForRuns`) does ONE scan for the page; a
 * per-run `await` inside the projector would be one full-collection scan per run
 * on the read path that already had an O(tenant)-scan outage.
 */
type CompensationProjection = CompensationStatus | undefined;

/**
 * `compensation.md` §D — resolve the rollup for a page of runs, or nothing at
 * all when this host does not advertise the family.
 *
 * The advert check reads `COMPENSATION_CAPABILITY`, the SAME constant
 * `routes/discovery.ts` spreads into `capabilities.compensation`. §D makes the
 * two a pair — "a host that does not advertise MUST omit the field; a host that
 * advertises MUST include it on every snapshot, `none` when no compensation was
 * ever requested" — and sharing the constant is what makes the pair structural
 * rather than a coincidence two files currently agree on.
 */
/** Wait (bounded) for an immediately-paused run to reach `paused` — or any state
 *  that ends the wait (terminal). Returns without refusing either way. */
async function settleImmediatePause(storage: Storage, runId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await storage.getRun(runId);
    if (!r || r.status === 'paused' || isTerminalRunStatus(r.status)) return;
    await new Promise((res) => setTimeout(res, 50));
  }
}

async function resolveCompensationStatuses(
  tenantId: string,
  runIds: readonly string[],
): Promise<Map<string, CompensationStatus>> {
  if (!advertisesCompensation()) return new Map();
  return compensationStatusForRuns(tenantId, runIds);
}

/**
 * `runs.md` §Snapshot — the closed v2 object. Applied at the END of the
 * projector so every caller (the detail read and the list page) inherits it,
 * and applied to the FULL body the route hands out (the detail read adds
 * `childRuns` and `interrupt` after projecting, so it closes again there).
 */
/** `runs.md` §Run options — returns a violation message or null. Never rejects a tag on FORMAT. */
function validateRunOptionTagsAndMetadata(body: { tags?: unknown; metadata?: unknown }): string | null {
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return 'tags must be an array of strings';
    if (body.tags.length > 100) return `tags has ${body.tags.length} entries; the limit is 100`;
    for (const t of body.tags) {
      if (typeof t !== 'string') return 'tags must be an array of strings';
      if (t.length < 1 || t.length > 256) return `tags entries must be 1–256 characters (got ${t.length})`;
    }
  }
  if (body.metadata !== undefined) {
    if (body.metadata === null || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return 'metadata must be a JSON object';
    if (JSON.stringify(body.metadata).length > 50 * 1024) return 'metadata exceeds the 50 KB serialized limit';
  }
  return null;
}

/** `api/v2/openapi.yaml` createRun request = allOf(base, run-options.schema.json), closed. */
const V2_CREATE_ROOT_KEYS: ReadonlySet<string> = new Set([
  'workflowId', 'inputs', 'mode', 'residency', 'scopeId', 'tenantId', 'agentId', 'callbackUrl', 'evalSuiteRef',
  'tags', 'metadata', 'configurable',
]);

/**
 * `owner` is widened off the SDK's `RunSnapshot` for the same reason
 * `HostCreateRunRequest` widens `configurable`: ONE projection serves BOTH
 * majors.
 *
 * SDK 2.x types `RunSnapshot.owner` as a REQUIRED `RunOwner`, and that is
 * right about the major-2 wire — `schemas/v2/run-snapshot.schema.json` lists
 * `owner` in `required` (v1 does not), and this host satisfies it: the major-2
 * branch below returns `runOwnerV2(run)`, which never returns `undefined`
 * because it falls back to a legacy subject stamped at read.
 *
 * `agent` is omitted for a DIFFERENT reason, and this one is the SDK's bug
 * rather than a boundary: SDK 2.1.0 types `AgentRef.modelClass` as
 * `'reasoning' | 'tool-using' | 'chat'`, but `agent-ref.schema.json` — the
 * SAME file in both the v1 and v2 vendored trees — carries a NINE-member
 * closed enum (adding `code`, `vision`, `multimodal`, `embedding`,
 * `classification`, `retrieval`) and documents a vendor form `<vendor>.<class>`
 * on top. The SDK union is narrower than the schema it claims to describe, so
 * narrowing this host to it would refuse six values the spec allows. The host's
 * own `AgentRef` (`executor/types.ts`, `modelClass?: string`) stays.
 *
 * Under major 1 the same function returns `runOwner(run)`, a DIFFERENT block
 * that may legitimately be absent. So the union is the honest type of what
 * this function returns, and the SDK's type is the honest type of what reaches
 * a v2 client after the major-2 branch. Asserting the latter here would claim
 * the v1 projection cannot omit an owner, which it can.
 */
/** What `projectRunSnapshot` actually returns — see its docblock. */
export type HostRunSnapshot = ReturnType<typeof projectRunSnapshot>;

export function projectRunSnapshot(run: RunRecord, compensationStatus?: CompensationProjection): Omit<RunSnapshot, 'owner' | 'agent'> & {
  parentSeq?: number;
  forkMode?: 'replay' | 'branch';
  // `run-snapshot.schema.json §compensationStatus` (RFC 0151 §D, UQ3). Present
  // on EVERY snapshot while the host advertises `capabilities.compensation`,
  // `none` when the run owed nothing; absent entirely when it does not.
  compensationStatus?: CompensationStatus;
  metrics?: { openwopCost?: Record<string, unknown> };
  agent?: AgentRef;
  // RFC 0048 owner triple + RFC 0132 `principalKind` + RFC 0165 `subject`
  // (ADR 0625). Projected for every run with a principal — the persisted
  // stamp, or the §B.3 legacy synthesis for runs that predate it.
  owner?: RunOwnerBlock | RunOwnerBlockV2;
  // ADR 0371 — host-extension retention fields (additive; clients tolerate
  // unknown keys). `removalAt` = the sweep deadline; `pinned` exempts it.
  removalAt?: string;
  pinned?: boolean;
  // ADR 0482 §1/§6 — the durable terminal cost stamps (host-authoritative
  // run.metadata; additive host-extension fields, absent pre-stamp).
  costUsd?: number;
  costByNode?: Record<string, number>;
} {
  const variables = snapshotRunVariables(run.runId);
  const channels = snapshotRunChannels(run.runId);
  const agent = getRunAgent(run.runId);
  const parentNodeId = getChildParentNodeId(run.runId);
  const snapshot = {
    runId: run.runId,
    // `schemas/v2/run-snapshot.schema.json` REQUIRES `eventLogSchemaVersion`,
    // and `persistence.md` §"The era key" says it "MAY be synthesized": an
    // era-2 run predates the key and has nothing stored, so the host supplies
    // `2` from the absent-⇒-`2` rule rather than failing the read. `eraOf` is
    // that rule, in one place.
    //
    // CORRECTED 2026-09-04 -- this used to be MAJOR-2 ONLY, on the reasoning
    // that the v1 schema makes the field optional so emitting it would change
    // the v1 wire. That reasoning was wrong in the way that matters: the v1
    // schema is optional but the v1 PROSE is a MUST ("every persisted run
    // document MUST carry an eventLogSchemaVersion", version-negotiation.md
    // §Stamping), and §Legacy detection reads its ABSENCE as "legacy run" --
    // so withholding it told every conforming v1 reader to ignore our event
    // log. The suite's v1 scenario `era-key-stamped-v1` (rc.26+) reads the v1
    // snapshot and asserts a number >= 2; `eraOf(run)` is 3 for every run this
    // host has minted since the cut and 2 for every run before it, so both
    // contracts now carry the same honest value. Emitted on BOTH contracts.
    eventLogSchemaVersion: eraOf(run),
    // §Run options — surfaced unchanged (both snapshot schemas carry them).
    ...(Array.isArray((run.metadata as Record<string, unknown> | undefined)?.tags)
      ? { tags: (run.metadata as Record<string, unknown>).tags as string[] }
      : {}),
    ...((run.metadata as Record<string, unknown> | undefined)?.callerMetadata && typeof (run.metadata as Record<string, unknown>).callerMetadata === 'object'
      ? { metadata: (run.metadata as Record<string, unknown>).callerMetadata as Record<string, unknown> }
      : {}),
    // §Engine version: the writer's version, stamped at insert into
    // `run.metadata.engineVersion`. Absent ⇒ omitted (the spec's legacy
    // escape), never synthesized.
    ...(typeof (run.metadata as Record<string, unknown> | undefined)?.engineVersion === 'number'
      ? { engineVersion: (run.metadata as Record<string, unknown>).engineVersion as number }
      : {}),
    workflowId: run.workflowId,
    status: run.status,
    currentNodeId: run.currentNodeId,
    startedAt: run.createdAt,
    completedAt: run.completedAt,
    error: run.error,
    parentRunId: run.parentRunId,
    parentSeq: run.parentSeq,
    forkMode: run.forkMode,
    // RFC 0151 §D — the unwind rollup, kept SEPARATE from `status` on purpose:
    // `status` is the forward execution state, and a run that is `failed`
    // (forward) and `completed` (unwind) at the same time is the normal
    // successful outcome of a compensation. Deliberately not `?? 'none'`: the
    // caller decides presence, and a defaulted `none` here would carry the field
    // on a host that does not advertise — the exact direction §D forbids.
    ...(compensationStatus !== undefined ? { compensationStatus } : {}),
    ...(run.removalAt !== undefined ? { removalAt: run.removalAt } : {}),
    ...((run.metadata as Record<string, unknown> | undefined)?.pinned === true ? { pinned: true } : {}),
    // ADR 0482 §6 — surface the terminal cost stamps (RESERVED keys, so these
    // are host-written only): the run-detail per-node table + the builder cost
    // heatmap read them off the snapshot instead of re-scanning event logs.
    ...((): { costUsd?: number; costByNode?: Record<string, number> } => {
      const m = (run.metadata ?? {}) as Record<string, unknown>;
      const out: { costUsd?: number; costByNode?: Record<string, number> } = {};
      if (typeof m.costUsd === 'number' && Number.isFinite(m.costUsd)) out.costUsd = m.costUsd;
      if (m.costByNode && typeof m.costByNode === 'object' && !Array.isArray(m.costByNode)) {
        out.costByNode = m.costByNode as Record<string, number>;
      }
      return out;
    })(),
    // RFC 0048 / RFC 0132 / RFC 0165 (ADR 0625) — the owner block: tenant,
    // opaque principal, `principalKind` when the run asserted one, and the
    // Subject (persisted stamp, or the legacy synthesis). ONE projection,
    // shared with the `run.started` echo in `executor.ts`.
    //
    // `spec/v2/core/identity.md` §1.1 (RFC 0170 §A.1) — under major 2 the block
    // is `{ tenant, workspace?, subject }`, CLOSED, with `subject` REQUIRED and
    // `principal` / `principalKind` REMOVED, and it is present on EVERY
    // snapshot: a run this host recorded no principal for reads with the §1.2
    // legacy subject rather than omitting the owner the v2 schema requires.
    // Both spellings project the same persisted stamp (`host/runOwner.ts`).
    ...((): { owner?: RunOwnerBlock | RunOwnerBlockV2 } => {
      if (currentContract() === 2) return { owner: runOwnerV2(run) };
      const owner = runOwner(run);
      return owner ? { owner } : {};
    })(),
    // RFC 0022 §A inputMapping projects parent variables onto child
    // inputs — the conformance suite reads `inputs.<key>` off the
    // child snapshot to assert the projection landed.
    ...(run.inputs !== null && run.inputs !== undefined ? { inputs: run.inputs } : {}),
    ...(parentNodeId !== undefined ? { parentNodeId } : {}),
    // RFC 0022 §B / `workflow-definition.schema.json §variables` —
    // the per-run variable bag (seeded at run-create from
    // `workflow.variables[].defaultValue` + `request.inputs`). Absent
    // when the run was never seeded (legacy fixtures without a
    // `variables[]` declaration). The omission is meaningful — JSON
    // serialization drops `undefined` keys.
    ...(variables !== null ? { variables } : {}),
    // `run-snapshot.schema.json §channels`: typed-state channel
    // projections (the `message` reducer, channels-and-reducers.md).
    // Absent when the run produced no channel state.
    ...(channels !== null ? { channels } : {}),
    // Multi-Agent Shift Phase 1 — `run-snapshot.schema.json §agent`:
    // the active worker's AgentRef, stamped by the executor when an
    // agent-pinned node launches (`host/runAgentRuntime.ts`). Carries
    // RFC 0003 `sourceManifestId` provenance verbatim. Absent for runs
    // with no agent provenance.
    ...(agent !== null ? { agent } : {}),
    // `run-snapshot.schema.json §metrics.openwopCost`: aggregate cost
    // rollup populated as nodes call recordCost (or, in the conformance
    // tier, the `conformance.cost.emit` typeId). Absent when nothing
    // emitted — spec-allowed.
    ...((() => {
      const cost = snapshotCostRollup(run.runId);
      return cost ? { metrics: { openwopCost: cost as Record<string, unknown> } } : {};
    })()),
  };
  return currentContract() === 2 ? closeV2Snapshot(snapshot) : snapshot;
}

/** Per `capabilities.md §"Unsupported capability — refusal contract"`:
 *  reserved typeIds that require an advertised capability MUST be
 *  refused at register-time OR run-create when the capability isn't
 *  claimed. This sample doesn't advertise `conversationPrimitive`,
 *  so any workflow referencing `core.conversationGate` refuses here.
 *  Mirror of the dispatch/subWorkflow mapping check in
 *  `routes/workflows.ts §checkMappingCapability`. */
/** Ajv2020-validate a value against a JSON Schema. Returns null on
 *  success or the first error path/message on failure. Compiled
 *  validators are NOT cached because the schemas vary per workflow
 *  and validation runs only at request boundaries — Ajv's compile
 *  cost is small for the schema sizes we expect here. */
let _runsAjv: import('ajv/dist/2020.js').default | null = null;
async function getRunsAjv(): Promise<import('ajv/dist/2020.js').default> {
  if (_runsAjv) return _runsAjv;
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  _runsAjv = new Ajv2020({ strict: false, allErrors: true });
  return _runsAjv;
}
function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): string | null {
  try {
    // Synchronous use of Ajv requires the validator to be already
    // compiled, so we lazy-init via a global. Ajv handles draft 2020-12.
    if (!_runsAjv) {
      // Trigger lazy init; first call falls back to a synchronous import
      // via require under Node's hood. If unavailable, skip validation
      // gracefully — the spec says SHOULD validate, not MUST emit at all
      // costs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _runsAjv = new (require('ajv/dist/2020.js').default)({ strict: false, allErrors: true });
    }
    const validate = _runsAjv!.compile(schema);
    const ok = validate(value);
    if (ok) return null;
    const first = (validate.errors ?? [])[0];
    return first ? `${first.instancePath || '(root)'}: ${first.message ?? 'invalid'}` : 'schema mismatch';
  } catch (err) {
    // Compilation error → fail OPEN (the spec says SHOULD validate, not MUST),
    // but surface it through the structured logger so a malformed configurable
    // schema that's silently skipping validation is visible to ops (DATA-7),
    // not buried in a console.warn.
    log.warn('configurable_schema_compile_failed_skipping_validation', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Pre-warm the Ajv singleton at module load time so the first
// request doesn't pay the dynamic-import cost.
void getRunsAjv().catch(() => { /* swallowed; validateAgainstSchema falls back */ });

function hasManagedCredentialRef(
  nodes: ReadonlyArray<{ typeId: string; config?: Record<string, unknown> }>,
): boolean {
  for (const node of nodes) {
    const ref = node.config?.['credentialRef'];
    if (typeof ref === 'string') {
      // Explicit credentialRef wins. If it's `managed:*`, this node
      // will route through the managed dispatch path; if it's any
      // other ref, the workflow author opted into BYOK and we don't
      // gate it.
      if (isManagedCredentialRef(ref)) return true;
      continue;
    }
    // No explicit ref → fall back to the per-node default. Today only
    // chat-class typeIds default to `managed:openwop-free` (see the
    // precedence chain in `bootstrap/nodes.ts` chat-responder body).
    // Without this branch, the sample chat-tab workflow
    // `openwop-app.chat.turn` (which pins no credentialRef on its
    // chat-responder node) slips past the preflight, dispatches under
    // an anon tenant, and fails with `sign_in_required` at chat-node
    // execution time — exactly the latency this preflight exists to
    // close. `MANAGED_DEFAULTING_TYPE_IDS` lives next to the dispatch
    // path's `MANAGED_REF_PREFIX` so the default and the gate can't
    // drift silently as new chat-class typeIds land.
    if (MANAGED_DEFAULTING_TYPE_IDS.has(node.typeId)) return true;
  }
  return false;
}

export function capabilityGatedTypeIdRefusal(
  nodes: ReadonlyArray<{ nodeId: string; typeId: string }>,
): OpenwopError | null {
  // `core.conversationGate` is now SUPPORTED — the host advertises
  // `capabilities.conversationPrimitive: true` (routes/discovery.ts) and
  // implements the open/exchange/close lifecycle (bootstrap/nodes.ts +
  // host/conversationExchange.ts), so it is no longer refused here. Other
  // capability-gated typeIds would be refused in this function when their
  // gating capability is unadvertised; none currently are.
  void nodes;
  return null;
}

function respondJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

// ── RFC 0054 run diff ────────────────────────────────────────────────
// Pure function of the two event logs (determinism contract,
// spec/v1/replay.md). Sequence alignment is by event `sequence`; the
// canonical comparison excludes non-deterministic transport metadata
// (eventId / runId / timestamp) so two conformant hosts agree on
// `divergedAtSeq`.

interface DiffEventRecord {
  sequence: number;
  type: string;
  nodeId?: string;
  payload?: unknown;
}
interface DiffSnapshot {
  status: string;
  variables?: Record<string, unknown>;
  channels?: Record<string, unknown>;
}

function canonicalEvent(ev: DiffEventRecord): string {
  return JSON.stringify({ type: ev.type, nodeId: ev.nodeId ?? null, payload: ev.payload ?? null });
}

function computeRunDiff(
  a: string,
  b: string,
  eventsA: ReadonlyArray<DiffEventRecord>,
  eventsB: ReadonlyArray<DiffEventRecord>,
  snapA: DiffSnapshot,
  snapB: DiffSnapshot,
): {
  a: string;
  b: string;
  divergedAtSeq: number | null;
  eventDiffs: Array<{ seq: number; op: 'added' | 'removed' | 'changed'; aEvent?: DiffEventRecord; bEvent?: DiffEventRecord }>;
  stateDiff: Record<string, unknown>;
  truncated?: boolean;
} {
  const bySeqA = new Map<number, DiffEventRecord>(eventsA.map((e) => [e.sequence, e]));
  const bySeqB = new Map<number, DiffEventRecord>(eventsB.map((e) => [e.sequence, e]));
  const seqs = [...new Set([...bySeqA.keys(), ...bySeqB.keys()])].sort((x, y) => x - y);

  const eventDiffs: Array<{ seq: number; op: 'added' | 'removed' | 'changed'; aEvent?: DiffEventRecord; bEvent?: DiffEventRecord }> = [];
  let divergedAtSeq: number | null = null;
  for (const seq of seqs) {
    const ea = bySeqA.get(seq);
    const eb = bySeqB.get(seq);
    if (ea && !eb) eventDiffs.push({ seq, op: 'removed', aEvent: ea });
    else if (!ea && eb) eventDiffs.push({ seq, op: 'added', bEvent: eb });
    else if (ea && eb && canonicalEvent(ea) !== canonicalEvent(eb)) eventDiffs.push({ seq, op: 'changed', aEvent: ea, bEvent: eb });
    else continue;
    if (divergedAtSeq === null) divergedAtSeq = seq;
  }

  // Terminal-state diff (status + variables + channels). Redaction-safe:
  // the projected snapshot never carries credential material.
  const stateDiff: Record<string, unknown> = {};
  if (snapA.status !== snapB.status) stateDiff.status = { a: snapA.status, b: snapB.status };
  for (const key of ['variables', 'channels'] as const) {
    const va = JSON.stringify(snapA[key] ?? null);
    const vb = JSON.stringify(snapB[key] ?? null);
    if (va !== vb) stateDiff[key] = { a: snapA[key] ?? null, b: snapB[key] ?? null };
  }

  const terminal = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';
  const truncated = !terminal(snapA.status) || !terminal(snapB.status);

  return {
    a, b, divergedAtSeq, eventDiffs, stateDiff,
    ...(truncated ? { truncated: true } : {}),
  };
}
