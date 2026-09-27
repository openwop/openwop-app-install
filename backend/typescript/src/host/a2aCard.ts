/**
 * ADR 0552 P2 — the Agent Card builder, ONE source for both profiles.
 *
 * `spec/v1/a2a-integration.md` §C, invariant `a2a-card-runtime-consistent`:
 *
 *   "The card and `capabilities.a2a` MUST be generated from the same source the
 *    runtime routes on. OpenWOP capability projection MUST NOT invent an
 *    interface absent from the card, and the card MUST NOT list an interface
 *    the host does not route."
 *
 * That is why the two shapes live in one module beside the routing facts they
 * describe, rather than being assembled inside the route handler that serves
 * them: the discovery slot (`routes/discovery.ts`), the version refusal
 * (`routes/agents.ts`) and both cards all read {@link A2A_SUPPORTED_VERSIONS},
 * and the 1.0 card's `skills[]` reads the same {@link a2aInvocableWorkflowId}
 * the 1.0 `SendMessage` path routes on. There is no second list to drift.
 *
 * ── The two shapes, and which one a header-less GET gets ────────────────────
 *
 * 1.0 replaced the card's top-level `url` / `protocolVersion` /
 * `preferredTransport` / `additionalInterfaces` with a single
 * `supportedInterfaces[]`. The shapes are mutually exclusive: §C's conformance
 * witness asserts a 1.0 card has NO top-level `url` ("a card with both shapes
 * is neither"), so a host cannot dual-shape its way out of the choice.
 *
 * **CORRECTED 2026-08-16 (openwop#1028, RFC 0152 register S18 Q1).** P2 shipped
 * "header-less gets the PREFERRED shape", on the reasoning that a card is the
 * host describing itself and so §B's receiver rule stopped at discovery. The
 * spec owner reversed that: while `a2a-0.3-legacy` is advertised, a header-less
 * card GET returns the 0.3 shape, and a 1.0 client MUST send `A2A-Version: 1.0`
 * to get the 1.0 card. The selection rule now lives in ONE place —
 * `a2aProfile.ts` {@link cardVersionFor} — beside the operation rule it matches.
 *
 * The reversal's reason is the cost this docblock previously named and accepted:
 * a 0.3-era peer that discovers this host header-less and resolves the RPC
 * endpoint from `card.url` finds no `url`. That breaks it NOW instead of at the
 * sunset, which defeats the point of advertising the legacy profile at all.
 * `a2a-integration.md` §A dates the legacy window
 * (`A2A_LEGACY_PROFILE_SUNSET`); ADR 0552 P4 closes it, and on that day
 * header-less becomes the preferred (1.0) card with no further code change.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §A, §C
 */

import { getAgentRegistry } from '../executor/agentRegistry.js';
import {
  A2A_SUPPORTED_VERSIONS,
  LEGACY_A2A_PROTOCOL_VERSION,
  advertisedA2AProtocolVersion,
  type A2AProtocolVersion,
} from './a2aProfile.js';

/** Where the JSON-RPC binding is mounted, relative to the backend origin. */
export const A2A_JSONRPC_PATH = '/v1/host/openwop-app/a2a';

/**
 * The workflow an A2A 1.0 `SendMessage` starts (§D.1: "No `taskId` ⇒
 * `POST /v1/runs` for the workflow the `skill` resolves to").
 *
 * EXACTLY ONE, and that is a decision rather than a shortcut. Upstream's 1.0
 * `Message` carries no skill selector — a caller picks the *agent*, and the
 * agent picks the skill — so a host advertising several skills over one
 * JSON-RPC interface would have no conformant way for the peer to choose
 * between them. Minting `metadata.openwop.skillId` to fill the gap would be a
 * new declared mapping on the `metadata.openwop.*` namespace, which §D.2 closes
 * to the two keys the corpus declares: that is an RFC, not a host decision.
 *
 * So the card advertises the one workflow the runtime actually routes to. §C:
 * "A skill absent from routing MUST NOT appear."
 */
export function a2aInvocableWorkflowId(): string {
  return process.env.OPENWOP_A2A_WORKFLOW_ID?.trim() || 'openwop-app.approval-gate';
}

/** Card `capabilities` — the same two facts `capabilities.a2a` advertises. */
export function a2aCardCapabilities(): { streaming: boolean; pushNotifications: boolean } {
  return {
    streaming: process.env.OPENWOP_A2A_STREAMING === 'true',
    pushNotifications: process.env.OPENWOP_A2A_DURABLE_TASKS === 'true',
  };
}

/** The 0.3 card's `skills[]` — one per installed PACK agent (see below). */
function legacySkills(): Array<Record<string, unknown>> {
  // Grade-pass fix (ADR 0379): PACK agents only. a2a dispatch is tenant-less
  // (`agentExists` finds pack agents only, post-#1954), so advertising user
  // agents would be a dishonest wire claim — and a cross-tenant leak of every
  // tenant's persona/label/description on a well-known URL.
  return getAgentRegistry()
    .list()
    .filter((a) => !a.ownerTenant)
    .map((a) => ({
      id: a.agentId,
      name: a.label ?? a.persona,
      description: a.description ?? `${a.persona} (modelClass ${a.modelClass})`,
      tags: [a.modelClass],
    }));
}

/**
 * The legacy 0.3 AgentCard — unchanged in every field from the pre-P2 shape
 * except that `protocolVersion` now reads the constant that means "this is a
 * 0.3 document" rather than the one that means "this host prefers X".
 *
 * Skills are AGENTS here because 0.3's `message/send` routes on
 * `params.agentId` to an agent dispatch. The 1.0 card lists a workflow because
 * 1.0's `SendMessage` starts a run. Each card lists what its own interface
 * routes — which is §C's rule applied per profile, not two answers to one
 * question.
 */
export function buildA2aCard03(baseUrl: string): Record<string, unknown> {
  return {
    name: 'openwop-reference-host',
    description: 'OpenWOP reference workflow-engine host exposing its installed manifest agents over A2A (RFC 0076).',
    url: `${baseUrl}${A2A_JSONRPC_PATH}`,
    version: '1.0.0',
    // ADR 0552 P0 — derived from the one owner (host/a2aProfile.ts), never a
    // literal here. A version hard-coded into the object it decorates cannot be
    // negotiated against or refused; it can only be edited, which is how a
    // legacy subset starts being presented as generic A2A support.
    protocolVersion: LEGACY_A2A_PROTOCOL_VERSION,
    // ADR 0035 / RFC 0100 — the A2A AgentCard `capabilities` mirror the `a2a`
    // discovery slot. `pushNotifications` is honest only when durable Tasks are
    // wired (OPENWOP_A2A_DURABLE_TASKS). `streaming` (tasks/resubscribe) is
    // DECOUPLED onto its own OPENWOP_A2A_STREAMING flag (default off) — the
    // server serves resubscribe but we don't advertise it until conformance
    // ships a resubscribe witness, so `streaming:true` isn't a vacuous claim.
    capabilities: a2aCardCapabilities(),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: legacySkills(),
  };
}

/**
 * The A2A 1.0 AgentCard (§C).
 *
 * `supportedInterfaces[]` carries one entry per SERVED version, preferred
 * first, all on the JSON-RPC binding: §C fixes JSON-RPC-at-1.0 as the mandatory
 * floor for the `a2a-1.0` profile and makes HTTP+JSON / gRPC optional additions
 * this host does not serve. The set of `protocolVersion` values is therefore
 * `A2A_SUPPORTED_VERSIONS` by construction — the equality §C requires against
 * `capabilities.a2a.protocolVersions` cannot drift, because both are that array.
 */
export function buildA2aCard10(baseUrl: string): Record<string, unknown> {
  const url = `${baseUrl}${A2A_JSONRPC_PATH}`;
  const preferred = advertisedA2AProtocolVersion();
  const ordered: readonly A2AProtocolVersion[] = [
    preferred,
    ...A2A_SUPPORTED_VERSIONS.filter((v) => v !== preferred),
  ];
  return {
    name: 'openwop-reference-host',
    description:
      'OpenWOP reference workflow-engine host, exposed as an A2A 1.0 agent (RFC 0152 `a2a-1.0` profile) with the 0.3 legacy profile still served.',
    // The HOST's release identifier, not the A2A protocol version (§C).
    version: '1.0.0',
    supportedInterfaces: ordered.map((protocolVersion) => ({ url, protocolBinding: 'JSONRPC', protocolVersion })),
    capabilities: {
      ...a2aCardCapabilities(),
      // §C: `extensions[]` MUST list only extensions the host implements, and a
      // host that lists none MUST NOT raise `ExtensionSupportRequiredError`.
      extensions: [],
      // §C: true iff the host serves `GetExtendedAgentCard`. It does not.
      extendedAgentCard: false,
    },
    // §C: one skill per invocable workflow, `skills[].id` = the identifier the
    // host routes on. See `a2aInvocableWorkflowId` for why there is exactly one.
    skills: [
      {
        id: a2aInvocableWorkflowId(),
        name: a2aInvocableWorkflowId(),
        description: 'Starts an OpenWOP workflow run; the A2A Task id IS the run id (RFC 0100).',
        tags: ['workflow'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
}

