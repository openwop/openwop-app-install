/// <reference types="vite/client" />

// Typed `import.meta.env` keys used by this app. Vite's own `ImportMetaEnv`
// (from `vite/client`) keeps its `[key: string]: any` index signature via
// declaration merging, so existing `import.meta.env.VITE_*` reads are unaffected;
// this just gives the ADR 0118 Phase 6 browser-OTel endpoint a precise type.
interface ImportMetaEnv {
  /** OTLP HTTP endpoint for browser-side OpenTelemetry (ADR 0118 Phase 6). When
   *  set at BUILD time, the SPA lazily bootstraps `sdk-trace-web`; unset ⇒ off. */
  readonly VITE_OTEL_EXPORTER_OTLP_ENDPOINT?: string;
}
