// Ambient types for the untyped feature node packs (plain `.mjs`, no `.d.ts`
// shipped) so the node-smoke tests can import them under `tsc --noEmit` with a
// literal specifier (which vitest resolves statically) and WITHOUT a suppression.
declare module '*feature.csm.nodes/index.mjs' {
  export const nodes: Record<
    string,
    (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>
  >;
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
}
declare module '*feature.campaign-brief.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-channels.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-orchestration.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-connectors.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
declare module '*feature.campaign-intel.nodes/index.mjs' {
  export const nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }>>;
}
