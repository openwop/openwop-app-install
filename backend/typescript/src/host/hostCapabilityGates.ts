/**
 * Executor host-capability gates (ADR 0820 G3 / G14).
 *
 * `ctx.features.<id>` has been feature-gated since ADR 0014 (`featureSurfaces.gate`,
 * `resolveOne` since ADR 0819). The executor also injects host capabilities that
 * sit OUTSIDE `ctx.features` — `ctx.ads`, `ctx.callVideoGenerator`, `ctx.canvas` —
 * and those were given to every run in every tenant, so a tenant without the
 * feature (toggle off, or a plan that does not include it) could reach the paid
 * capability by authoring a workflow around the node that uses it.
 *
 * This module wraps those capabilities with the owning feature's access check,
 * resolved PER CALL against the run's tenant and acting user (the subject
 * `featureSurfaces.gate` uses), and refuses with the same typed
 * `host_capability_disabled` error. It also carries the declared policy for
 * every key the executor puts on `ctx` (`EXECUTOR_CTX_POLICY`), which
 * `test/executor-capability-gate-ratchet.test.ts` holds against the executor
 * source, so a new ungated capability fails CI instead of shipping silently.
 */
import { resolveOne } from './featureToggles/service.js';
import type { AdsAdapter } from './adsAdapter.js';
import type { VideoGenerationRequest, VideoGenerationResult } from '../executor/types.js';

/** The run-level subject a capability gate resolves against. */
export interface CapabilityGateScope {
  tenantId: string;
  actingUserId?: string;
}

function refusal(capability: string, featureIds: readonly string[], blockedBy: string): Error {
  return Object.assign(
    new Error(`${capability} is unavailable: ${featureIds.length === 1 ? `feature '${featureIds[0]}' is` : `none of the features ${featureIds.map((f) => `'${f}'`).join(', ')} is`} enabled for this tenant`),
    { code: 'host_capability_disabled', capability, feature: featureIds[0], features: [...featureIds], blockedBy },
  );
}

/**
 * Pass when ANY of `featureIds` resolves enabled through `resolveOne`; otherwise
 * throw `host_capability_disabled`. Fail-closed: an unknown toggle resolves null
 * and counts as a refusal.
 */
export async function requireCapabilityFeature(scope: CapabilityGateScope, capability: string, featureIds: readonly string[]): Promise<void> {
  const subject = { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) };
  let blockedBy = 'toggle';
  for (const id of featureIds) {
    const a = await resolveOne(id, subject);
    if (a?.enabled) return;
    if (a?.blockedBy) blockedBy = a.blockedBy;
  }
  throw refusal(capability, featureIds, blockedBy);
}

/**
 * `ctx.ads` method → owning feature. A `Record` over `keyof AdsAdapter`, so a new
 * adapter method does not compile until somebody decides which feature owns it.
 *
 * - campaign-channels owns DISPATCH: `publishAd` (the `publish-ad-variants`
 *   node) and `updateBudget` (spend on a dispatched campaign).
 * - campaign-connectors owns the platform READ/SYNC side: the dispatch ledger,
 *   metrics, audience sync and conversion relay (its `ads-sync` /
 *   `audience-sync` nodes).
 *
 * Only the executor's `ctx.ads` is wrapped. The HTTP routes that build their own
 * adapter (`campaign-connectors/routes.ts`, `campaign-intel/routes.ts`) are
 * already behind their feature's route gate, and the public conversion relay is
 * the visitor lane (workstream F), not this one.
 */
export const ADS_METHOD_FEATURE: Record<keyof AdsAdapter, string> = {
  publishAd: 'campaign-channels',
  updateBudget: 'campaign-channels',
  listDispatches: 'campaign-connectors',
  getMetrics: 'campaign-connectors',
  syncAudience: 'campaign-connectors',
  sendConversion: 'campaign-connectors',
};

/** Wrap the executor's `ctx.ads` so each method checks its owning feature first. */
export function gateAdsAdapter(adapter: AdsAdapter, scope: CapabilityGateScope): AdsAdapter {
  const call = <K extends keyof AdsAdapter>(method: K): AdsAdapter[K] => {
    const fn = adapter[method] as unknown as (...args: unknown[]) => Promise<unknown>;
    const gated = async (...args: unknown[]): Promise<unknown> => {
      await requireCapabilityFeature(scope, `ctx.ads.${method}`, [ADS_METHOD_FEATURE[method]]);
      return fn.apply(adapter, args);
    };
    return gated as unknown as AdsAdapter[K];
  };
  return {
    publishAd: call('publishAd'),
    updateBudget: call('updateBudget'),
    listDispatches: call('listDispatches'),
    getMetrics: call('getMetrics'),
    syncAudience: call('syncAudience'),
    sendConversion: call('sendConversion'),
  };
}

/**
 * The feature(s) that own text-to-video for a given node type.
 *
 * Video generation is the creative-video product. creative-briefs ships its own
 * reel node (`feature.creative-briefs.nodes.generate-reel`, ADR 0411) that rides
 * the same seam, and that node is part of the creative-briefs feature, so it
 * resolves against creative-briefs. Every other node (`core.openwop.ai.video-generate`,
 * the default-mounted `vendor.myndhyve.ads-video-generate`, a pack's own) resolves
 * against creative-video, which is what makes the capability exclusive to it.
 */
export function videoGeneratorOwningFeatures(nodeTypeId: string): readonly string[] {
  return nodeTypeId.startsWith('feature.creative-briefs.nodes.') ? ['creative-briefs'] : ['creative-video'];
}

/** Wrap `ctx.callVideoGenerator` with its owning feature's access check. */
export function gateVideoGenerator(
  fn: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>,
  scope: CapabilityGateScope,
  nodeTypeId: string,
): (req: VideoGenerationRequest) => Promise<VideoGenerationResult> {
  const features = videoGeneratorOwningFeatures(nodeTypeId);
  return async (req) => {
    await requireCapabilityFeature(scope, 'ctx.callVideoGenerator', features);
    return fn(req);
  };
}

/**
 * G14 — the declared policy for every key the executor sets on a node `ctx`
 * (`const ctx: NodeContext = { … }` in `executor/executor.ts`, including keys
 * inside conditional spreads). The ratchet test parses that literal and asserts
 * the key SET equals this table, so adding a capability to `ctx` without
 * deciding how it is gated is a red test, not a silent paywall bypass.
 *
 * - `run-context`: data about the run, not a capability.
 * - `gated`: resolves a feature per call; `wrapper` names the function the
 *   executor must route the value through (the ratchet checks the source).
 * - `core`: a capability every tenant gets; the reason is the justification.
 */
export type CtxKeyPolicy =
  | { kind: 'run-context'; why: string }
  | { kind: 'gated'; features: readonly string[]; wrapper: string; why: string }
  | { kind: 'core'; why: string };

export const EXECUTOR_CTX_POLICY: Readonly<Record<string, CtxKeyPolicy>> = {
  // ── run context (data, not capabilities) ──
  signal: { kind: 'run-context', why: 'the run abort signal' },
  runId: { kind: 'run-context', why: 'identity' },
  nodeId: { kind: 'run-context', why: 'identity' },
  tenantId: { kind: 'run-context', why: 'identity' },
  scopeId: { kind: 'run-context', why: 'identity' },
  traceContext: { kind: 'run-context', why: 'RFC 0207 correlation only' },
  inputs: { kind: 'run-context', why: 'node inputs' },
  config: { kind: 'run-context', why: 'node config' },
  nodeAgent: { kind: 'run-context', why: 'authoring-time agent pin' },
  configurable: { kind: 'run-context', why: 'run configurable' },
  triggerData: { kind: 'run-context', why: 'trigger payload' },
  attempt: { kind: 'run-context', why: 'retry counter' },
  trustBoundary: { kind: 'run-context', why: 'RFC 0020 trust marker' },
  compaction: { kind: 'run-context', why: 'ADR 0099 frozen decision' },
  handoff: { kind: 'run-context', why: 'ADR 0829 handoff record the run was created with (untrusted, re-normalized)' },
  secrets: { kind: 'run-context', why: 'the run’s own secrets view' },
  userId: { kind: 'run-context', why: 'launch-studio principal (the tenant)' },
  actingUserId: { kind: 'run-context', why: 'ADR 0024 durable principal' },
  interactiveSession: { kind: 'run-context', why: 'ADR 0189 interactivity flag' },
  variables: { kind: 'run-context', why: 'the run variable bag' },
  // ── gated capabilities ──
  features: { kind: 'gated', features: ['<surface id>'], wrapper: 'surfaces.features', why: 'every ctx.features.<id> is wrapped by featureSurfaces.gate → resolveOne(<id>); surface ids are held to toggle ids by the surface ratchet' },
  canvas: { kind: 'gated', features: ['<canvas type owner>'], wrapper: 'surfaces.canvas', why: 'createCanvasSurface resolves each canvas type’s owning toggle (canvasTypeOwnership) through resolveOne on read/write/create' },
  ads: { kind: 'gated', features: ['campaign-channels', 'campaign-connectors'], wrapper: 'gateAdsAdapter', why: 'ADS_METHOD_FEATURE, per method' },
  callVideoGenerator: { kind: 'gated', features: ['creative-video', 'creative-briefs'], wrapper: 'gateVideoGenerator', why: 'videoGeneratorOwningFeatures, per node type' },
  // ── core capabilities ──
  emit: { kind: 'core', why: 'run event log' },
  callAI: { kind: 'core', why: 'BYOK/managed text AI is the platform; metered by ADR 0821, not a feature' },
  callAIWithTools: { kind: 'core', why: 'as callAI' },
  callSpeechSynthesizer: { kind: 'core', why: 'generic TTS seam, metered; podcasts gate their own surface' },
  callTranscriber: { kind: 'core', why: 'generic STT seam, metered' },
  callImageGenerator: { kind: 'core', why: 'generic image seam with a per-tenant daily budget (ADR 0115); no image product is sold separately' },
  callImageEditor: { kind: 'core', why: 'as callImageGenerator' },
  callImageUpscaler: { kind: 'core', why: 'as callImageGenerator' },
  runSandboxedCode: { kind: 'core', why: 'operator-configured sandbox with its own exec budget (ADR 0114)' },
  interrupt: { kind: 'core', why: 'normative interrupt primitive' },
  suspend: { kind: 'core', why: 'alias of interrupt' },
  storage: { kind: 'core', why: 'run-scoped host storage' },
  db: { kind: 'core', why: 'run-scoped host db' },
  fs: { kind: 'core', why: 'run-scoped host fs' },
  queueBus: { kind: 'core', why: 'host queue' },
  observability: { kind: 'core', why: 'telemetry' },
  a2a: { kind: 'core', why: 'RFC A2A transport' },
  kanban: { kind: 'core', why: 'ADR 0311 stack work-intake is core (CLAUDE.md: workflows are chains or stacks)' },
  knowledge: { kind: 'core', why: 'core always-on KB (kb has no paid toggle); lapse de-index is workstream F' },
  chat: { kind: 'core', why: 'the ONE chat is core' },
  webResearch: { kind: 'core', why: 'generic egress-mediated research seam' },
  launchStudio: { kind: 'core', why: 'launch-studio sample surface; no sellable toggle exists' },
  http: { kind: 'core', why: 'SSRF-guarded safeFetch; credentials only for opted-in Connections' },
  slack: { kind: 'core', why: 'Connections-brokered egress, per acting user' },
  email: { kind: 'core', why: 'Connections-brokered egress, per acting user' },
  messaging: { kind: 'core', why: 'Connections-brokered egress, per acting user' },
  notification: { kind: 'core', why: 'in-app notifications are core' },
  connectors: { kind: 'core', why: 'Connections-brokered connector invoker, fails closed without a connection' },
  mcp: { kind: 'core', why: 'RFC 0020 MCP client, Connections-brokered' },
  respondToWebhook: { kind: 'core', why: 'records the webhook reply event' },
};
