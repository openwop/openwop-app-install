// Ambient types for the untyped feature node packs (plain `.mjs`, no `.d.ts`
// shipped) so the node-smoke tests can import them under `tsc --noEmit` with a
// literal specifier (which vitest resolves statically) and WITHOUT a suppression.
declare module '*feature.csm.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
// PROBE-DOC-2 (WF-DOC-1) — the fork-idempotency witness imports the real handler.
declare module '*feature.documents.nodes/index.mjs' {
  export function generateFromTemplate(ctx: unknown): Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>;
}
// ADR 0411 P3 — the generate-reel node smoke test imports the real handler.
declare module '*feature.creative-briefs.nodes/index.mjs' {
  export function generateReel(ctx: unknown): Promise<{ status: string; outputs?: Record<string, unknown> }>;
}
declare module '*vendor.myndhyve.ads-image-generate/index.mjs' {
  export function adsImageGenerate(ctx: unknown): Promise<{ status: string; outputs?: Record<string, unknown> }>;
}
// UX_UPGRADE-cad R2 (CAD2-B1) — the render node's normalizer silently dropped
// three editable solid fields; this is the declaration its regression test uses.
declare module '*feature.cad.nodes/index.mjs' {
  export function render(ctx: unknown): Promise<{
    status: string;
    outputs: { solidCount: number; artifact: { artifactTypeId: string; payload: { solids: unknown[] } } };
  }>;
}
declare module '*feature.forms.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.consent.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.analytics.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.assistant.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.email.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.comments.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.marketplace.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.priority-matrix.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.insights-suite.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>
  >;
}
declare module '*feature.strategy.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>
  >;
}
declare module '*feature.interactive-artifacts.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.brand.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
  // ADR 0891 D5 — pinned to the host's wrapForLLMPrompt by the brand promptCatalogParity test.
  export function fenceContent(text: string): string;
}
declare module '*feature.campaign-brief.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
  // XCH-CB-3 (round 2) — the bounded-repair regression executes the node directly.
  export function generateKernel(ctx: unknown): Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>;
}
declare module '*feature.campaign-channels.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
  // QA-CODE-5 — exported for the table↔schema parity test.
  export const CHANNEL_SPEC: Record<string, { system: string; schema: Record<string, unknown>; itemsKey: string | null }>;
}
declare module '*feature.campaign-orchestration.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-ops.nodes/index.mjs' {
  export function fenceContent(text: string): string;
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-connectors.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.webinars.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.creative-video.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-journeys.nodes/index.mjs' {
  type Ctx = Record<string, unknown>;
  type Out = { status: string; outputs?: Record<string, unknown>; error?: { code?: string; message?: string } };
  export function enroll(ctx: Ctx): Promise<Out>;
  export function eligibility(ctx: Ctx): Promise<Out>;
  // ADR 0955 P0 — the one per-channel check.
  export function channelEligibility(ctx: Ctx): Promise<Out>;
  // ADR 0955 P2 — the send window timer and the journey SMS send.
  export function nextSendWindow(ctx: Ctx): Promise<Out>;
  export function sendSms(ctx: Ctx): Promise<Out>;
  export function sendTime(ctx: Ctx): Promise<Out>;
  export function smsSegments(text: string): number;
  export function engagement(ctx: Ctx): Promise<Out>;
  export function frequencyGate(ctx: Ctx): Promise<Out>;
  export function segmentMembers(ctx: Ctx): Promise<Out>;
  export function segmentWinbackPlan(ctx: Ctx): Promise<Out>;
  // w38 — the CDP-E holdout split node (cdp-journey-split-node.test.ts imports it unsuppressed).
  export function split(ctx: Ctx): Promise<Out>;
  export const nodes: Record<string, (ctx: Ctx) => Promise<Out>>;
}
declare module '*feature.campaign-intel.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.destination-sync.nodes/index.mjs' {
  type Ctx = Record<string, unknown>;
  type Out = { status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } };
  export function prepare(ctx: Ctx): Promise<Out>;
  export function prepareOnward(ctx: Ctx): Promise<Out>;
  export const nodes: Record<string, (ctx: Ctx) => Promise<Out>>;
}
declare module '*vendor.myndhyve.market-intel-shift-detect/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
}
declare module '*feature.recommendations.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;
}
declare module '*feature.promotions.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;
}
declare module '*feature.discovery.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;
}
declare module '*feature.funnels.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>
  >;
}
// ADR 0596 (`WFAWF-11`) — the AI Workflow Author's node pack was executed by NO
// test in the repo, which is how the success-with-empty `draft` (`WFAC-2`)
// shipped. `test/workflow-author-node-pack.test.ts` drives the real handlers.
declare module '*feature.workflow-author.nodes/index.mjs' {
  type WfaResult = {
    status: 'success' | 'failed';
    outputs?: Record<string, unknown>;
    error?: { code?: string; message?: string; details?: unknown };
  };
  export function draft(ctx: unknown): Promise<WfaResult>;
  export function validate(ctx: unknown): Promise<WfaResult>;
  export function persist(ctx: unknown): Promise<WfaResult>;
  export function get(ctx: unknown): Promise<WfaResult>;
  export const nodes: Record<string, (ctx: unknown) => Promise<WfaResult>>;
}
// ADR 0603 (`DEBT-POD-1`) — nothing in the repo imported the podcasts generation
// pipeline, which is how the DESTRUCTIVE `mix` write (`PODC-1`) and the six
// success-with-empty returns (`PODC-2`) shipped unseen.
// `test/podcasts-generation-pipeline.test.ts` drives the real handlers.
declare module '*feature.podcasts.nodes/index.mjs' {
  type PodResult<O> = {
    status: 'success' | 'failed';
    outputs?: O;
    error?: { code?: string; message?: string; details?: unknown };
  };
  export function selectContent(ctx: unknown): Promise<PodResult<{ context: string }>>;
  export function outline(ctx: unknown): Promise<PodResult<{ outline: string }>>;
  export function transcript(ctx: unknown): Promise<PodResult<{ turns: Array<{ speaker: string; text: string }> }>>;
  export function synthesize(ctx: unknown): Promise<PodResult<{ clips: Array<Record<string, unknown>> }>>;
  export function mix(ctx: unknown): Promise<PodResult<{ clipCount: number; audioMediaRef: string }>>;
  export const nodes: Record<string, (ctx: unknown) => Promise<PodResult<Record<string, unknown>>>>;
}
// ADR 0114 — the code-exec node's honest-off / HITL-gate tests import the real handler.
declare module '*feature.code-exec.nodes/index.mjs' {
  export function run(ctx: unknown): Promise<{ status: string; outputs: { exitCode: number; stdout: string; stderr: string; declined?: boolean; artifact: { artifactTypeId: string; contentTrust: string; payload: { stdout: string } } } }>;
}
// ADR 0269 / CDP-G — the zero-dep collection SDK (plain ESM) under test in cdp-collect-sdk.test.ts.
declare module '*sdk/cdpCollectSdk.mjs' { type R = { status: number; ok: boolean; body: unknown }; export function createCdpClient(opts?: { baseUrl?: string; token?: string; fetchImpl?: (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> }): { collect(eventType: string, payload: Record<string, unknown>): Promise<R>; collectBatch(events: { eventType: string; payload: Record<string, unknown> }[]): Promise<R>; resolveIdentity(type: string, value: string): Promise<unknown>; registerSchema(eventType: string, schema: Record<string, unknown>): Promise<R> }; }
// ADR 0889 WF-EV-11 — the agent-eval run-suite node, under test in adr0889-evals-run-suite-node.test.ts.
declare module '*feature.evals.nodes/index.mjs' {
  type Out = { status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } };
  export function runSuite(ctx: unknown): Promise<Out>;
  export const nodes: Record<string, (ctx: unknown) => Promise<Out>>;
}
declare module '*feature.computer-use.nodes/index.mjs' {
  // ADR 0894 CU2CD-1 — the decide node is driven directly by the session-authority test.
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}

/** ADR 0954: pure deadline exports at the untyped CRM pack boundary. */
declare module '*feature.crm.nodes/index.mjs' {
  export function addBusinessMinutes(start: number, minutes: number, timezone?: string, weeklyHours?: Array<{ day: number; start: string; end: string }>): number;
  export function slaDeadline(context: { inputs: { sla: { firstTouchMinutes: number; assignedAt: string } | null } }): Promise<{ outputs: { hasSla: boolean; slaDeadline?: string; slaEscalateAt?: string; slaReportAt?: string } }>;
}
