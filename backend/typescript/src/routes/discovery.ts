/**
 * /.well-known/openwop (the v2 root; ADR 0812 P4 deleted the v1 document) + the
 * vendor OpenAPI document.
 *
 * Honest advertisement: only what this sample actually supports. Real
 * deployers update the capabilities block whenever they swap a stub
 * for a real implementation.
 */

import { oauthAdvertisementSnapshot, refreshOAuthAdvertisement } from '../features/connections/oauthAdvertisement.js';
import { maxStreamAgeSec } from '../host/streamAgeCapability.js';
import { defaultMaxAgeMs } from '../host/sseChannel.js';
import { v2FanOutFacet } from '../host/dispatchFanOut.js';
import { RUN_LIST } from '../host/runList.js';
import { confidenceEscalationFloor, multiAgentExecutionModelVersion } from '../host/multiAgentPhases.js';
import { MAX_FUTURE_HORIZON_ISO } from '../host/cronSchedule.js';
import { secretRotationOverlapSeconds, SUPPORTED_SIGNATURE_ALGORITHMS } from '../host/webhookStandardWebhooks.js';
import { advertisedHostEventTypes, hostEventsV2Enabled } from '../host/hostEventTypes.js';
import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import { DEFAULT_SERVICE_DESCRIPTION, DEFAULT_SERVICE_VENDOR, type AppConfig } from '../index.js';
import { requestOrigin } from '../host/requestOrigin.js';
import { streamBaseRecord } from '../host/streamBase.js';
import { longTermMemoryDurable, memoryCapability } from '../host/memoryDimensions.js';
import { createLogger } from '../observability/logger.js';
import {
  certificationBundleUrlV2,
  ensureCertificationEvidence,
  evidenceFromOrigin,
  servedBundle,
  CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH,
} from '../host/conformanceClaims.js';
import { ifNoneMatchSatisfied } from '../host/restTransport.js';
import { minClientVersion, preferredVersion, protocolVersions, VENDOR_ROOT, PROTOCOL_VERSION_V1, advertisedPath } from '../middleware/protocolVersion.js';
import { EVENT_LOG_SCHEMA_VERSION } from '../storage/eventEra.js';
import { INTERRUPT_TOKEN_ALGS } from '../host/interruptToken.js';
import { defaultRetentionDays } from '../storage/runRetentionStamp.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../host/multiPartyConversation.js';
import { storageFamilyFacets, v2AdvertisedStorageFamilies } from '../host/storageFamilyAdvert.js';
import { RUN_DURATION_CEILING_MS } from '../executor/executor.js';
import { demoMode } from '../host/demoMode.js';
import { registerV2Extension, v2Extensions } from '../host/discoveryExtensions.js';
import { hostI18nEnabled, hostDefaultLocale, hostSupportedLocales, hostContentLocales } from '../host/i18n/index.js';
import type { Storage } from '../storage/storage.js';
import { INPUT_MODALITIES } from '../aiProviders/aiProvidersHost.js';
import { hostAdvertisedSelfHosted } from '../host/compatEndpoints.js';
import { subscriptionAdvertisedProviders, advertisedSubscriptionOnlyProviders } from '../aiProviders/aiProvidersHost.js';
import {
  SUBJECT_LINK_KEY,
  samlProfileAdvertised,
  scimProfileAdvertised,
  combinedSubjectLinkingActive,
} from '../host/auth/subjectLinkService.js';
import { listLoadedConformanceFixtures } from '../host/index.js';
import { getPromptsHostConfig } from '../host/promptHostConfig.js';
import { workflowChainPacksCapability } from '../host/workflowChainPackLoader.js';
import { getEnvelopeReasoningConfig } from '../host/envelopeReasoningConfig.js';
import { getModelCapabilityGateConfig } from '../host/modelCapabilityGateConfig.js';
import { authorizationCapability, isAuthorizationEnforced, SCOPES_SUPPORTED } from '../host/protocolAuthorization.js';
import { subWorkflowInputMappingHonoured } from '../host/capabilityOverlay.js';
import { listArtifactTypes } from '../host/artifactTypes.js';
import { triggerIngestionEnabled, streamCdcIngestionEnabled, inboundSigningEnabled, MAX_INGEST_BODY_BYTES } from '../host/triggerIngestionService.js';
import { TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE, TRIGGER_DEAD_LETTER_RETENTION_DAYS } from '../host/triggerBridgeService.js';
import { dataResidencyAdvertised, dataResidencyRegions } from '../features/cdp/dataResidency.js';
import { anonymousActorAdvertised, anonymousActorCapability } from '../host/anonymousActor.js';
import { activationMode as proposalsActivationMode } from '../features/proposals/proposalsService.js';
import { evalSuiteCapability } from '../host/evals/evalCapability.js';
import { requiresBounds as goalsRequiresBounds } from '../features/goals/goalsService.js';
import { uiPluginsCapability, uiPluginOperationsServed } from '../host/uiPluginRpc.js';
import { presentationEnabled } from '../host/hostProfile.js';
import { readOidcConfigFromEnv, OIDC_REVOCATION_WINDOW_S } from '../middleware/oidcVerifier.js';
import { PRM_SEGMENT } from '../middleware/authChallenge.js';
// RFC 0152/0153 §A — the version SSoTs. Imported so the advert is DERIVED
// from the same constants the refusal/handshake paths read.
import { A2A_VERSIONS_REFRESHED_AT, a2aMinimumVersion, a2aV2Profiles, a2aV2RulesActive, advertisedA2AProtocolVersion, servedA2AVersions } from '../host/a2aProfile.js';
// RFC 0151 §A — the compensation SSoT. Same reason as the two above: the
// ordering model advertised here is the one `compensationUnwind.ts` sorts by and
// `workflowDefinitionValidation.ts` accepts at registration, because all three
// read this constant rather than a literal of their own.
import { seamsFloorServed } from './conformanceSeams.js';
import { COMPENSATION_CAPABILITY } from '../host/compensationCapability.js';
import { MCP_CURRENT_FEATURES, MCP_SUPPORTED_VERSIONS, MCP_VERSIONS_REFRESHED_AT, advertisedMcpProtocolVersion, mcpMinimumRevision, mcpV2Profiles } from '../host/mcpProfile.js';
import {
  SAFE_FETCH_MAX_RESPONSE_BODY_BYTES,
  SAFE_FETCH_REQUEST_TIMEOUT_MS,
} from '../host/connectionInjection.js';
import { FORK_MODES } from '../host/forkModes.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../host/webhookDeliveryWorker.js';
import { V2_A2UI_ENVELOPE_CATALOG, a2uiV2AdmissionReachable } from '../host/a2uiSurfaceAdmission.js';
import { V2_EFFECT_SEAMS_PATH } from './effectSeams.js';
import {
  advertisedWorkloadSchemes,
  readWorkloadIdentityConfigFromEnv,
} from '../host/workloadIdentity.js';
import { declaration } from '../host/specDeclaration.js';

const discoveryLog = createLogger('routes.discovery');

/**
 * Auth profiles this host actually SERVES (review finding #10 / ADR 0002 C1).
 * `openwop-auth-saml` / `openwop-auth-scim` are advertised ONLY when their seam
 * is actually reachable in this deployment — otherwise a client would read the
 * profile from discovery and get a 404 from the (unconfigured) seam, which is
 * exactly the advertised-but-unhonored posture C1 forbids. SAML is reachable
 * when a synthetic IdP is wired (`OPENWOP_TEST_SAML_IDP_URL`); SCIM when either
 * the real bearer-authed endpoints (`OPENWOP_SCIM_BEARER`) or the conformance
 * seam (`OPENWOP_TEST_SCIM_URL`) is configured.
 *
 * RFC 0164 (ADR 0623) makes the SCIM⟷SAML leaver contract MANDATORY: a host
 * advertising BOTH `openwop-auth-saml` AND `openwop-auth-scim` MUST also derive
 * `subjectLinking:true` + `subjectLinkKey` — "both profiles + no subjectLinking"
 * is a conformance FAILURE (was `inapplicable`). We enforce that invariant
 * STRUCTURALLY here, at the single source both consumers read: when both profiles
 * would otherwise be advertised but the deployment cannot honour the combined
 * contract as a whole (`!combinedSubjectLinkingActive()` — either the realms
 * MISALIGN, i.e. a configured production SAML SP whose `OPENWOP_SAML_TENANT`
 * differs from `scimLinkRealm()`, OR no shared trust root is configurable for the
 * SCIM lane, i.e. neither `OPENWOP_SCIM_IDP_ENTITY_ID` nor the seam's
 * `OPENWOP_TEST_SCIM_URL`), we DROP `openwop-auth-scim` (keeping SAML — the
 * operator's deliberate production SSO login path; the SCIM bearer endpoint still
 * functions, we simply stop advertising a cross-lane link that cannot hold). That
 * makes "both profiles ⇒ subjectLinking:true" hold by construction: the host never
 * advertises both profiles without the leaver guarantee, and the SAML-lane runtime
 * fail-closed (`subject_link_unbound`) reads the SAME `combinedSubjectLinkingActive()`
 * predicate, so advert and enforcement can never disagree.
 */
/**
 * ADR 0730 C.3a — the v2 `auth` family, derived from the SAME gates the v1
 * `auth.profiles[]` advert uses (`advertisedAuthProfiles`), reshaped to the
 * corpus's `lanes[]`. Every lane row is a CLAIM with four required fields, so a
 * lane appears only when this deployment actually serves it:
 *   - `api-key` and `session` are unconditional (the bearer + cookie front doors);
 *   - `anonymous` rides the anon-actor surface;
 *   - `oidc` / `saml` / `scim` follow their v1 gates exactly;
 *   - `workload` follows the advertised workload schemes.
 * `revocation` and `minimumAssurance` are stated conservatively: this host
 * re-checks a session epoch per request (`next-request`), honours a SAML
 * assertion's NotOnOrAfter, and issues no sender-constrained credential, so
 * every lane is `bearer` assurance.
 */
/**
 * ADR 0730 C.3a — the v2 `aiProviders` family.
 *
 * The corpus family types `authModes` as a flat mode VOCABULARY (`string[]`),
 * where v1 carries a per-provider MAP (`{provider: modes[]}`). That is a real
 * shape difference, not a rename, so the map does not fit here: the family gets
 * the vocabulary, and the per-provider detail travels in this host's own
 * extension record (the `hostSurfaces` pattern — a host-specific fact belongs
 * under `extensions`, not smuggled into a core facet).
 */
function v2AiProvidersFamily(): Record<string, unknown> {
  const providers = ['anthropic', 'openai', 'google', 'minimax', ...hostAdvertisedSelfHosted(), ...advertisedSubscriptionOnlyProviders()];
  const byProvider = subscriptionAdvertisedProviders();
  // host-services.md §aiProviders names the vocabulary `apiKey`, `oauth-pkce`,
  // `oauth-device`, `none`, `subscription`, and a client MUST ignore an unknown
  // mode. This said `api-key` until 2026-10-04, so every v2 client ignored the
  // only mode advertised here (found by the corpus steward porting the witness).
  // The v1 per-provider map always said `apiKey`.
  const modes = new Set<string>(['apiKey']);
  if (byProvider.length > 0) modes.add('subscription');
  return {
    aiProviders: {
      status: 'experimental',
      since: '2.0',
      until: '2.1',
      witness: 'witnessable-gated',
      providers,
      authModes: [...modes],
      // PHCD-3 — the accepted input modalities. Same owner the v1 root reads
      // (`INPUT_MODALITIES`); without it a v2-only client cannot discover what
      // this host accepts, which is a capability the schema declares and we
      // simply were not answering.
      input: { modalities: [...INPUT_MODALITIES] },
      // SHAPE DIFFERS FROM v1, and copying the v1 expression here was a real
      // defect the closed v2 schema caught: v1's `aiProviders.selfHosted` is the
      // LIST of advertised self-hosted provider ids, v2's is a BOOLEAN
      // (`capabilities.schema.json` → `aiProviders.properties.selfHosted`).
      // Nothing is lost by the narrowing — the ids already ride `providers`
      // above (line 151 spreads the same call), so v2 says "is a self-hosted
      // class offered" and the identifiers stay discoverable.
      selfHosted: hostAdvertisedSelfHosted().length > 0,
    },
  };
}

/**
 * ADR 0730 C.3a — the per-provider subscription map the v2 `aiProviders` family
 * cannot express. Registered as a v2 extension so the SPA's BYOK card has a v2
 * home and stops needing the v1 discovery read.
 */
export function registerAiProvidersV2Extension(): void {
  registerV2Extension('openwop-app.ai-providers', () => ({
    subscriptionProviders: subscriptionAdvertisedProviders(),
  }));
}


function v2AuthFamily(): Record<string, unknown> | null {
  type Lane = { lane: string; issuers: string[]; revocation?: string; minimumAssurance: string; revocationWindowSeconds?: number };
  const lanes: Lane[] = [
    { lane: 'api-key', issuers: ['urn:openwop-app:env-key'], revocation: 'next-request', minimumAssurance: 'bearer' },
    // The session lane IS the cookie. A deployment that disables cookies
    // (`OPENWOP_AUTH_DISABLE_COOKIES`, the bearer-only posture) cannot
    // authenticate a session at all, so advertising the lane there would claim a
    // front door — and a revocation — that does not exist.
    ...(process.env.OPENWOP_AUTH_DISABLE_COOKIES === 'true'
      ? []
      : [{ lane: 'session', issuers: ['urn:openwop-app:session'], revocation: 'next-request', minimumAssurance: 'bearer' }]),
    // RFC 0170 owner ruling (openwop-77, 2026-09-26): an anonymous principal has
    // no credential to revoke, and the lane schema makes `revocation` OPTIONAL on
    // exactly this lane (#1540/#1553; the suite honours the omission from 2.39.x).
    // Claiming `next-request` asserted a revocation nobody can perform.
    { lane: 'anonymous', issuers: ['urn:openwop-app:anon'], minimumAssurance: 'bearer' },
  ];
  // THE OIDC LANE IS ADVERTISED WITH `exp-only` SINCE RFC 0210 (2026-09-23), and the
  // history below is kept because it is the reason the member exists.
  //
  // What changed is the VOCABULARY, not this host's behaviour: RFC 0210 added
  // `exp-only` — "honours `exp`, re-checks the trust root never" — which is exactly
  // what `oidcVerifier.ts` does. Advertising it is honest where `exp-and-recheck` and
  // `short-lived` were not, and it is not free: §B makes the window a bound this host
  // MUST enforce, which `OidcVerifier.verify` now does on BOTH `exp − iat` and
  // `exp − now`, refusing with the registered code `credential_lifetime_exceeded`.
  // The window is read from the enforcement constant rather than restated here, the
  // same discipline the `workload` lane below uses, so the number cannot drift from
  // the refusal. (`exp-only` is schema-forbidden on `api-key` and `session`: there the
  // host issued the credential itself, so revocation is in its own hands.)
  //
  // Gated on the verifier actually being configured — an advertised lane whose issuer
  // this host does not verify against would be a lane nobody can use.
  //
  // --- the pre-0210 reasoning, preserved ---
  //
  // `identity.md` §2.2 assigns `oidc` the rule `exp-and-recheck` — "honor `exp`;
  // re-check the issuer within the advertised `revocationWindowSeconds`" — and
  // §2.2 further requires that window wherever the rule names one. C.3 asserted
  // `exp-and-recheck` here and the major-2 conformance lane caught it
  // (`v2-lane-issuer-advertised`), which is the scenario doing exactly its job:
  // giving `auth` a v2 home un-skipped a probe that had never run.
  //
  // MEASURED: `middleware/oidcVerifier.ts` verifies signature, `iat`, `exp` and
  // `nbf` and NOTHING else — no introspection, no userinfo, no revocation list.
  // The subject is derived straight from the claims (`middleware/auth.ts:978`)
  // with no host-side record consulted, and the code there notes a pre-MFA token
  // "stays valid ~1h". A revoked user's token is accepted until its own `exp`.
  // So there is no window to advertise: any integer would tell a verifier that
  // revocation takes effect within it, which is false.
  //
  // The `revocation` enum has no value meaning "honours `exp`, never rechecks":
  // `next-request` promises a per-request refusal this host does not perform,
  // and `short-lived` promises a credential lifetime this host does not mint and
  // cannot bound. Reported upstream as a vocabulary gap. Until either the enum
  // gains an honest value or this host implements a real recheck, the lane is
  // OMITTED — under-claiming a lane the host serves, which is the safe
  // direction, rather than over-claiming a revocation latency it does not have.
  //
  // (No `void readOidcConfigFromEnv` guard is needed: the import stays live for
  // the v1 advert at `:312` and `:379`. An earlier cut had one, which read as
  // "referenced deliberately to silence an unused warning" and was simply
  // false.)
  const oidc = readOidcConfigFromEnv();
  if (oidc) {
    lanes.push({
      lane: 'oidc',
      issuers: [oidc.issuer],
      revocation: 'exp-only',
      revocationWindowSeconds: OIDC_REVOCATION_WINDOW_S,
      minimumAssurance: 'bearer',
    });
  }
  // The SAML/SCIM lanes come from the SAME owner as the v1 profile list. They
  // used to call the raw predicates, which skipped RFC 0164's mandatory-both
  // drop: with both lanes configured but no combined subject-linking contract,
  // v1 withdrew `openwop-auth-scim` while v2 still advertised the `scim` lane.
  // Found by the SPA's v1↔v2 discovery parity test (ADR 0647 overlap).
  const profiles = advertisedAuthProfiles();
  if (profiles.includes('openwop-auth-saml')) lanes.push({ lane: 'saml', issuers: samlIssuersForAdvert(), revocation: 'not-on-or-after', minimumAssurance: 'bearer' });
  if (profiles.includes('openwop-auth-scim')) lanes.push({ lane: 'scim', issuers: samlIssuersForAdvert(), revocation: 'next-request', minimumAssurance: 'bearer' });
  // The workload lane is advertised per SCHEME, and only when a trust root for
  // it is configured — the same gate `workloadIdentityCapability()` uses on v1.
  const wl = readWorkloadIdentityConfigFromEnv();
  if (wl) {
    for (const scheme of advertisedWorkloadSchemes(wl)) {
      // CORRECTED 2026-09-23 (ADR 0743) — this advertised `short-lived` with a
      // window, borrowing the MTLS row's rule. §2.2's `workload` row names exactly
      // one rule, `delegation-expiry` ("enforce `delegation_expired`"), and a host
      // MUST NOT advertise a rule its lane's row does not list — the 2.36 suite's
      // `v2-lane-issuer-advertised` reds on it. The host does enforce that rule
      // (`workloadIdentity.ts` refuses `delegation_expired`), and the rule names no
      // window, so none is advertised. The mint-time ceiling (MAX_CREDENTIAL_TTL_S)
      // is still enforced; it just is not what this lane's row asks a host to state.
      lanes.push({
        lane: 'workload',
        issuers: [scheme],
        revocation: 'delegation-expiry',
        minimumAssurance: 'bearer',
      });
    }
  }
  return {
    auth: {
      status: 'experimental',
      since: '2.0',
      until: '2.1',
      // `seam-gated` per spec/v2/declaration.json — the SAML/SCIM legs are
      // witnessed through the operator-supplied synthetic IdP seam.
      witness: 'seam-gated',
      lanes,
      // RFC 0163 §B — the identifier the SAML and SCIM lanes are joined on.
      // Spec-steward ruling 2026-10-10: ONLY when BOTH lanes are advertised
      // (identity.md §3, "The link is a record": a link joins exactly two
      // subjects, so a one-lane host forms none; Axiom 2; RFC 0164 §A.3 and
      // RFC 0165's `subject.keyClass` are scoped to "when both … are
      // advertised"). v1 behaved the same way. The v2 auth facet schema does
      // not enforce it (a corpus gap), so `adr0858-p4-*` is the guard.
      ...(profiles.includes('openwop-auth-saml') && profiles.includes('openwop-auth-scim')
        ? { subjectLinkKey: SUBJECT_LINK_KEY }
        : {}),
    },
  };
}

/** The issuer list a lane advert may state: the configured SCIM trust root, else the synthetic-IdP seam's, else a self-describing urn. */
function samlIssuersForAdvert(): string[] {
  const configured = process.env.OPENWOP_SCIM_IDP_ENTITY_ID;
  if (typeof configured === 'string' && configured.length > 0) return [configured];
  return ['urn:openwop-app:saml-idp'];
}

/** ADR 0730 C.3a — the v2 `prompts` family from the SAME config the v1 root spreads (`getPromptsHostConfig`). Absent when the host serves no prompt surface. */
/**
 * v2 dropped `supported` from EVERY facet — `"supported"` appears **0** times in
 * `schemas/v2/capabilities.schema.json`, against 175 in v1. Presence of the
 * object is the claim now.
 *
 * The v1 owners still carry it, at the family level AND nested inside each
 * facet (`attribution: { supported, emitsWriteEvents }`). This strips it at
 * every depth rather than re-typing the facets by hand, because a hand-written
 * v2 copy is a second source of truth for the same fact — which is exactly how
 * `aiProviders.selfHosted` shipped a v1 `string[]` into a v2 `boolean` field.
 *
 * WHD-7 — THIS IS A MIRROR, AND IT IS A MIRROR ON PURPOSE. The corpus now ships
 * the function (`@openwop/openwop-conformance/src/lib/v2-projection.ts`,
 * `stripSupported()`), and the obvious adoption — import it — is not available
 * to this file: the conformance package is a devDependency, and the runtime
 * image is built with `npm ci --omit=dev` (Dockerfile:85), so a `src/` import of
 * it typechecks, passes every test, and then fails to resolve at boot in the
 * only place that matters. (`workflowChainPackLoader.ts` records the last time
 * that exact trap shipped — ADR 0550 P2, an advertised seam answering 404.)
 *
 * So the function stays here and is PINNED instead:
 * `test/whd7-v2-projection-parity.test.ts` imports both and asserts they agree
 * on this host's real v1 document, which is the adoption a devDependency allows.
 * For that to be an equality rather than an approximation this had to stop
 * being a looser re-derivation — it recursed into objects but not ARRAYS, and
 * ignored `required[]` — so both arms below follow the corpus line for line. If
 * the corpus function moves, that test reds and this is what gets edited.
 */
export function stripSupported(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'supported') continue;
    out[k] = stripSupportedAtDepth(v);
  }
  // A `required` list naming `supported` keeps a retired field mandatory. No
  // advert VALUE carries one today — this arm is the schema-fragment half of the
  // corpus function, kept so the two agree on every input and not only on the
  // inputs this host happens to feed it.
  const required = out['required'];
  if (Array.isArray(required)) {
    const kept = required.filter((r: unknown) => r !== 'supported');
    if (kept.length > 0) out['required'] = kept;
    else delete out['required'];
  }
  return out;
}

/** The `unknown`-typed half of {@link stripSupported}: arrays are walked, scalars pass through, objects recurse. */
function stripSupportedAtDepth(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => stripSupportedAtDepth(v));
  if (value === null || typeof value !== 'object') return value;
  // `{ ...value }` widens `object` to the index signature without a cast — the
  // same move `v2MemoryFamily` makes below, for the same reason.
  return stripSupported({ ...value });
}

/**
 * ADR 0730 / PHCD-1 — `memory` at major 2. Derived from `memoryCapability()`,
 * the same owner the v1 root reads (`host/memoryDimensions.ts`), so the two
 * majors cannot disagree about what this host does.
 *
 * `witness: 'witnessable-gated'` is NOT chosen here — it is what
 * `schemas/v2/declaration.json` assigns this family. Picking a different one
 * would be a claim about how the family can be proven, which is the corpus's
 * call, not ours.
 */
function v2MemoryFamily(): Record<string, unknown> | null {
  const cap = memoryCapability();
  if (!cap.supported) return null;
  // `{ ...cap }` widens the typed record to the index signature `stripSupported`
  // needs without an `as unknown as` cast — the object really does have string
  // keys, so nothing is being asserted that the type system cannot see.
  return {
    memory: {
      status: 'experimental',
      since: '2.0',
      until: '2.1',
      witness: 'witnessable-gated',
      ...stripSupported({ ...cap }),
    },
  };
}

/**
 * `agents` at major 2, derived from `agentsCapability()`, the owner the v1
 * advert reads, so the two majors cannot disagree about what this host runs.
 * `witness: 'witnessable-gated'` per the declaration. Every conditional facet
 * (`memoryBackends`, `proposals`, `goals`) keeps its own gate, because it is
 * computed inside the shared owner.
 */
function v2AgentsFamily(): Record<string, unknown> {
  return {
    agents: {
      status: 'experimental',
      since: '2.0',
      until: '2.1',
      witness: 'witnessable-gated',
      ...stripSupported(agentsCapability()),
      // ADR 0858 P4 (spec-steward ruling openwop-e2 2026-10-10): `agents.dispatch`
      // is the v2 home of the v1 `dispatch` claim. TRUE because the host
      // implements `core.dispatch` (`bootstrap/nodes.ts`, registered on every
      // boot) and honours CP-2: it starts each worker as a separate child run
      // through `dispatchSubWorkflow` and never touches the parent's registered
      // definition (`test/adr0858-p4-multiagent-dispatch.test.ts`).
      dispatch: true,
      // RFC 0243 — the v2 seat for the v1 fan-out descriptor, projected from
      // `dispatchCapability()` (`v2FanOutFacet`). The host runs RFC 0118
      // parallel fan-out, so withholding the facet would claim it accepts only
      // `sequential` and `reject`. Requires `dispatch: true` (above).
      ...(v2FanOutFacet() ? { fanOut: v2FanOutFacet() } : {}),
    },
  };
}

/**
 * ADR 0858 P4 — `multiAgent` at major 2 (spec-steward ruling openwop-e2,
 * 2026-10-10). `version` is the highest N whose phases 1..N are ALL on, read
 * from the gates the runtime sites read (`host/multiAgentPhases.ts`); absent
 * when phase 1 is off. Level 6 (verifier) is never claimed: only the
 * verify-run seam injects a verifier.
 *
 * - `confidenceEscalationFloor` (v >= 2): the floor `nodes.ts` escalates at.
 * - `confidenceEscalationInterruptKind: 'clarification'` (v >= 2): the kind
 *   `nodes.ts` suspends with. v1 advertised `x-host-openwop-app-clarification`,
 *   which was never emitted and is not a legal v2 kind (the v2 `kind` is a
 *   closed enum; vendor kinds travel as `custom` + `data.customKind`).
 * - `crossHostCausation` (v >= 3): the stable `CROSS_HOST_CAUSATION_HOST_ID`;
 *   `ancestryEndpointSupported` because `routes/runs.ts` serves
 *   getRunAncestry under the same phase-3 gate. No event's `causationId` names
 *   a foreign event (causation ids are minted locally), so no event carries
 *   `causationHostId`, which execution.md requires only for those.
 * - `replayDeterminism` (v >= 4): `executor.ts` emits `replay.divergedAtRefusal`
 *   on a replay fork under the phase-4 gate.
 * - `statefulResume` (v >= 5): `nodes.ts` persists the iteration counter in a
 *   run variable, so a resumed loop continues at the same `iteration`.
 */
function v2MultiAgentFamily(since: string, until: string): Record<string, unknown> {
  const version = multiAgentExecutionModelVersion();
  if (version === 0) return {};
  return {
    multiAgent: {
      status: 'experimental',
      since,
      until,
      witness: 'claims-check',
      executionModel: {
        version,
        ...(version >= 2
          ? { confidenceEscalationFloor: confidenceEscalationFloor(), confidenceEscalationInterruptKind: 'clarification' }
          : {}),
        ...(version >= 3
          ? { crossHostCausation: { hostId: CROSS_HOST_CAUSATION_HOST_ID, ancestryEndpointSupported: true } }
          : {}),
        ...(version >= 4
          ? { replayDeterminism: { llmCacheKeyRecipe: 'spec-rfc-0041', refusalDivergenceEmission: true } }
          : {}),
        ...(version >= 5 ? { statefulResume: true } : {}),
      },
    },
  };
}

/**
 * ADR 0730 / PHCD-1 — `envelopes` at major 2. `reasoning` comes from
 * `getEnvelopeReasoningConfig()` (the v1 root's own source) and the Tier-1
 * posture from the single `TIER_ONE_SUBSET_COMPLIANCE` constant above.
 *
 * `witness: 'claims-check'` per the declaration — this family is a self-attested
 * posture, and the corpus classifies it as one.
 */
function v2EnvelopesFamily(): Record<string, unknown> {
  const reasoning = getEnvelopeReasoningConfig();
  return {
    envelopes: {
      status: 'experimental',
      since: '2.0',
      until: '2.1',
      witness: 'claims-check',
      reasoning: { promptDirective: reasoning.promptDirective },
      tierOneSubsetCompliance: TIER_ONE_SUBSET_COMPLIANCE,
    },
  };
}

/**
 * RFC 0209 / ADR 0749 — the major-2 envelope-kind catalog (`events.md`
 * §"The envelope-kind catalog"): `supportedEnvelopes`, `schemaVersions` and
 * `envelopeStrictness`, printed from `V2_A2UI_ENVELOPE_CATALOG` — the SAME
 * constant `host/a2uiSurfaceAdmission.ts` admits against, so the advert cannot
 * claim a kind, a floor or a mode the admission does not enforce.
 *
 * `kinds` lists `ui.a2ui-surface` alone: it is the only non-universal kind with
 * a major-2 admission path. `media.*` is not listed until something at major 2
 * admits it (the v1 root that listed it is deleted, ADR 0812 P4). The floor is
 * 2, so a version-1 surface is below the floor and — under `warn` — validated
 * against version 2. NEVER add `a2uiSurface.deltaTransport` here: RFC 0209 §D.15
 * deprecates the delta frame for major 2 (a v2 host SHOULD NOT advertise it).
 */
function v2EnvelopeCatalogFamilies(since: string, until: string): Record<string, unknown> {
  // Advertised only where something admits the kind (see `a2uiV2AdmissionReachable`).
  if (!a2uiV2AdmissionReachable()) return {};
  return {
    supportedEnvelopes: { status: 'experimental', since, until, witness: 'witnessable-gated', kinds: [...V2_A2UI_ENVELOPE_CATALOG.kinds] },
    schemaVersions: { status: 'experimental', since, until, witness: 'witnessable-gated', kinds: { ...V2_A2UI_ENVELOPE_CATALOG.schemaVersions } },
    envelopeStrictness: { status: 'experimental', since, until, witness: 'claims-check', mode: V2_A2UI_ENVELOPE_CATALOG.strictness },
  };
}

function v2PromptsFamily(): Record<string, unknown> | null {
  const cfg = getPromptsHostConfig();
  if (!cfg.supported) return null;
  // WHD-7 — through the ONE strip, not a second one. This destructured
  // `supported` off the top level only, behind an `as unknown as` cast: correct
  // for today's flat config, and silently wrong the day a facet grows a nested
  // `supported` — the exact depth the v1 owners carry it at everywhere else.
  return { prompts: { status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated', ...stripSupported({ ...cfg }) } };
}

/**
 * ADR 0745 D3 — the v2 `toolCatalog` family, under the SAME gate as the v1 record
 * (`OPENWOP_MCP_SERVER_ENABLED`: the catalog projects the `mcp` source, and without
 * the mount the routes 404). The unversioned `/tools` + `/tools/{toolId}` reach the
 * v1 handlers through the manifest-derived rewrite (`middleware/protocolVersion.ts`),
 * so this is one surface with two spellings, not a second implementation. Facets
 * mirror v1 exactly; `sessionLifecycle` stays absent because no session events are
 * emitted (`openwop-tool-session-lifecycle` is opted out in `conformance/run.ts`).
 */
function v2ToolCatalogFamily(): Record<string, unknown> | null {
  if (process.env.OPENWOP_MCP_SERVER_ENABLED !== 'true') return null;
  return {
    toolCatalog: {
      status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated',
      sources: ['mcp'],
      ...(process.env.OPENWOP_TOOLCATALOG_COMPACTVIEW === 'true' ? { compactView: true } : {}),
    },
  };
}

/** ADR 0730 C.3a — the v2 `secrets` family. Facets are the declaration's: scopes, resolution, resolveInPack. */
function v2SecretsFamily(): Record<string, unknown> | null {
  return {
    secrets: {
      status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated',
      scopes: ['tenant', 'user', 'run'],
      resolution: 'host-managed',
    },
  };
}

/** ADR 0730 C.3a — the v2 `modelCapabilities` family from the same gate config the v1 root reads. Absent when the gate is off, which is what `supported:false` means. */
function v2ModelCapabilitiesFamily(): Record<string, unknown> | null {
  const cfg = getModelCapabilityGateConfig();
  if (!cfg.supported) return null;
  return {
    modelCapabilities: {
      status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated',
      advertised: cfg.advertised,
      substitutionSupported: cfg.substitutionSupported,
    },
  };
}

/**
 * WHD-7 — the v2 `workflowChainPacks.subChains` facet, from the SAME owner the
 * v1 root reads (`workflowChainPacksCapability`). Absent when the owner
 * withdraws it, because at major 2 presence of the facet IS the claim.
 */
function v2SubChainsFacet(): Record<string, unknown> {
  const { subChains } = workflowChainPacksCapability();
  return subChains === undefined ? {} : { subChains: stripSupported({ ...subChains }) };
}

function advertisedAuthProfiles(): string[] {
  const profiles: string[] = [];
  // `openwop-auth-saml` is honored by either the conformance test seam OR a real
  // SAML SP wired to a production IdP (Okta/Azure…) via the OPENWOP_SAML_* env.
  // Read via the shared predicates so the profile list and the RFC 0164 combined
  // -contract predicate cannot drift.
  if (samlProfileAdvertised()) profiles.push('openwop-auth-saml');
  if (scimProfileAdvertised()) profiles.push('openwop-auth-scim');
  // `openwop-auth-oidc-user-bearer` (RFC 0010 §D): the bearer branch in
  // middleware/auth.ts verifies iss/aud/exp/kid against the configured issuer's
  // JWKS (middleware/oidcVerifier.ts) and maps the verified subject to a
  // deterministic personal tenant. Advertised ONLY when the verifier is
  // genuinely configured (OPENWOP_OIDC_ISSUER + OPENWOP_OIDC_AUDIENCE) — an
  // unconfigured deploy makes no OIDC claim.
  if (readOidcConfigFromEnv()) profiles.push('openwop-auth-oidc-user-bearer');
  // RFC 0164 (ADR 0623) — the mandatory-both invariant, enforced structurally.
  // If both profiles would be advertised but the combined contract cannot be
  // honoured (realms misaligned OR no shared trust root configurable), we DROP
  // `openwop-auth-scim` here rather than advertise a "both profiles" posture we
  // cannot back with `subjectLinking:true`. SAML (the production login path) is
  // kept. The two arms of the gate are witnessed independently in
  // test/auth-subject-link.test.ts.
  if (
    profiles.includes('openwop-auth-saml') &&
    profiles.includes('openwop-auth-scim') &&
    !combinedSubjectLinkingActive()
  ) {
    return profiles.filter((p) => p !== 'openwop-auth-scim');
  }
  return profiles;
}

/**
 * RFC 0040 §D — this host's stable cross-host-causation `hostId`. Advertised in
 * `crossHostCausation.hostId` and echoed by `GET /v1/runs/{runId}/ancestry`
 * (the two MUST match). A real multi-host deployment overrides via env.
 */
export const CROSS_HOST_CAUSATION_HOST_ID =
  process.env.OPENWOP_CROSS_HOST_CAUSATION_HOST_ID ?? 'openwop-workflow-engine';

// RFC 0040 phase-3 gate: moved to `host/multiAgentPhases.ts` (ADR 0858 P4).

interface Deps {
  storage: Storage;
  config: AppConfig;
}

/**
 * RFC 0149 §C — the protocol version this host speaks (strict `MAJOR.MINOR`).
 * RFC 0165 §A — `protocolVersions` is the SAME constant as an array (ADR 0625):
 * the scalar stays the v1.x negotiation input; the array is what a v2 client
 * reads to pick a major. Derived, never two literals, so they cannot drift.
 */
export const PROTOCOL_VERSION = PROTOCOL_VERSION_V1;
/**
 * v2 charter Phase 4 (P4-B′) — this host now serves TWO majors through the
 * overlap, so the array carries both and `preferredVersion` below names the 1.x
 * member. The pair is inseparable: `versioning.md` §1.1 and the documented
 * client-side default (`preferredVersion ?? max(protocolVersions[])`) mean that
 * advertising `2.0` WITHOUT `preferredVersion: "1.1"` would move every existing
 * client — and the conformance suite's own target-major default — onto major 2
 * on the next fetch. Both are derived from `middleware/protocolVersion.ts`, the
 * one place the negotiator reads them, so the advertisement cannot promise a
 * major the front door refuses.
 */
export { protocolVersions, preferredVersion };

/**
 * The closed v2 root (`schemas/v2/capabilities.schema.json`,
 * `spec/v2/core/capabilities.md` §3).
 *
 * Not a projection of the v1 document — a different document with a different
 * shape. The v1 root is open and carries a deprecated `capabilities` wrapper
 * plus dotted `host.*` mirrors; the v2 root is `additionalProperties: false`
 * and admits exactly three kinds of key: a metadata key, a declared family
 * record `{ status, since, witness, …facets }`, and `extensions.<org>.<name>`.
 *
 * WHY IT IS SHORT. `capabilities.md` §2 replaced the v1 `supported: true` flag
 * with presence: "presence of the record is the claim, and a host that does not
 * support a family MUST omit it". There is no honest way to mirror this host's
 * ~60 v1 capability families into v2 records in one change, because each v2
 * family record is a CLOSED shape with REQUIRED facets whose enums are narrower
 * than the v1 fields (`interrupt.tokenAlgs` admits only `hs256`, and this host
 * mints opaque store-backed interrupt tokens, not HMAC ones; `replay` REQUIRES
 * an `effectSeamsManifest` path this host does not serve yet). Advertising them
 * anyway would be a false statement that the closed schema would happily accept
 * for the ones whose facets merely happen to type-check. So this root claims
 * the two families whose v2 facets this host can state exactly and truthfully
 * from what it already enforces, and stays silent about the rest. Later PRs in
 * the v2 charter add records as the surfaces behind them land — an honest small
 * root beats a complete dishonest one.
 */
/**
 * RFC 0168 §E.2 / `capabilities.md` — the public keys this host signs
 * certification bundles with, read from `OPENWOP_BUNDLE_SIGNING_KEYS`.
 *
 * WHY OPERATOR CONFIG AND NOT A CONSTANT. The key is per-deployment: an adopter
 * of the white-label bundle signs with their own, and hard-coding ours would
 * have every install advertise a key whose private half only we hold. Public
 * key material is not a secret, so it rides a plain env var; the PRIVATE half
 * never enters this process — it is used offline by whoever runs `--certify`,
 * and on the reference deployment lives in Secret Manager.
 *
 * WHY A JSON ARRAY AND NOT THREE SCALARS. A retired key MUST stay listed —
 * dropping it silently invalidates every bundle it already signed — so the
 * config has to express a CURRENT key and a RETIRED one at once, which a
 * single-value env var cannot:
 *
 *   OPENWOP_BUNDLE_SIGNING_KEYS='[{"keyId":"…","alg":"ed25519",
 *     "publicKey":"<43-char base64url>","use":"certification-bundle"}]'
 *
 * `gcloud run --update-env-vars` splits on commas, so set this one with an
 * alternate delimiter (`--update-env-vars ^##^OPENWOP_BUNDLE_SIGNING_KEYS=…`).
 *
 * MALFORMED IS WITHHELD, NOT GUESSED. Every entry is checked against the closed
 * schema shape here — the 43-char base64url grammar included — and a value that
 * fails is dropped with one warn, the same withhold-the-claim precedent as the
 * workspace capability (`index.ts`, ADR 0551 P2). Advertising a key a verifier
 * cannot resolve is worse than advertising none: a bundle signed under an
 * unresolvable id FAILS the RFC 0168 Front door, whereas an absent array is an
 * honest "this signature attests integrity only". The array is omitted entirely
 * when nothing valid survives, because `capabilities.md` §2 makes PRESENCE the
 * claim.
 */
/**
 * RFC 0030 §B/§C — this host's self-attested Tier-1 structured-output posture.
 *
 * ONE owner, read by BOTH majors. It was a bare `'warn'` literal inside the v1
 * root, and emitting the v2 `envelopes` family by copying that literal would
 * have created a SECOND literal for one fact — two places to change, and
 * nothing to notice when only one of them was. The v2 assembly block a few
 * hundred lines below states the rule this restores: every facet is DERIVED
 * from the thing it describes, not typed to match it.
 *
 * A self-attestation is legitimately a constant (nothing computes a posture),
 * but it must be ONE constant.
 */
export const TIER_ONE_SUBSET_COMPLIANCE = 'warn' as const;

const SIGNING_KEY_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const SIGNING_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
let signingKeysWarned = false;

export function readBundleSigningKeys(): readonly Record<string, unknown>[] {
  const raw = process.env.OPENWOP_BUNDLE_SIGNING_KEYS?.trim();
  if (!raw) return [];
  const withhold = (why: string): readonly Record<string, unknown>[] => {
    if (!signingKeysWarned) {
      signingKeysWarned = true;
      discoveryLog.warn('bundle_signing_keys_withheld', { why });
    }
    return [];
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return withhold('not JSON');
  }
  if (!Array.isArray(parsed)) return withhold('not a JSON array');
  const out: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return withhold('an entry is not an object');
    const e = entry as Record<string, unknown>;
    if (typeof e['keyId'] !== 'string' || !SIGNING_KEY_ID.test(e['keyId'])) return withhold('bad keyId');
    if (e['alg'] !== 'ed25519') return withhold('alg MUST be ed25519');
    if (typeof e['publicKey'] !== 'string' || !SIGNING_PUBLIC_KEY.test(e['publicKey'])) {
      // The commonest operator error by far is pasting the PEM instead of the
      // 32 raw bytes. Name the ENCODING, because "bad publicKey" sends people
      // looking at the key rather than at how it is written down.
      return withhold('publicKey MUST be the 32-byte Ed25519 key as unpadded base64url (43 chars) — not PEM');
    }
    if (e['use'] !== undefined && e['use'] !== 'certification-bundle') return withhold('unknown use');
    if (e['retiredAt'] !== undefined && typeof e['retiredAt'] !== 'string') return withhold('retiredAt MUST be a string');
    out.push({
      keyId: e['keyId'],
      alg: 'ed25519',
      publicKey: e['publicKey'],
      ...(e['use'] === undefined ? {} : { use: e['use'] }),
      ...(e['retiredAt'] === undefined ? {} : { retiredAt: e['retiredAt'] }),
    });
  }
  return out;
}

function v2OAuthFamily(since: string, until: string): Record<string, unknown> {
  const snap = oauthAdvertisementSnapshot();
  if (!snap.advertised) return {};
  return {
    oauth: {
      status: 'experimental',
      since,
      until,
      witness: 'witnessable-gated',
      grants: ['authorization_code', 'refresh_token'],
      providers: snap.providers,
      credentialInterrupt: true,
    },
  };
}


/**
 * The RFC 0083 / 0099 / 0230 / 0232 trigger-bridge facets this host serves,
 * shared by the v1 advert (`triggerBridge: {supported: true, …}`) and the v2
 * family record (ADR 0810), so the two majors are one claim. Every gate below
 * is the SAME predicate the route it advertises checks.
 */
export function triggerBridgeFacets(): Record<string, unknown> {
  return {
    subscriptionStates: ['active', 'paused', 'failed', 'dead-lettered'],
    dedup: true,
    retryPolicy: { maxAttempts: 3, backoff: 'fixed' },
    // RFC 0232 / ADR 0805 — the trigger-DELIVERY dead-letter sink and its read
    // (`listTriggerDeadLetters`). Unconditional because the route is: every
    // subscription source can dead-letter (retry exhaustion; a refused
    // `required` verification), and the read is tenant-bound. Distinct from the
    // top-level RFC 0053 `deadLetter` (the RUN sink) below.
    deadLetter: { retentionDays: TRIGGER_DEAD_LETTER_RETENTION_DAYS, maxPageSize: TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE },
    // RFC 0127 G4 (ADR 0286) — the honest-off advert FLIP. `stream`/`change` join
    // `sources[]` + `ingestion.externalSources[]` ONLY when the operator turns on
    // `OPENWOP_TRIGGER_STREAM_CDC_ENABLED` (mirrors the ingest-path gate
    // `streamCdcIngestionEnabled()`), and ONLY now that RFC 0127 is Accepted +
    // a REAL consumer (the signature-verified broker/CDC push → `ingestExternalEvent`
    // in features/connections/inboundWebhooks.ts) backs the claim. Default OFF ⇒ the
    // advert stays webhook/email/form, so OPENWOP_REQUIRE_BEHAVIOR=true never reads a
    // hollow claim.
    sources: triggerIngestionEnabled()
      ? (streamCdcIngestionEnabled()
          ? ['queue', 'webhook', 'email', 'form', 'stream', 'change']
          : ['queue', 'webhook', 'email', 'form'])
      : ['queue'],
    ...(triggerIngestionEnabled()
      ? {
          ingestion: {
            externalSources: streamCdcIngestionEnabled()
              ? ['webhook', 'email', 'form', 'stream', 'change']
              : ['webhook', 'email', 'form'],
            maxBodyBytes: MAX_INGEST_BODY_BYTES,
            // A stream/change source is host-CONSUMED — the broker/CDC push is
            // authenticated at the connection layer (a signed broker push, RFC 0095
            // credential-brokered egress), so no new per-message wire verification mode
            // is added; the webhook/email/form modes remain the advertised set.
            verification: ['webhook-signature', 'email-dmarc', 'form-origin'],
            registrationEndpoint: true,
            // ADR 0793 / RFC 0230 — the signed, credential-less ingest route. Advertised
            // ONLY when the operator enables it (the route 404s otherwise), so the
            // claim and the behaviour are one flag.
            ...(inboundSigningEnabled() ? { inboundSigning: ['standard-webhooks-1'] } : {}),
          },
        }
      : {}),
  };
}

/**
 * The `agents` family, ONE owner for both majors. v1 serves it verbatim at
 * `capabilities.agents`; v2 serves it as a family record with every `supported`
 * stripped (presence is the claim at major 2). It used to be inline in the v1
 * builder only, so major 2 advertised no `agents` family at all, and every v2
 * row gated on it (the RFC 0087 org-chart schema rows among them) recorded
 * `inapplicable` against a route this host serves at both majors.
 */
export function agentsCapability(): Record<string, unknown> {
  return {
    supported: true,
    reasoning: { verbosity: 'full', tokenLimit: 512, streaming: true },
    // RFC 0004 / `agent-memory.md` §"Capability advertisement" — long-term
    // agent memory. DERIVED from the selected memory surface, never
    // asserted: the §A dimension is "cross-run DURABLE store", and this
    // host's default `memory` tier is process-local (the surface advert
    // itself says "restarts wipe state"), so claiming it there would be an
    // over-claim. Under `OPENWOP_SURFACE_MEMORY=durable` — the shared
    // Storage, CAS-safe across instances (`host/durable/durableMemory.ts`)
    // — the claim is true, and the host honours the three invariants the
    // advertisement binds it to end-to-end: CTI-1 (tenant-bucketed reads
    // plus fail-closed `memoryRef` shape validation), SR-1 (write-time
    // redaction through `writeMemoryEntryRedacted`), and TTL (expired
    // entries never surface). H49 implemented all three; before it, this
    // key was absent — which is why the four `agentMemory*` scenarios
    // skipped rather than lying.
    ...(longTermMemoryDurable() ? { memoryBackends: ['long-term' as const] } : {}),
    // RFC 0070 — this host loads pack `agents[]` into an AgentRegistry
    // (RFC 0003 installAgents) and dispatches a manifest agent via the
    // floor seam (`POST /v1/host/openwop-app/agents/{agentId}/dispatch`),
    // enforcing toolAllowlist (§A14) + handoff schema validation (§D).
    manifestRuntime: { supported: true, handoffValidation: true },
    // RFCS/0086 reference impl — standing agent roster (named agent
    // instances owning a workflow portfolio). Sample host-extension
    // under `/v1/host/openwop-app/roster`; tenant-scoped. Non-normative
    // until RFC 0086 reaches Active.
    roster: { supported: true, installScope: 'tenant' },
    // RFCS/0087 reference impl — agent org-chart (departments/roles/
    // reportsTo over roster members + responsibility roll-up). DESCRIPTIVE
    // ONLY: an org edge confers no authority (org-position-no-authority-
    // escalation). Sample host-extension under `/v1/host/openwop-app/org-chart`;
    // tenant-scoped. Non-normative until RFC 0087 reaches Active.
    orgChart: { supported: true, installScope: 'tenant', departmentNesting: true, responsibilityView: true },
    // RFC 0081 + RFC 0244 — agent eval suites (ADR 0889). `POST /runs
    // {mode:"eval"}` runs a real eval projection (`host/evals/agentEvalRun.ts`)
    // and `GET /runs/{id}/eval-summary` serves the scorecard. The facets come
    // from the ONE builder (`evalSuiteCapability`), which adds the RFC 0244
    // facets only once the vendored v2 schemas seat them (D7).
    evalSuite: { supported: true, ...evalSuiteCapability() },
    // RFC 0096 reviewable-learning proposals — host-sample seam under
    // `/v1/host/openwop-app/proposals`. Advertised ONLY when
    // `OPENWOP_PROPOSALS_ENABLED=true` (advertise/enforce parity). `apply`
    // installs the stored byte image (no re-synthesis) and is fail-closed on
    // `packs:publish` (proven non-vacuously by `proposal-reviewable-learning`).
    // `rule` was dropped from the kind enum pre-Active; dup-detection not yet
    // implemented (honest default-false).
    ...(process.env.OPENWOP_PROPOSALS_ENABLED === 'true'
      ? {
          proposals: {
            artifactKinds: ['agent-pack', 'workflow-chain-pack', 'prompt-template', 'automation'],
            duplicationDetection: false,
            activation: proposalsActivationMode(),
          },
        }
      : {}),
    // RFC 0097 standing goals — the ADR 0412 controller under
    // `/v1/host/openwop-app/goals`. Advertised when
    // `OPENWOP_GOALS_ENABLED=true`. HONESTY FLIP (ADR 0412 P5): every claim
    // below is behaviorally honored — `judge: verifier` invokes the
    // registered goal verifier over an immutable evidence snapshot
    // (`evaluateGoal`, P1); `schedule` continuation arms a real scheduler
    // job (P4); `manual` is the un-armed default. `commitment` was DROPPED
    // from the advertisement (never wired — ADR 0412 P4 decision);
    // `heartbeat` stays honest-omitted. `requiresBounds` true ⇒ create
    // without RFC 0058 bounds is 422, and bounds are runtime-enforced (P2).
    // `test/goals-advertisement-guard.test.ts` pins ad↔behavior parity.
    ...(process.env.OPENWOP_GOALS_ENABLED === 'true'
      ? {
          goals: {
            judge: 'verifier',
            continuation: ['schedule', 'manual'],
            requiresBounds: goalsRequiresBounds(),
          },
        }
      : {}),
  };
}

/**
 * A v2 family record's `witness` is the ONE corpus-derived field of the record
 * (`capabilities.schema.json` §since; steward ruling 2026-09-11): `status`,
 * `since` and `until` are this host's claim, `witness` is the corpus's
 * classification of how the family can be observed. It was TYPED here per record
 * and MEASURED 2026-10-03 disagreeing with `spec/v2/declaration.json` on seven
 * of them (idempotency, replay, interrupt, eventLog, forms, compensation, packs).
 * Stamped from the declaration at assembly so it cannot drift again; a family
 * the declaration does not list keeps what the record says.
 */
function stampDeclaredWitness(doc: Record<string, unknown>): Record<string, unknown> {
  const declared = new Map<string, string>();
  for (const f of (declaration().families ?? []) as Array<{ key?: unknown; witness?: unknown }>) {
    if (typeof f.key === 'string' && typeof f.witness === 'string') declared.set(f.key, f.witness);
  }
  for (const [key, rec] of Object.entries(doc)) {
    const w = declared.get(key);
    if (w === undefined || rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if ('witness' in (rec as Record<string, unknown>)) (rec as Record<string, unknown>).witness = w;
  }
  return doc;
}

/**
 * ADR 0825 P1 / RFC 0236 §B — the `hostEvents` record: every host-event type
 * this host emits with its delivery class. `witness` is restamped from the
 * declaration by `stampDeclaredWitness`; `experimental` is the declaration's
 * technical maturity. Absent unless the flag is on.
 */
function v2HostEventsFamily(since: string, until: string): Record<string, unknown> {
  if (!hostEventsV2Enabled()) return {};
  const types = advertisedHostEventTypes();
  if (types.length === 0) return {};
  return { hostEvents: { status: 'experimental', since, until, witness: 'witnessable-gated', types } };
}

/**
 * ADR 0858 P3 — host-service families v1 always advertised that have a v2 seat
 * and were never projected. Production has been v2-only since 2026-10-03, so
 * until this existed these surfaces were undiscoverable, and every major-2
 * scenario gated on them recorded `inapplicable`.
 *
 * Built from the SAME constants and functions as the v1 records, never from the
 * v1 document (ADR 0812 P3c deletes it). Each facet is one the v2 record declares
 * (`additionalProperties: false`) AND one the host honours. `supported` is not
 * carried (RFC 0192: presence is the claim). `witness` is a placeholder that
 * `stampDeclaredWitness` overwrites from `spec/v2/declaration.json`.
 */
function v2HostServiceFamilies(since: string, until: string): Record<string, unknown> {
  const rec = (facets: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ status: 'experimental', since, until, witness: 'witnessable-gated', ...facets });
  const retention = defaultRetentionDays();
  return {
    httpClient: rec({
      ssrfGuard: true,
      maxResponseBodyBytes: SAFE_FETCH_MAX_RESPONSE_BODY_BYTES,
      requestTimeoutMs: SAFE_FETCH_REQUEST_TIMEOUT_MS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      safeFetch: {},
    }),
    // RFC 0239 — the council roster rides core.conversationGate config; an
    // off-roster resumed turn is refused 422 conversation_speaker_not_participant
    // unconsumed, and a roster over this cap is refused at run creation with
    // 422 conversation_roster_exceeded (ADR 0858 P3 behaviour gap — fixed).
    multiPartyConversation: rec({ maxParticipants: MAX_MULTI_PARTY_PARTICIPANTS }),
    // Usage is emitted on real model calls (`usageEmitter.ts`); the emission
    // scenario's live-model fixture is withheld while the supervisor is a mock
    // (`SUPERVISOR_CALLS_LIVE_MODEL`), so it is inapplicable, not failing
    // (ADR 0858 P3 behaviour gap — fixed).
    providerUsage: rec({ costEstimates: true, currency: 'USD' }),
    conversationTurnModelProvenance: rec(),
    // `retentionDays` has `minimum: 1`; retention is opt-in and defaults off,
    // and then omission is the only honest encoding of "never purged".
    deadLetter: rec(retention > 0 ? { retentionDays: retention } : {}),
    artifactTypes: rec({ types: artifactTypesAdvert() }),
    // ADR 0858 P4 (2026-10-10) — `scheduling` (RFC 0052, host-services.md
    // §scheduling). v1 gated this on the test seam because "no clock yet fires
    // real runs"; that stopped being true when the wall-clock daemon landed
    // (`host/scheduleDaemon.ts`, started unconditionally in `index.ts`). Each
    // facet is one the host honours:
    //   - `cron`: `cronSchedule.ts` computes `nextFireAt`; the daemon fires
    //     durable jobs (`DurableCollection`, survives restart), fire-once per
    //     slot (ADR 0787 D1), missed ticks collapse to one recovery fire.
    //   - `delayed`: the one-shot cadence `ONE_SHOT_CRON` + `firstFireAtMs`
    //     (`schedulingService.ts`, ADR 0309 D1); the first fire spends the job.
    //   - `maxFutureHorizon`: the ONE constant the registration refusal
    //     (`schedule_horizon_exceeded`, `details.maxFutureHorizon`, routes/
    //     scheduler.ts) and the cadence search read (ADR 0787 D6).
    //   - `calendar`: NOT advertised — no calendar-reference schedule exists.
    scheduling: rec({ cron: true, delayed: true, maxFutureHorizon: MAX_FUTURE_HORIZON_ISO }),
    // ADR 0858 P3 storage slice — `storageFamilyFacets()` is the one builder for
    // both majors: unenforced v1 limits DROPPED, backends DERIVED per request
    // from `resolveBackendId()` and omitted where the backend has no enum value
    // (`queueBus.backends` on `durable`). Only `v2AdvertisedStorageFamilies()`
    // go out: queueBus, plus the probed families while the storage probe
    // fixture is advertised (see that function — without it they block
    // certification). blobStorage stays withheld.
    ...(() => {
      const facets = storageFamilyFacets();
      return Object.fromEntries(v2AdvertisedStorageFamilies().map((f) => [f, rec(facets[f])]));
    })(),
    // ── ADR 0858 P3 slice 3 ─────────────────────────────────────────────────
    // `subWorkflow` — `core.subWorkflow` is always served. `inputMapping` is
    // read from `subWorkflowInputMappingHonoured()`, the SAME function the
    // register-time refusal reads (`workflowDefinitionValidation.ts`), so
    // execution.md §subWorkflow's "not advertising ⇒ MUST refuse a non-empty
    // inputMapping with validation_error" holds by construction. Before this the
    // v2 root carried no record and the host ACCEPTED mappings it did not
    // advertise: a live MUST breach. Omitted (not `false`) when the fact is off.
    subWorkflow: rec(subWorkflowInputMappingHonoured() ? { inputMapping: true } : {}),
    // `dataResidency` — under `dataResidencyAdvertised()`, the v1 predicate.
    // When it holds, the run-create admission gate (`routes/runs.ts`,
    // `dataResidencyEnabled()`) refuses any region outside `dataResidencyRegions()`
    // with `422 residency_unavailable` before a run exists; `regions` is that list.
    ...(dataResidencyAdvertised() ? { dataResidency: rec({ regions: dataResidencyRegions() }) } : {}),
    // `anonymousActor` — under the gate the anon surfaces read
    // (`anonymousActorAdvertised()` ⇒ `OPENWOP_ANON_ACTOR_ENABLED`), facets from
    // `anonymousActorCapability()` minus v1's `supported`.
    ...(anonymousActorAdvertised() ? (() => {
      const { supported: _supported, ...facets } = anonymousActorCapability();
      return { anonymousActor: rec(facets) };
    })() : {}),
    // `authorization` — ONLY while RFC 0049 enforcement is on
    // (`isAuthorizationEnforced()`, the gate `requireProtocolScope` reads). v1
    // says `{ supported: false }` when off; at v2 presence is the claim, so off
    // means absent, and the prod root (gate off) is unchanged.
    ...(isAuthorizationEnforced() ? (() => {
      const { supported: _supported, ...facets } = authorizationCapability();
      return { authorization: rec(facets) };
    })() : {}),
  };
}

/**
 * The A2A agent card URL both majors advertise: `OPENWOP_A2A_PUBLIC_BASE_URL`
 * (custom-domain backends) else the request origin. One function, so the v1 and
 * v2 `a2a.agentCardUrl` cannot disagree.
 */
function a2aAgentCardUrl(req?: Request): string {
  const override = process.env.OPENWOP_A2A_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  const base = override || (req ? requestOrigin(req) : 'http://localhost:8080');
  return `${base}/.well-known/agent-card.json`;
}

/**
 * ADR 0858 P4 — whether the v2 `a2a` / `mcp` records are projected. Both records
 * are BUILT from the version SSoT and validate against the v2 schema
 * (`test/adr0670-v2-advert-validates.test.ts`), and the host work the P1 ledger
 * named shipped: `refreshedAt` + its 90-day ratchet, `negotiation.decided` from
 * the outbound clients, the legacy profile ids filtered, the major-2 A2A version
 * rules. Both are still WITHHELD, because a `--certify` run with each projected
 * (major-2-only host, 2026-10-07) found behaviour gaps the omission had hidden —
 * ADR 0858 decision 4: they stay ledgered, each naming its scenario, until fixed.
 *
 * `a2a` — the negotiation rows pass (`v2-negotiation-decided-emitted`,
 * `v2-minimum-version-refused`, `v2-negotiation-authenticated`,
 * `v2-legacy-profiles-absent`, `v2-refresh-sla`), but the A2A 1.0 SERVER fails
 * `v2-a2a-operation-map` (10 legs: context inference / mismatch, terminal-task
 * refusal, state projection, error codes and ErrorInfo data, unreadable =
 * not-found, push-config isolation and secrecy) and `v2-a2a-push-delivery`
 * (4 legs + 1 blocked). Two more rows record `blocked` in the local lane only —
 * `v2-interop-trace-context` (a2a leg) and `v2-a2a-client-error-details` —
 * because their ad-hoc peers bind ephemeral ports the WHD-19 egress allowlist
 * does not admit. Projecting also needs `OPENWOP_A2A_WORKFLOW_ID=conformance-approval`
 * in the lane (a 1.0 `Message` has no skill selector).
 *
 * `mcp` — `v2-minimum-version-refused` (mcp leg) records `blocked`: the floor is
 * the legacy revision `2025-06-18`, which is also the lowest revision the suite
 * can offer; raising it retires the legacy MCP revision before
 * `MCP_LEGACY_PROFILE_SUNSET`, a product decision. And the MCP server mount fails
 * `v2-mcp-mount-map` (5 legs) and `v2-mcp-tasks` (disconnect cancels the run).
 */
// `V2_PROJECT_A2A` lives in `host/a2aProfile.ts` beside the inbound rules it
// also switches (`a2aV2RulesActive()`), so the claim and the behaviour flip together.
export const V2_PROJECT_MCP = false;

/** ADR 0858 P4 — the v2 `mcp` record, from the version SSoT (`host/mcpProfile.ts`). */
export function v2McpRecord(since: string, until: string, req?: Request): Record<string, unknown> {
  return {
    status: 'experimental', since, until, witness: 'seam-gated',
    revisions: [...MCP_SUPPORTED_VERSIONS],
    preferredVersion: advertisedMcpProtocolVersion(),
    minimumRevision: mcpMinimumRevision(),
    refreshedAt: MCP_VERSIONS_REFRESHED_AT,
    // `interop.md` §"Legacy profiles are absent" — `mcp-2025-06-18-legacy` fails
    // the v2 item pattern, so only the current profile is named.
    profiles: mcpV2Profiles(),
    features: [...MCP_CURRENT_FEATURES],
    // `format: uri` — absolute, unlike the v1 slot's path. Same origin the
    // agent card URL is built from.
    serverUrls: [`${req ? requestOrigin(req) : 'http://localhost:8080'}${VENDOR_ROOT}/mcp`],
    serverMount: { transports: ['streamable-http'] },
  };
}

/**
 * ADR 0858 P4 — the v2 `a2a` record, from the version SSoT (`host/a2aProfile.ts`
 * `servedA2AVersions`), never from the v1 document.
 *
 * Built only while `a2aV2RulesActive()` holds: `V2_PROJECT_A2A` on a
 * major-2-only host. That is the SAME predicate that switches the inbound card
 * and JSON-RPC route to the v2 version rules, so the claim and the behaviour
 * cannot disagree. Why a major-2-only host: while v1 is
 * still served, RFC 0152's major-1 rules bind the same card URL — a header-less
 * GET is the 0.3 card — and `interop.md` requires the `preferredVersion` card
 * header-less, so no v2 record could be honest on an overlap host.
 *
 * Every required facet is honoured: `versions` / `preferredVersion` /
 * `minimumVersion` are what the client and the route negotiate (an explicit
 * below-floor `A2A-Version` is refused, `negotiation.decided` is emitted on every
 * outcome of the client's negotiation), and `refreshedAt` is the dated review
 * that `test/adr0858-interop-refreshed-at.test.ts` keeps inside 90 days.
 */
export function v2A2aRecord(since: string, until: string, req?: Request): Record<string, unknown> | null {
  if (process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true' || !a2aV2RulesActive()) return null;
  const durable = process.env.OPENWOP_A2A_DURABLE_TASKS === 'true';
  return {
    status: 'experimental', since, until, witness: 'seam-gated',
    versions: [...servedA2AVersions()],
    preferredVersion: advertisedA2AProtocolVersion(),
    minimumVersion: a2aMinimumVersion(),
    refreshedAt: A2A_VERSIONS_REFRESHED_AT,
    profiles: a2aV2Profiles(),
    agentCardUrl: a2aAgentCardUrl(req),
    streaming: process.env.OPENWOP_A2A_STREAMING === 'true',
    pushNotifications: durable,
    durableTasks: durable,
  };
}

function v2InteropFamilies(since: string, until: string, req?: Request): Record<string, unknown> {
  const a2a = v2A2aRecord(since, until, req);
  return {
    ...(a2a ? { a2a } : {}),
    ...(V2_PROJECT_MCP && process.env.OPENWOP_MCP_SERVER_ENABLED === 'true' ? { mcp: v2McpRecord(since, until, req) } : {}),
  };
}

/**
 * `host-capabilities.md` §host.artifactTypes — the `types` MAP, keyed by
 * artifactTypeId. ONE builder for both majors' records (ADR 0858), so the v1
 * and v2 adverts cannot drift; every facet's honesty argument lives here.
 */
export function artifactTypesAdvert(): Record<string, unknown> {
  return Object.fromEntries(
    listArtifactTypes().map((t) => [
      t.artifactTypeId,
      {
        // Honest per §host.artifactTypes: `validated` is the runtime guarantee
        // that this host validates the type BEFORE emit. It does —
        // `runArtifactStore.detectTypedArtifact` gates on
        // `isRegisteredArtifactType` then refuses to mint on
        // `!validateArtifact(...).valid`.
        validated: true,
        // RFC 0145 — provenance. Requirement 3 binds this to agree with what
        // `artifact.created` would carry for the type, so it is read from the
        // SAME registry field the event's `registrationSource` comes from
        // (`artifactTypes.validateArtifact` returns `t.registrationSource`).
        // One source, so the two surfaces cannot drift into a false advert.
        registrationSource: t.registrationSource,
        // RFC 0142 §"Gating" — `store: true` is a promise about the TYPE, not
        // a description of the host's best path to it. Per the 2026-08-10
        // scope ruling it is universally quantified over paths that persist an
        // artifact carrying a REGISTERED artifactTypeId: every such path must
        // emit `artifact.created`.
        //
        // This host has two persisting paths and only one emits:
        //   documents-generation node  → persists + EMITS (packs/feature.documents.nodes:125)
        //   outputs-`artifact` envelope → persists via `persistRunArtifact`,
        //                                 emits NOTHING by design (runArtifactStore.ts:18)
        // The second gates on `isRegisteredArtifactType` and writes the row WITH
        // the type, so it IS in scope for the facet — the unregistered-tier
        // carve-out does not rescue it.
        //
        // MEASURED reachability, not assumed: the only artifactTypeIds any pack
        // puts in an `outputs.artifact` envelope are app.research, canvas.*,
        // code.execution-result, interactive.chart, kicktodo.plan-revision and
        // production.plan — none `doc.*`; and `detectTypedArtifact` refuses any
        // envelope carrying a `documentId`, which every document-backed artifact
        // does. So `doc.*` types reach persistence ONLY through the emitting path.
        // (`core.trigger.artifact` passes a caller-supplied artifactTypeId, but
        // returns it FLAT, not under `outputs.artifact`, so it never reaches the
        // typed persist path — checked, because it would otherwise falsify this.)
        //
        // The `doc.` prefix is the binding rule itself, not a naming convention:
        // `documentsService.ts:507` derives a template's type as `doc.${seed.kind}`.
        // Pinned by `artifact-types-store-reachability.test.ts`, which reds if a
        // future pack routes an advertised type through the non-emitting path.
        ...(t.artifactTypeId.startsWith('doc.') ? { store: true } : {}),
        // Mirrors `ArtifactType.validation` — DERIVED from the registered
        // schema rather than asserted, so a closed-world pack schema is
        // reported closed instead of defaulting to the spec's `"open"`.
        validation:
          (t.schema as { additionalProperties?: unknown }).additionalProperties === false
            ? 'closed'
            : 'open',
        ...(t.export.length > 0 ? { export: t.export } : {}),
      },
    ]),
  );
}

export function buildV2Advertisement(config: AppConfig, req?: Request): Record<string, unknown> {
  // `capabilities.md` §8 — the record's `status` IS the declared technical
  // maturity, and `until` is REQUIRED whenever the status is not `stable`.
  // `2.1` is the horizon by which each either stabilises or carries a removal
  // row; it is not in the past while this host serves 2.0.
  const EXPERIMENTAL_UNTIL = '2.1';
  const SINCE = '2.0';
  const signingKeys = readBundleSigningKeys();
  return stampDeclaredWitness({
    // ── metadata keys (§3.1) ────────────────────────────────────────────────
    // `protocolVersion` is kept as `preferredVersion`'s twin for v1 readers
    // through the overlap; it is removed after Phase 5. DERIVED, not the v1
    // constant: the 2026-10-03 cut rehearsal found it still said `1.1` on a
    // retired host, which `versioning.md` §1.1 refuses ("on a host serving a
    // single major, preferredVersion MUST equal protocolVersion").
    protocolVersion: preferredVersion(),
    protocolVersions: [...protocolVersions()],
    preferredVersion: preferredVersion(),
    minClientVersion: minClientVersion(),
    // `persistence.md` §"The era key" / `versioning.md` §2.2 (axis 4) —
    // "Discovery MUST advertise the value the host writes for new runs and
    // nothing else". This IS the constant the storage seat stamps
    // (`storage/eventEra.ts`), imported rather than re-typed, because
    // persistence.md orders the two: "collapsing to one constant is a
    // precondition for advertising, not a consequence". Before this change the
    // host advertised no era at all and its runs carried none; both now say 3,
    // and there is one place to change if that ever moves.
    eventLogSchemaVersion: EVENT_LOG_SCHEMA_VERSION,
    // RFC 0168 §E.2 — omitted entirely when unconfigured, because
    // `capabilities.md` §2 makes presence the claim: an absent array says
    // "this host publishes no bundle-signing key", which is the truth for a
    // deployment that has not configured one, and is not the same statement
    // as an empty array.
    ...(signingKeys.length > 0 ? { signingKeys } : {}),
    implementation: {
      name: config.serviceName,
      version: config.serviceVersion,
      vendor: config.serviceVendor ?? DEFAULT_SERVICE_VENDOR,
    },
    fixtures: listLoadedConformanceFixtures(),
    extensions: {
      // `<org>.<name>`; `openwop` and `vendor` are the reserved orgs, so this
      // host's records live under `openwop-app`.
      'openwop-app.host': {
        notes: 'OpenWOP reference application. Serving the v2 wire; not production-hardened.',
        demoMode: demoMode(),
        // RFC 0181 / ADR 0652 — the org's proprietary path namespace, declared
        // (not inferred): version-agnostic, outside the protocol contract, the
        // `OpenWOP-Version` header selects nothing under it. `twin` is the
        // overlap alias that retires atomically with `/v1`, so a retired host
        // does not advertise it: it answers 410 (MEASURED on prod 2026-10-07).
        root: `${VENDOR_ROOT}/`,
        // (`twin`, the `/v1` alias, is gone with v1: ADR 0812 P3c.)
        rfc: '0181',
        // ADR 0761 — where to read event streams when the front door buffers
        // them (host-proprietary; absent unless OPENWOP_STREAM_BASE_URL is a
        // valid https origin). Same service, same auth — a transport hint.
        ...streamBaseRecord(),
      },
      // Feature-owned `<org>.<name>` records (host/discoveryExtensions.ts) — live, key-pattern + reserved-org checked at registration.
      ...v2Extensions().extensions,
    },
    // ── family records (§3, {status, since, witness, …facets}) ──────────────
    //
    // `limits` — declared `technical: stable` in `spec/v2/declaration.json`, and
    // this host genuinely enforces every number below (the run-duration ceiling
    // is imported from the executor constant, the body cap equals the
    // `express.json` limit). `stable` records MUST NOT carry `until`.
    limits: {
      status: 'stable',
      since: SINCE,
      witness: 'witnessable-gated',
      clarificationRounds: 5,
      schemaRounds: 3,
      envelopesPerTurn: 32,
      maxNodeExecutions: 1000,
      maxRunDurationMs: RUN_DURATION_CEILING_MS,
      maxRequestBodyBytes: 1_048_576,
      // ADR 0897 D2 / RFC 0247 — the SAME predicate `host/sseChannel` bounds an
      // opted-in wire stream by, so advert and behaviour cannot drift. Absent
      // until the vendored v2 schema defines the member.
      ...streamAgeLimit(),
    },
    // RFC 0199 (ADR 0753 D11) — `oauth`, with its `credentialInterrupt` facet, only
    // while `oauthAdvertised()` holds: the SAME predicate the credential gate and
    // `connector.auth-expired` read, so the claim and the behaviour cannot drift.
    // `witness` is the declaration's (`spec/v2/declaration.json`), `experimental`
    // per its technical maturity.
    ...v2OAuthFamily(SINCE, EXPERIMENTAL_UNTIL),
    // `i18n` + `content` (ADR 0748) — the v2 twins of the v1 blocks, from the SAME
    // operator source (`OPENWOP_I18N_LOCALES` via host/i18n) and under the SAME
    // gate, so the two majors cannot disagree about which locales are served.
    // The ops the `content` record claims (`GET /content/pages/{slug}`, the §D
    // admin ops) are served unconditionally by `features/cms/contentProtocolRoutes.ts`;
    // what the gate withholds is the CLAIM that more than the base is negotiated.
    // CORRECTED (ADR 0781): "served unconditionally" now holds for MAJOR 1 ONLY.
    // Under major 2 an operation whose family is not advertised MUST answer
    // `404 not_found` (errors.md § "Unadvertised operations", RFC 0228), so with
    // this gate off the content routes 404 on v2. See `host/unadvertised.ts`.
    // RFC 0103 §A invariants hold by construction: `content.baseLocale ==
    // i18n.defaultLocale` (one function), base ∉ `content.supportedLocales`
    // (`hostContentLocales` removes it), and content ⊆ i18n (a filter of it).
    ...(hostI18nEnabled()
      ? {
        i18n: {
          status: 'experimental', since: SINCE, until: EXPERIMENTAL_UNTIL, witness: 'witnessable-gated',
          defaultLocale: hostDefaultLocale(),
          supportedLocales: hostSupportedLocales(),
        },
        content: {
          status: 'experimental', since: SINCE, until: EXPERIMENTAL_UNTIL, witness: 'witnessable-gated',
          baseLocale: hostDefaultLocale(),
          supportedLocales: hostContentLocales(),
        },
      }
      : {}),
    // `webhooks` — the host signs deliveries with the `v1` algorithm
    // (`host/webhookDeliveryWorker.ts`), plus the RFC 0201 Standard Webhooks
    // companion headers on subscriptions that opted in (ADR 0747).
    //
    // CORRECTED 2026-09-25 — `retryPolicy` was "deliberately absent" on the
    // reasoning that "the v1 advertisement says `durable: false`". That reasoning
    // was wrong twice: v2 has no `durable` flag, and webhooks.md §Durability binds
    // EVERY host advertising `webhooks` to retry "per its advertised retryPolicy"
    // and dead-letter rather than drop ("best-effort is not a conforming mode"),
    // so the obligation applied anyway and the host was simply not naming its
    // policy. The v1 `durable: false` stays: at v1 it means RFC 0083's trigger-
    // bridge mode (state machine, dedupKey, dead-letter sink), which this host does
    // not implement. Values are DERIVED from the worker, never restated: every row
    // is enqueued with WEBHOOK_MAX_ATTEMPTS (`routes/webhooks.ts` enqueueDelivery,
    // the one enqueue site) and retried on `webhookBackoffMs` (2s·2^(n-1)).
    // MEASURED in production 2026-09-25: 500, 500, 204 arrived at +0 / +1.7 s / +4 s.
    // A test pins advert ↔ worker (`test/webhooks-retry-policy-advert.test.ts`).
    // ADR 0810 (supersedes ADR 0793's "no v2 triggerBridge" for this family) —
    // the v2 record of the same facets. `witnessable-gated` and `experimental`
    // are the declaration's (`spec/v2/declaration.json` families[triggerBridge]).
    // Presence is the advert at v2 (no `supported`). The routes it names are the
    // same handlers, reached through the v2 mount with bound ids (ADR 0723).
    triggerBridge: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      ...triggerBridgeFacets(),
    },
    webhooks: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      // RFC 0201 / ADR 0747 — `standard-webhooks-1` beside `v1`, and the
      // rotation facet, from the ONE list the routes validate against.
      signatureAlgorithms: [...SUPPORTED_SIGNATURE_ALGORITHMS],
      retryPolicy: { maxAttempts: WEBHOOK_MAX_ATTEMPTS, backoff: 'exponential' },
      secretRotation: { overlapSeconds: secretRotationOverlapSeconds() },
    },
    // ADR 0825 P1 / RFC 0236 §B — `hostEvents`, only with OPENWOP_HOST_EVENTS_V2
    // on. `types[]` is the SAME list the emission gate reads (host/hostEventTypes.ts),
    // so the advert and what `/host/events` + the `{ hostEvent }` webhook body carry
    // cannot disagree. Flag off ⇒ absent, and the root is byte-identical.
    ...v2HostEventsFamily(SINCE, EXPERIMENTAL_UNTIL),
    // ── ADR 0730 C.3a — four families the v1 root advertised and the v2 root
    // did not, which is why the SPA still read discovery through `v1Client`.
    // Each is DERIVED from the same source the v1 advert uses, so the two
    // majors cannot disagree, and each is gated the way v1 gates it: a family
    // absent here means "this deployment does not serve it", never "we forgot".
    // `spec/v2/declaration.json` gives all four an empty `floorScenarios`, so
    // advertising them obliges facets, not a scenario floor.
    ...(v2AuthFamily() ?? {}),
    ...(v2PromptsFamily() ?? {}),
    ...(v2ToolCatalogFamily() ?? {}),
    ...(v2SecretsFamily() ?? {}),
    ...(v2ModelCapabilitiesFamily() ?? {}),
    ...v2AiProvidersFamily(),
    // ADR 0840 D4 (RFC 0238 §A) — the v2 `uiPlugins` record. Facets from the one
    // source v1 advertises (`uiPluginsCapability`, minus v1's `supported`);
    // `served: true` only when the two RFC 0238 operations are registered, so the
    // advertisement and the routes cannot drift. Without this record the v2 root
    // carried no `uiPlugins` at all and `v2-ui-plugin-boundary` read every leg
    // inapplicable.
    ...(presentationEnabled('uiPlugins') ? (() => {
      const { supported: _supported, ...facets } = uiPluginsCapability();
      return { uiPlugins: { status: 'experimental', since: SINCE, until: EXPERIMENTAL_UNTIL, witness: 'witnessable-gated', ...facets, ...(uiPluginOperationsServed() ? { served: true } : {}) } };
    })() : {}),
    ...(v2MemoryFamily() ?? {}),
    ...v2AgentsFamily(),
    ...v2MultiAgentFamily(SINCE, EXPERIMENTAL_UNTIL),
    ...v2EnvelopesFamily(),
    ...v2EnvelopeCatalogFamilies(SINCE, EXPERIMENTAL_UNTIL),
    ...v2HostServiceFamilies(SINCE, EXPERIMENTAL_UNTIL),
    // ADR 0858 P4 — `a2a` (major-2-only hosts) and `mcp`, each once its
    // behaviour gaps close (`V2_PROJECT_A2A` / `V2_PROJECT_MCP`).
    ...v2InteropFamilies(SINCE, EXPERIMENTAL_UNTIL, req),
    // ── The four families this host honours and had simply never claimed ──
    //
    // Each facet below is DERIVED from the thing it describes, not typed to
    // match it. That is the whole reason these can go out: a hand-written
    // `tokenAlgs: ['hs256']` is a promise, while `INTERRUPT_TOKEN_ALGS` is the
    // array the minting code actually iterates. Same for the manifest address
    // and the fork modes. If any of those change, the advert changes with them
    // rather than drifting into a false claim.
    //
    // WHY THESE WERE ABSENT UNTIL NOW, since the reason is instructive: the
    // docblock above said `interrupt.tokenAlgs` admits only `hs256` "and this
    // host mints opaque store-backed interrupt tokens", and that `replay`
    // requires a manifest "this host does not serve yet". BOTH halves were
    // stale. `host/interruptToken.ts` mints `ow2.<alg>.<kid>.<payload>.<mac>`
    // and is wired at `executor/suspendManager.ts` + `routes/interrupts.ts`;
    // the manifest shipped in ADR 0635. A certify run found 32 v2 assertions
    // failing on "host MUST advertise the family.X profile", every one of them
    // a claim this host could already make honestly, and ZERO behavioural.
    //
    // Under-advertising is not the safe direction. It removes external
    // verification of behaviour that is actually shipping — the exclusive-cursor
    // replay defect ADR 0633 fixed lived behind an unadvertised `replay`, where
    // no corpus leg could reach it.
    // `idempotency` — Layer 1 is real here: `POST /runs` with a repeated
    // `Idempotency-Key` and the same body returns the SAME run; the same key
    // with a different body is refused on the request-hash check
    // (`idempotency.md` §Layer 1, `routes/runs.ts`). Layer 2 is the invocation
    // log, now READABLE at `GET /runs/{runId}/effects` (RFC 0173 §C.2) — which
    // is what `v2-effect-identity-business-key` requires and what kept this
    // family withheld until now.
    //
    // `crossRegion: 'single-region'` is what this deployment IS. Claiming
    // anything else would be the false facet the closed schema would happily
    // accept, since the enum admits three values and only one of them is true.
    idempotency: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-unaided',
      crossRegion: 'single-region',
    },
    // `runList` — RFC 0182, ADR 0658. Facets are the ONE owner
    // `host/runList.ts` that the handler enforces.
    //
    // CORRECTED 2026-09-11 (steward ruling, crosstalk `5d9b`): `since` is
    // THIS HOST's minor, not the corpus minor that introduced the family. It
    // shipped once as `2.1` / `2.2` — the corpus timeline — and that was
    // wrong for two reasons the ruling makes plain. `since` carries the
    // axis-1 grammar, the same grammar as `protocolVersions[]` members, so a
    // record reading `2.1` on a host advertising `["1.1","2.0"]` puts `since`
    // on the corpus timeline and `until` on this host's, in adjacent fields
    // under one grammar. And `spec/v2/declaration.json` publishes `witness`
    // and `maturity` per family but NO `since`, so there is nowhere to copy a
    // corpus value from: a field with no source is a host claim. Hence the
    // same constants every other experimental family here uses — one host,
    // one timeline, no literals.
    //
    // `status` stays `experimental` even though RFC 0182 is Accepted: v1's
    // "drop the marker once the owning RFC is accepted" rule did not carry
    // into v2, and 82 of 85 declared families are experimental.
    runList: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      maxPageSize: RUN_LIST.maxPageSize,
      filters: [...RUN_LIST.filters],
    },
    // `replay` — CLAIMED as of ADR 0637, and the note it replaces is worth
    // keeping in mind rather than deleting outright.
    //
    // This slot held a withholding for months: `replay` gates `v2-run-fork-prefix`,
    // whose MUST (`runs.md` §Fork — a replay fork AT A SEQUENCE answers 201) this
    // host answered 501 to. An earlier attempt claimed the family, watched
    // `replay-fork-arbitrary.test.ts` go red, and concluded that two replay forks
    // at one `fromSeq` produce genuinely different tails.
    //
    // They do not. MEASURED (ADR 0637): the fixture is three `core.noop` nodes,
    // and the red was three host defects — replay resumed from no snapshot, it
    // re-emitted `run.started` over the inherited prefix, and divergence detection
    // read the two logs from different cursors. Each manufactured a
    // `replay.diverged` event whose freshly-generated `replayEventId` was the only
    // field that differed between replays. With those fixed the 501 is gone and
    // mid-sequence replay is deterministic, so the withholding's own stated
    // release condition — "until mid-sequence replay is deterministic" — is met.
    //
    // Both facets are DERIVED, which is the only reason this is safe to claim:
    // `modes` is the array `POST /runs/{id}:fork` validates against, and the
    // manifest address is computed from the route that serves it. Neither can
    // drift into a false claim without the serving code moving first.
    replay: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      // `witnessable-unaided`: a client can drive the whole property from the
      // public wire — create a run, fork it twice at one `fromSeq`, compare the
      // tails. No seam, no host cooperation.
      witness: 'witnessable-unaided',
      modes: [...FORK_MODES],
      effectSeamsManifest: V2_EFFECT_SEAMS_PATH as '/host/effect-seams',
    },
    // `interrupt` — RFC 0176 token scheme. `tokenAlgs` is the module's own
    // exported array, so this states what the minter can actually produce.
    interrupt: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-unaided',
      tokenAlgs: INTERRUPT_TOKEN_ALGS as readonly 'hs256'[],
    },
    // `eventLog` — the v2 snapshot carries `eventLogSchemaVersion: eraOf(run)`
    // and the storage seat translates era-2 logs for a major-2 reader
    // (`storage/eventEraAdapter.ts`). `crossEngineOrdering` is OMITTED rather
    // than guessed: this host runs one engine, and an absent optional facet is
    // honest where a fabricated one is not.
    eventLog: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-unaided',
    },
    // `packs` — the RFC 0025 pack surface plus the `/v1/packs-test/*` mirror,
    // which the ADR 0634 alias now makes reachable at its v2 address. That
    // mirror IS the `testMode` facet, so it is claimed only when the seam
    // surface is actually enabled rather than whenever the routes exist.
    // ── ADR 0670 — TWO families this host has served at major 1 all along,
    //    declared at major 2 for the first time.
    //
    // It was five until the major-2 ratchet ran. Declaring a family UN-SKIPS
    // the scenarios gated on it (`behaviorGate`), and three of the five then
    // executed for the first time and FAILED — see `major2Ledger.ts` for the
    // measured reason on each. Advertising them would have been a false wire
    // claim, which is the thing `discovery.ts` exists to prevent, so they went
    // back on the ledger with their real reasons instead of their stale ones.
    //
    // The ledger's ORIGINAL reasons were genuinely stale — the v2 records they
    // said did not exist do exist. What I got wrong was concluding from that
    // that the rows should GO. A stale justification is not the same as a wrong
    // decision, and for three of the five the decision was right on grounds
    // nobody had written down.
    //
    // They sat on `MAJOR2_UNDECLARED_FAMILIES` with the reason "no closed v2
    // record declared yet". MEASURED 2026-09-13: `schemas/v2/capabilities.schema.json`
    // declares ALL of them (89 properties), each as `{status, since, witness}`
    // plus facets. The reason outlived the corpus work that removed it — the
    // same shape as the seam-floor comments retired yesterday, one layer over,
    // in the ledger's justifications rather than its entries.
    //
    // Each record is the v1 facets MINUS `supported`: `capabilities.md` line 39
    // — "presence of the record is the claim, and a host that does not support
    // a family MUST omit it" — which is why this host's v2 document carries
    // ZERO `supported` seats where its v1 document carries 168.
    //
    // `status: 'experimental'` is deliberate and conservative. The BEHAVIOUR is
    // mature — every one of these has served the v1 wire for a long time — but
    // what is new is the v2 RECORD, and a `stable` claim would assert that the
    // v2 facet semantics are settled when this host is the first thing to
    // exercise them. `until` is REQUIRED whenever status is not `stable` (§8),
    // and `2.1` is the horizon by which each stabilises or carries a removal
    // row. Downgrading a `stable` claim later is a breaking wire change;
    // promoting an `experimental` one is not.
    //
    // Every `witness` here is `witnessable-gated`: a client can drive each
    // property from the public wire — read a run's compensation projection,
    // list form content packs, post and read back an annotation, instantiate a
    // chain pack, list connection packs — but each needs an authenticated,
    // tenant-scoped request. None needs a test seam, so none may claim
    // `seam-gated`, and none is reachable anonymously, so none may claim
    // `witnessable-unaided`.
    //
    // Declaring a family REMOVES it from `conformance/major2Ledger.ts` in the
    // same commit. RFC 0148 §B forbids advertising and opting out at once, and
    // `test/major2-undeclared-ledger.test.ts` derives one side from this
    // function and fails on any overlap — the check that did not exist when
    // `family.idempotency` shipped in both states at once.
    // ADR 0746 — `conversationPrimitive` (RFC 0005), the same unconditional
    // claim the v1 root makes (`conversationPrimitive: true`, below): this host
    // runs `core.conversationGate` open/exchange/close on both majors, and the
    // v2 record is the v1 flag with the declaration's fields (`witness:
    // 'claims-check'`, `facets: []` — spec/v2/declaration.json). Its absence
    // was an under-advert, not a withholding: nothing on `major2Ledger.ts`
    // opted it out, and it gates RFC 0205's `v2-conversation-turn-parts`.
    conversationPrimitive: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'claims-check',
    },
    feedback: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      targets: ['run', 'event', 'node'],
      signals: ['rating', 'correction', 'label', 'flag'],
    },
    // ADR 0807 — `compensation` at major 2. It sat on `major2Ledger.ts`
    // because `v2-compensation-read-projection` failed its MUST: an advertiser
    // serves `GET /runs/{runId}/compensation`, and this host did not. It does
    // now (`host/compensationProjection.ts`), so the record lands and the
    // ledger row goes in the same commit (RFC 0148 §B). The facets are SPREAD
    // from the one v1 owner minus `supported` — presence is the claim at v2 —
    // so the two majors cannot advertise different ordering models.
    // ADR 0809 — `connections` at major 2. It sat on `major2Ledger.ts` because
    // `v2-provider-conflict` failed: v2 refuses the later registration of a
    // bare provider id (no version precedence) and resolves the qualified
    // `<packName>#<id>` form. Both now hold for every pack that targets major 2
    // only; a pack that still admits major 1 keeps v1 §B.6 precedence.
    connections: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      packsSupported: true,
      // RFC 0233 — the registry reads are served (`/connection-providers`).
      providerRead: true,
    },
    // ADR 0808 — `forms` at major 2. It sat on `major2Ledger.ts` because a
    // field's `when` (RFC 0177 §E.4) was not honoured: the loader dropped it
    // and `createForm` never stored it. Both now validate it with the chain
    // loader's own edge-condition mapper, submission evaluates it with the
    // executor's evaluator, and the public renderer hides by the same rule.
    // `contentPacks` is the v1 record's facet: templates instantiate through
    // the hand-authored `createForm` path.
    forms: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      contentPacks: true,
    },
    compensation: (({ supported: _supported, ...facets }) => ({
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      ...facets,
    }))(COMPENSATION_CAPABILITY),
    workflowChainPacks: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      // PRESENCE is the claim, at every depth. The sub-object declares NO
      // `supported` property and set `additionalProperties: false`, so
      // `{ supported: true }` — which is what the v1 record carries and what
      // these schemas' own DESCRIPTIONS still say ("When `supported: true`…")
      // — is schema-INVALID at v2. The description is stale corpus prose; the
      // property list is the contract. Caught by reading `properties` instead
      // of the sentence above it.
      //
      // WHD-7 — DERIVED from the v1 owner, where this was the literal `{}`. The
      // literal was wrong twice, and the parity test found both before it had
      // finished being written:
      //   1. It was UNCONDITIONAL. `workflowChainPacksCapability()` withdraws
      //      `subChains` under `OPENWOP_CHAIN_SUBCHAINS=0`, and `from-chain`
      //      then refuses with `sub_chain_unsupported` — while major 2 went on
      //      advertising the facet. The v2 schema's own text: a host that does
      //      NOT advertise this block MUST refuse. We advertised AND refused.
      //   2. It dropped `maxDepth`, which the v2 sub-object DOES declare. `{}`
      //      reads as the schema default (8), so the advert was true only for as
      //      long as `MAX_SUB_CHAIN_DEPTH` happened to equal it.
      // Only `subChains` is taken: `deferredParameters` and `hostExpansionSeam`
      // are v1-only — the closed v2 record declares neither — and no strip can
      // know that, so that half is a named pick which the schema polices.
      ...v2SubChainsFacet(),
    },
    packs: {
      status: 'experimental',
      since: SINCE,
      until: EXPERIMENTAL_UNTIL,
      witness: 'witnessable-gated',
      // RFC 0025 §C point 1: `isolated` asserts a pack PUT through the mirror
      // never appears in a production `/v1/packs/*` listing. That is a real
      // guarantee here (`routes/packs-test.ts` serves an in-memory catalog
      // distinct from the registry), not a restatement of the flag — the flag
      // only decides whether the surface is mounted at all.
      ...(process.env.OPENWOP_TEST_SEAM_ENABLED === 'true'
        ? { testMode: { isolated: true } }
        : {}),
    },
    // RFC 0168 §C.1 — the seams profile is METADATA, not a capability family,
    // and it is a claim that `/conformance/seams/…` is actually mounted.
    //
    // Gating it on OPENWOP_TEST_SEAM_ENABLED alone is not enough: this repo's
    // own harness sets that flag (`conformance/run.ts`), so the claim would go
    // out under the harness while the seam space is not mounted — a live false
    // advertisement, and precisely the kind the suite is built to catch. The
    // claim is therefore gated on the seams being MOUNTED, which is a separate
    // switch this PR never turns on. When the seam PR lands it flips
    // `OPENWOP_V2_SEAMS_MOUNTED` and the advertisement follows the mount
    // rather than the intent.
    //
    // WHD-6 — `conformance.certificationBundleUrl` is DELIBERATELY absent from
    // this root even when the v1 document carries it. The slot exists at major 2
    // (`schemas/v2/capabilities.schema.json`), but there it addresses
    // `schemas/v2/certification-bundle.schema.json`, which pins `bundleVersion:
    // "3"` — and `host/conformanceClaims.ts` serves `'2'` only (the in-process
    // artifact; ADR 0735 makes the major-2 bundle a post-deploy CLI cut). A
    // pointer to a document that is not what the pointer promises is a false
    // claim; omission is fully conformant. Add it here only together with a
    // reader that can serve a v3 bundle — `whd18-certification-bundle-routes.test.ts`
    // pins the absence so a projection refactor cannot leak the v1 pointer.
    //
    // WHD-18 (2026-09-21) — that reader now exists, and the pointer is added
    // exactly on the terms above: ONLY in origin mode (`OPENWOP_CERT_BUNDLE_ORIGIN`),
    // ONLY when a `bundleVersion: "3"`, `suite.targetMajor: 2` bundle for THIS
    // commit has verified against this host's own `signingKeys`, and pointing at
    // the MAJOR-2 route, never the v1 one. Image mode still omits it, for the
    // reason the paragraph above gives. The slot is the one the v2 schema already
    // declares, so no new discovery field reaches the wire (RFC 0147 §A).
    ...(() => {
      const url = certificationBundleUrlV2(req ? requestOrigin(req) : 'http://localhost:8080');
      const conformance = {
        ...(seamsMounted() ? { seamsProfile: 'openwop-conformance-seams-v2' } : {}),
        ...(url === undefined ? {} : { certificationBundleUrl: url }),
      };
      return Object.keys(conformance).length > 0 ? { conformance } : {};
    })(),
  });
}

/**
 * Is the `/conformance/seams/…` space actually served? The v2 root advertises
 * `conformance.seamsProfile` only when this is true — an advertisement is a
 * claim about mounted routes, never about a feature flag's intent.
 */
function seamsMounted(): boolean {
  // Derived, never asserted. The claim is that `/conformance/seams/…` is served,
  // so it is read from the mount's own manifest (`routes/conformanceSeams.ts`),
  // whose entries a test calls one by one. The previous form read
  // `OPENWOP_V2_SEAMS_MOUNTED` — an env var nothing checked against reality, so
  // setting it where the seams are absent advertised a path space the host does
  // not serve. An env var can be wrong; a manifest a test exercises cannot be
  // wrong in the direction that matters.
  //
  // CORRECTED 2026-09-12: this said "FALSE today, deliberately: four operations
  // are missing and all four sit on the seams-v2 floor". ADR 0639 completed the
  // floor (see the correction in `routes/conformanceSeams.ts`), so what this
  // returns tracks ONE thing: `OPENWOP_TEST_SEAM_ENABLED`. It is false on the
  // production service on purpose — the floor seams plant runs — so production
  // advertises no `conformance.seamsProfile`, and a suite scenario that finds
  // the profile absent records `inapplicable`, never `blocked` (RFC 0168 §E.1:
  // `blocked` is bundle-wide fatal and is reserved for a profile that IS
  // advertised while the seam answers 404). Unadvertised here is the honest
  // posture, not a gap.
  return seamsFloorServed();
}

export function registerDiscoveryRoutes(app: Express, _deps: Deps): void {
  // RFC 0200 §A — protected-resource metadata (RFC 9728), unauthenticated.
  //
  // A REGEXP ROUTE because the document must answer at the URL RFC 9728 §3.1 FORMS FROM
  // THE RESOURCE IDENTIFIER, and this backend is reached two ways: bare (`https://host`,
  // local + direct Cloud Run) and behind the Hosting `/api` rewrite
  // (`https://app.openwop.dev/api`), whose URL is the SUB-PATH form
  // `/.well-known/oauth-protected-resource/api`. Serving only the root form is
  // sabotage-leg (b) of `v2-protected-resource-metadata`. `firebase.json` already routes
  // every `/.well-known` sub-path here, so no hosting change is needed. (Written
  // without the glob on purpose: a `/` followed by two asterisks inside a line comment
  // opens a block comment as far as the naive stripper in
  // `test/whd18-certification-evidence.test.ts` is concerned, which swallowed two real
  // `ensureCertificationEvidence(` call sites below and reddened that scan. Recorded
  // because the failure named neither this file nor a glob.)
  //
  // §A.1 binds a host advertising an `oauth2`/`oidc` lane, and this host advertises the
  // `oidc` lane exactly when the verifier is configured — so the SAME gate answers here.
  // Unconfigured, the document would have no authorization server to name, and an empty
  // `authorization_servers` is worse than a 404.
  app.get(/^\/\.well-known\/oauth-protected-resource(?:\/.*)?$/, (req, res) => {
    const oidc = readOidcConfigFromEnv();
    if (!oidc) {
      res.status(404).json({ error: 'not_found', message: 'This host advertises no OAuth-lane; RFC 0200 §A.1 does not bind it.' });
      return;
    }
    // The suffix IS the resource's path component (RFC 9728 §3.1 inserts the segment
    // between host and path), so `resource` echoes the identifier the URL was formed
    // from rather than a second declaration of what this host calls itself.
    const suffix = req.path.slice(PRM_SEGMENT.length).replace(/\/$/, '');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      resource: `${requestOrigin(req)}${suffix}`,
      // Exactly the URL-form issuers of the OAuth lanes — no more (an issuer the lanes
      // do not name is a second declaration) and no fewer (a lane issuer left out hides
      // an authorization server the caller must reach).
      authorization_servers: [oidc.issuer],
      // ADR 0745 D2 — exactly the scopes some protocol route refuses a caller for
      // (`SCOPES_SUPPORTED` = the enforced core + ADR 0755 key-lane extension scopes,
      // parity-tested against the call sites), not the
      // thirteen-name vocabulary. (ADR 0743 omitted the field while nothing enforced
      // any: a self-service key's declared scopes were ignored on protocol routes.)
      scopes_supported: [...SCOPES_SUPPORTED],
      // Deliberately no
      // `dpop_bound_access_tokens_required` / `tls_client_certificate_bound_access_tokens`:
      // the lane's minimumAssurance is `bearer`, and claiming a binding it does not
      // require is the `sender-constraint-no-bearer-downgrade` violation.
    });
  });

  app.get('/.well-known/openwop', async (req, res) => {
    // `capabilities.md` §1 — the v2 root is the ONLY representation this host
    // serves. ADR 0812 P4: the v1 document and its builder are deleted; a
    // request naming another major is refused 406 by the negotiator before it
    // reaches this handler, so there is no representation left to select.
    //
    // WHD-18 — the pointer below is decided from the origin cache, so make it
    // current FIRST, inside this request (bounded to 2 s, and a Map lookup when
    // cached). Awaited on purpose: under Cloud Run's CPU throttling a refresh
    // started here and finished "later" may never finish (#3056). A no-op
    // unless `OPENWOP_CERT_BUNDLE_ORIGIN` is set; never throws.
    await ensureCertificationEvidence(2, readBundleSigningKeys());
    // RFC 0199 (ADR 0753 D11) — same pattern: make the `oauth` claim current
    // inside the request; the builders read the snapshot synchronously.
    await refreshOAuthAdvertisement();
    const body = JSON.stringify(buildV2Advertisement(_deps.config, req));
    // RFC 0165 §C.2 (ADR 0625): the validator is the standard `ETag`, and a
    // matching `If-None-Match` answers `304` through the helper the RFC 0115 run
    // route uses. `Capabilities-Etag` was a v1 header (`headers.md` §"Removed in
    // v2") and went with the v1 representation.
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=60');
    if (ifNoneMatchSatisfied(req, etag)) {
      res.status(304).end();
      return;
    }
    res.type('application/json').send(body);
  });

  // ── The public certification bundle (major 2, origin mode only) ────────────
  //
  // UNAUTHENTICATED by design: a certification claim only an authorized caller
  // can fetch is not a public claim, and RFC 0089 §D's pointer is meant to be
  // resolvable by "any third party (auditor, adopter, registry)".
  //
  // ADR 0812 P4 slice 3 — the major-1 route (`/conformance/certification-bundle`)
  // and the `/conformance/claims` document are DELETED. Both served only the
  // image stamp the in-process `--certify` emitter wrote; nothing has written it
  // since ADR 0869, and the emitter is gone. What remains is the WHD-18 major-2
  // route, which serves a verified origin object for this commit, or 404. The
  // route and the discovery pointer hang off the ONE predicate `servedBundle(2)`
  // (WHD-6), so they cannot disagree.
  app.get(CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH, async (_req, res) => {
    await ensureCertificationEvidence(2, readBundleSigningKeys());
    const served = servedBundle(2);
    if (served === undefined) {
      res.status(404).json({
        error: 'not_found',
        message: evidenceFromOrigin()
          ? 'No verified major-2 certification bundle is published for this build yet. Evidence is cut against the DEPLOYED revision after it serves, then published out of the image (ADR 0735); until it verifies against this host\'s commit and signing keys, nothing is served (RFC 0089 §D: absence is conformant).'
          : 'This host publishes no certification bundle: no evidence origin is configured (OPENWOP_CERT_BUNDLE_ORIGIN). Absence is not a failed claim (RFC 0089 §D); to publish, set the origin and run scripts/publish-evidence.sh after the deploy.',
      });
      return;
    }
    // Immutable per KEY (the key is this build's commit); a re-cut replaces the
    // object and appears within the reader's positive TTL plus this.
    res.set('Cache-Control', 'public, max-age=300');
    // The EXACT bytes that verified. Re-serialising would be harmless to the
    // signature (it covers a digest of the rows, not the file) but it would
    // change the file's own sha256 — the digest `publish-evidence.sh` and a
    // third party compare against what was uploaded.
    res.type('application/json').send(served.bytes);
  });

  app.get('/openapi.json', (_req, res) => {
    // Sample serves the published spec verbatim — points consumers at
    // the canonical openapi if they want full surface. Production hosts
    // ship a copy with their actual route subset.
    res.json({
      openapi: '3.1.0',
      info: {
        // Brand-driven, not hard-coded: title + description flow from the
        // service config (OPENWOP_SERVICE_NAME / OPENWOP_SERVICE_DESCRIPTION)
        // so a white-label host doesn't emit "openwop" strings it didn't set.
        title: _deps.config.serviceName,
        version: _deps.config.serviceVersion,
        description: _deps.config.serviceDescription ?? DEFAULT_SERVICE_DESCRIPTION,
      },
      // ADR 0669: each key follows the cut (`advertisedPath`), so a v2 reader and a
      // post-retirement reader are never handed a `/v1` address that answers 410.
      paths: advertisedPaths({
        '/runs': { post: { summary: 'Create a run' } },
        '/runs/{runId}': { get: { summary: 'Fetch run snapshot' } },
        '/runs/{runId}/cancel': { post: { summary: 'Cancel a run' } },
        '/runs/{runId}:fork': { post: { summary: 'Fork a run from a sequence' } },
        '/runs/{runId}/events': { get: { summary: 'SSE event stream' } },
        '/runs/{runId}/events/poll': { get: { summary: 'Poll events (long-poll alternative to SSE)' } },
        '/runs/{runId}/interrupts/{nodeId}': { post: { summary: 'Resolve a node-scoped interrupt' } },
        '/interrupts/{token}': { post: { summary: 'Resolve an interrupt by signed token' } },
        '/webhooks': {
          get: { summary: 'List webhook subscriptions (refs only; no secret)' },
          post: { summary: 'Register a webhook subscription' },
        },
        '/webhooks/{subscriptionId}': { delete: { summary: 'Delete a webhook subscription' } },
        '/webhooks/{subscriptionId}/test': { post: { summary: 'Fire a signed test delivery to a webhook subscription' } },
        '/packs': { get: { summary: 'List installed packs' } },

        // RFC 0028 — prompt library. The reference host serves all
        // six routes via `routes/prompts.ts`. capabilities.prompts.
        // endpointsSupported is advertised as true; mutableLibrary as
        // true. Read endpoints (GET /prompts, GET /prompts/{id},
        // POST /prompts:render) are gated on endpointsSupported;
        // mutating endpoints (POST/PUT/DELETE) are additionally gated
        // on mutableLibrary.
        '/prompts': {
          get: { summary: 'List prompt templates (RFC 0028 §A)' },
          post: { summary: 'Create a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
        },
        '/prompts/{templateId}': {
          get: { summary: 'Fetch a prompt template (RFC 0028 §A)' },
          put: { summary: 'Replace a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
          delete: { summary: 'Delete a user-source prompt template (RFC 0028 §A; requires mutableLibrary)' },
        },
        '/prompts:render': {
          post: { summary: 'Render a prompt template with supplied variable bindings (RFC 0028 §A)' },
        },

        // ── Host-extension routes (NOT part of the OpenWOP wire
        //    contract — vendor-prefixed per host-extensions.md) ──
        '/host/openwop-app/byok/secrets': {
          get: { summary: 'List stored BYOK credentialRefs (refs only)', tags: ['host-extension'] },
          post: { summary: 'Store a BYOK credentialRef + value', tags: ['host-extension'] },
        },
        '/host/openwop-app/byok/secrets/{credentialRef}': {
          delete: { summary: 'Remove a stored BYOK secret', tags: ['host-extension'] },
        },
        '/host/openwop-app/runs/{runId}/interrupts': {
          get: { summary: 'List open interrupts for a run (authed; returns tokens)', tags: ['host-extension'] },
        },
        '/host/openwop-app/example-data-summary': {
          get: { summary: 'Summarize app readiness for CLI and diagnostics', tags: ['host-extension'] },
        },
        '/host/openwop-app/daemon-status': {
          get: { summary: 'Report backend pid / startTime / uptimeSeconds / lastHeartbeat for CLI lifecycle commands', tags: ['host-extension'] },
        },
        '/host/openwop-app/scheduler/jobs': {
          get: { summary: 'List scheduled cron jobs (RFC 0052 sample CRUD)', tags: ['host-extension'] },
          post: { summary: 'Register a scheduled cron job; rejects beyond maxFutureHorizon with schedule_horizon_exceeded (RFC 0052 §B)', tags: ['host-extension'] },
        },
        '/host/openwop-app/scheduler/jobs/{jobId}': {
          delete: { summary: 'Remove a scheduled cron job (RFC 0052 sample CRUD)', tags: ['host-extension'] },
        },
        '/host/openwop-app/scheduler/jobs/{jobId}/trigger': {
          post: { summary: 'Fire a scheduled job once now (RFC 0052 §B.2 fire-once-per-tick)', tags: ['host-extension'] },
        },
        '/host/openwop-app/chat/sessions': {
          get: { summary: 'List chat sessions for the calling tenant', tags: ['host-extension'] },
          post: { summary: 'Create a new chat session', tags: ['host-extension'] },
        },
        '/host/openwop-app/chat/sessions/{sessionId}': {
          get: { summary: 'Fetch a chat session header', tags: ['host-extension'] },
          patch: { summary: 'Rename a chat session', tags: ['host-extension'] },
          delete: { summary: 'Delete a chat session (cascades to messages)', tags: ['host-extension'] },
        },
        '/host/openwop-app/chat/sessions/{sessionId}/messages': {
          get: { summary: 'Load every message in a chat session', tags: ['host-extension'] },
          post: { summary: 'Append a message to a chat session', tags: ['host-extension'] },
        },
        '/host/openwop-app/prompt/compose': {
          post: {
            summary: 'RFC 0027 §E compose seam — drives prompt-composed-* conformance scenarios (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/host/openwop-app/prompt/resolve': {
          post: {
            summary: 'RFC 0029 §A four-layer resolve seam — drives prompt-resolution-chain-* conformance scenarios (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/host/openwop-app/test/evaluate-model-capability-gate': {
          post: {
            summary: 'RFC 0031 §B model-capability gate seam — drives model-capability-{substituted,insufficient} conformance scenarios with synthetic input (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
        '/host/openwop-app/test/emit-envelope-reliability': {
          post: {
            summary: 'RFC 0032 §B envelope-reliability event emission seam — drives envelope-{retry.*,refusal,truncated,nlToFormat.engaged,recovery.applied} conformance scenarios via synthetic test-event-log emission with defense-in-depth credentialRef/recoveredContent rejection (sample-only; NOT part of the canonical wire contract)',
            tags: ['host-extension'],
          },
        },
      }),
      tags: [
        { name: 'host-extension', description: 'Sample-only routes outside the canonical OpenWOP wire contract, vendor-prefixed under /host/openwop-app/*.' },
      ],
    });
  });
}

/** OpenAPI `paths`, keyed through `advertisedPath`: a key the cut retired is dropped.
 *  The keys are written unversioned since ADR 0812 P4 slice 2b; the `/v1` strip
 *  that used to sit here had nothing left to strip. */
function advertisedPaths<T>(paths: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(paths).flatMap(([k, v]) => {
    const addr = advertisedPath(k);
    return addr ? [[addr, v] as const] : [];
  }));
}

/** ADR 0897 D2 — `limits.maxStreamAgeSec`, only while this host bounds opted-in streams. */
function streamAgeLimit(): { maxStreamAgeSec?: number } {
  const sec = maxStreamAgeSec(defaultMaxAgeMs());
  return sec !== undefined ? { maxStreamAgeSec: sec } : {};
}
