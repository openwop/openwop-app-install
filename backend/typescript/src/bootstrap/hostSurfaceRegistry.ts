/**
 * Process-wide registry of advertised host surfaces.
 *
 * Each surface name is a stable string used by:
 *   - the catalog response (`requiresHostSurfaces` per node), so the
 *     UI can tell whether a node will execute on this host;
 *   - the well-known advertisement (`capabilities.hostSurfaces`), so
 *     external introspection clients can see the same info.
 *
 * The registry starts empty. Bootstrap code registers each surface as
 * it wires the underlying implementation. Surfaces NOT registered are
 * advertised as `{ supported: false }`. This mirrors the existing
 * `aiProviders` block, which has been hand-rolled in discovery.ts;
 * future cleanup could fold aiProviders into this registry too.
 *
 * Spec references:
 *   - host.kvStorage / host.tableStorage / host.cache / host.blobStorage
 *     / host.queue per RFCs 0015–0019.
 *   - host.fs per RFC 0014.
 *   - host.db.{sql,nosql,search,vector} per RFC 0018.
 *   - host.messaging, host.observability, host.mcp — not yet RFC'd;
 *     surface names match the typeId-prefix → surface table in
 *     hostSurfaceMap.ts.
 */

import { createLogger } from '../observability/logger.js';
import { registerV2Extension } from '../host/discoveryExtensions.js';

const log = createLogger('bootstrap.hostSurfaceRegistry');

export type HostSurfaceName =
  | 'host.kvStorage'
  | 'host.tableStorage'
  | 'host.cache'
  | 'host.blobStorage'
  | 'host.queue'
  | 'host.fs'
  | 'host.db.sql'
  | 'host.db.nosql'
  | 'host.db.search'
  | 'host.db.vector'
  | 'host.messaging'
  | 'host.observability'
  | 'host.memory'
  | 'host.mcp'
  | 'host.aiProviders'
  | 'host.interrupts'
  | 'host.triggers'
  | 'host.a2a'
  | 'host.kanban'
  | 'host.knowledge'
  | 'host.chat'
  | 'host.canvas'
  | 'host.webResearch'
  | 'host.launchStudio'
  | 'host.connectors'
  | 'host.artifactTypes';

export interface HostSurfaceAdvertisement {
  /** Stable surface name. */
  name: HostSurfaceName;
  /** Whether this host actually implements the surface. */
  supported: boolean;
  /** Free-form one-liner the UI can render under the surface name. */
  note?: string;
  /** Backing implementation tag: `'in-memory'`, `'sqlite'`, `'postgres'`, etc.
   *  Used by the UI to show "in-memory demo" badges. Absent when not supported. */
  implementation?: string;
}

const registry = new Map<HostSurfaceName, HostSurfaceAdvertisement>();

export function registerHostSurface(ad: HostSurfaceAdvertisement): void {
  if (registry.has(ad.name)) {
    log.warn('host surface already registered; overwriting', { name: ad.name });
  }
  registry.set(ad.name, ad);
  log.info('host surface registered', {
    name: ad.name,
    supported: ad.supported,
    implementation: ad.implementation,
  });
}

/**
 * Idempotent seed for surfaces that this sample knows about but doesn't
 * yet implement. Lets the UI render the full surface list with
 * `supported=false` so users can see what's *possible* vs. what's
 * *wired*. Called once at boot — re-calls are no-ops because
 * registerHostSurface only overwrites with a warning.
 */
export function seedDefaultHostSurfaces(): void {
  const defaults: HostSurfaceAdvertisement[] = [
    { name: 'host.kvStorage', supported: false, note: 'RFC 0015. Wire in Phase 3 with an in-memory adapter.' },
    { name: 'host.tableStorage', supported: false, note: 'RFC 0016.' },
    { name: 'host.cache', supported: false, note: 'RFC 0019 §cache.' },
    { name: 'host.blobStorage', supported: false, note: 'RFC 0019 §blob.' },
    { name: 'host.queue', supported: false, note: 'RFC 0017.' },
    { name: 'host.fs', supported: true, implementation: 'workflow-engine', note: 'RFC 0014 (Active). In-memory sandboxed filesystem from host/inMemorySurfaces.ts; sandboxRoot under {dataDir}/fs.' },
    { name: 'host.db.sql', supported: false, note: 'RFC 0018 §SQL.' },
    { name: 'host.db.nosql', supported: false, note: 'RFC 0018 §NoSQL.' },
    { name: 'host.db.search', supported: false, note: 'RFC 0018 §search.' },
    { name: 'host.db.vector', supported: false, note: 'RFC 0018 §vector.' },
    { name: 'host.messaging', supported: false },
    { name: 'host.observability', supported: false, note: 'Wired implicitly via emit() — surface flag not yet honored.' },
    { name: 'host.mcp', supported: process.env.OPENWOP_MCP_SERVER_ENABLED === 'true', implementation: 'workflow-engine', note: 'RFC 0020 (Active). Sample-host MCP server mount at /v1/host/openwop-app/mcp; advertise streamable-http transport. OFF by default — set OPENWOP_MCP_SERVER_ENABLED=true.' },
    { name: 'host.triggers', supported: true, implementation: 'workflow-engine', note: 'Trigger entry nodes (webhook/schedule/cron/email/mailhook/rss/form) surface the run-scoped ctx.triggerData payload; runs are started by the RFC 0083 trigger bridge, scheduler, and kanban paths. webhook-respond durably records the reply via ctx.respondToWebhook.' },
    { name: 'host.webResearch', supported: true, implementation: 'workflow-engine', note: 'For vendor.myndhyve.web-research. fetchBatch is real (concurrent HTTP fetch + readable-text extraction); search is provider-gated — live when a BYOK secret web-search or OPENWOP_WEBSEARCH_API_KEY is set (Brave-shaped, OPENWOP_WEBSEARCH_BASE_URL override), else an honest demo result; research composes the two.' },
    { name: 'host.launchStudio', supported: true, implementation: 'workflow-engine', note: 'Multi-canvas studio backbone for vendor.myndhyve.launch-studio. getStudio returns a seeded demo studio; buildProjectContext/resolveLinkedArtifacts are pure derivations; task dispatch composes ctx.kanban.' },
    { name: 'host.canvas', supported: true, implementation: 'workflow-engine', note: 'Durable versioned shared-canvas store for vendor.myndhyve.canvas. read/write/create are real (optimistic-concurrency, shallow/deep/replace merge, field projection); crossCanvasInvoke spawns a real child run (depth/cycle guard, awaitTerminal, circuit breaker).' },
    { name: 'host.chat', supported: true, implementation: 'workflow-engine', note: 'Bridges vendor.myndhyve.chat to the demo chat store (the same /v1/host/openwop-app/chat tables the SPA reads). sendMessage/progressCard/updateCard run; the suspend-based gate nodes (phaseInputGate/approvalGate/clarificationGate) run via the ctx.suspend/ctx.interrupt primitive (re-invoke resume, interrupt.md).' },
    { name: 'host.knowledge', supported: true, implementation: 'workflow-engine', note: 'Lexical RAG retrieval (token-frequency over a seeded demo corpus) for vendor.myndhyve.knowledge-tools. Real retrieve-with-citations; lexical not semantic (sample host ships no embedding model).' },
    { name: 'host.kanban', supported: true, implementation: 'workflow-engine', note: 'Bridges vendor.myndhyve.kanban to the durable core work-item store (kanbanService.ts) — boards/cards are reusable across canvases. boardReview/timelinePlan/resourceMonitor are genuinely computed; automation rejects until a durable workflow-binding implementation is configured.' },
    // A7 — the A2A advertisement flips honestly with the live server endpoint
    // (OPENWOP_A2A_SERVER_ENABLED). The CLIENT is always live; only the
    // server-as-agent posture changes: with the env set, POST /v1/host/openwop-app/a2a
    // answers agent/getCard + message/send for real (handleA2aRequest), so the
    // demo-stub caveat is dropped.
    process.env.OPENWOP_A2A_SERVER_ENABLED === 'true'
      ? {
          name: 'host.a2a',
          supported: true,
          implementation: 'workflow-engine',
          note:
            process.env.OPENWOP_A2A_DURABLE_TASKS === 'true'
              ? // ADR 0035 / RFC 0100 — durable Tasks wired: message/send persists an
                // A2ATaskState, tasks/get returns it after disconnect, tasks/resubscribe
                // re-attaches, push-config fires (SSRF-guarded) on terminal/blocking
                // transitions. The a2a capability slot advertises durableTasks/push;
                // `streaming` is decoupled onto OPENWOP_A2A_STREAMING (default off →
                // advertised false) — no conformance 1.34.0 resubscribe witness; the
                // JSON-RPC server still serves resubscribe, it's just unadvertised.
                'RFC 0076 §A + RFC 0100. A2A 0.3 JSON-RPC client AND a live server endpoint at POST /v1/host/openwop-app/a2a with DURABLE Tasks — message/send persists the projected A2ATaskState, tasks/get returns live state after disconnect, tasks/resubscribe re-attaches the update stream, and tasks/pushNotificationConfig/set registers an SSRF-guarded push (ADR 0035).'
              : 'RFC 0076 §A. A2A 0.3 JSON-RPC client (discover/send/stream/tasks/pushConfig) AND a live server endpoint at POST /v1/host/openwop-app/a2a — agent/getCard + message/send route to a real manifest-agent dispatch (synchronous core; set OPENWOP_A2A_DURABLE_TASKS=true for durable Tasks per RFC 0100 / ADR 0035).',
        }
      : { name: 'host.a2a', supported: true, implementation: 'workflow-engine', note: 'RFC 0076 §A. A2A 0.3 JSON-RPC client from host/a2aSurface.ts — discover/send/stream/tasks/pushConfig against any peer A2A agent; wire state-form normalized to the pack vocabulary. Server-as-agent methods (publishAgentCard/emit*/pushSend) are demo stubs (set OPENWOP_A2A_SERVER_ENABLED=true for a live server endpoint).' },
    // These two are already advertised honestly elsewhere — pre-seed
    // them as supported so the UI doesn't show contradictory data.
    { name: 'host.aiProviders', supported: true, implementation: 'workflow-engine', note: 'BYOK via /v1/host/openwop-app/byok/secrets.' },
    { name: 'host.interrupts', supported: true, implementation: 'workflow-engine' },
    // ADR 0037 — the generic connector invoker. WIRED (delegates to the
    // Connections broker + brokered egress); per-provider reach is still
    // DEPLOY-GATED behind a configured Connection (an unconfigured connector
    // fails closed with connector_no_connection). A connector can only reach the
    // provider's curated apiHosts.
    { name: 'host.connectors', supported: true, implementation: 'workflow-engine', note: 'ADR 0037. connectorInvoker.invoke(providerId, {context,request}) resolves the acting user’s Connection through the broker + brokered egress (RFC 0093 SSRF + apiHosts pin + connections:use gate + RFC 0079 provenance). Per-provider reach is deploy-gated behind a configured Connection — unconfigured fails closed.' },
    { name: 'host.artifactTypes', supported: true, implementation: 'workflow-engine', note: 'ADR 0055 (RFC 0071/0075). Host artifact-type registry — host-native doc.* types with JSON-Schema validation, schemas served at /schemas/artifacts/{id}.schema.json, typed artifact.created emission from feature.documents.nodes. The kind:artifact-type pack tier IS implemented (artifactTypePackLoader registers pack types at boot; RFC 0071 schemaRef + inline schema both accepted).' },
  ];
  for (const ad of defaults) {
    if (!registry.has(ad.name)) {
      registry.set(ad.name, ad);
    }
  }
}

export function listHostSurfaces(): HostSurfaceAdvertisement[] {
  return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getHostSurface(name: HostSurfaceName): HostSurfaceAdvertisement | undefined {
  return registry.get(name);
}

/**
 * ADR 0730 C.2 — the v2 home for this advertisement.
 *
 * `capabilities.hostSurfaces` is THIS HOST's own advertisement, not a corpus
 * field: it appears ZERO times in `spec/v1/capabilities.md`, and the v2 root is
 * `additionalProperties: false` over 89 declared keys, none of them this one.
 * `spec/v2/core/capabilities.md` §4 deleted the keys that were "advisory
 * self-declarations the wire cannot falsify" — which is exactly what an
 * `implementation: 'in-memory'` tag is — so the extensions hatch is not a
 * loophole here, it is the honest address.
 *
 * Registered through the existing `registerV2Extension` seam (built, tested,
 * wired into the v2 root at `routes/discovery.ts`, and until now carrying no
 * records at all). A FUNCTION, not a snapshot: the registry is populated by
 * Phase-3 adapters during boot, so a value captured at registration time would
 * advertise an empty host.
 */
export function registerHostSurfacesV2Extension(): void {
  registerV2Extension('openwop-app.host-surfaces', () => ({
    surfaces: listHostSurfaces().map((s) => ({
      name: s.name,
      supported: s.supported,
      ...(s.note !== undefined ? { note: s.note } : {}),
      ...(s.implementation !== undefined ? { implementation: s.implementation } : {}),
    })),
  }));
}
