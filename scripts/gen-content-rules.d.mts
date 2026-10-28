// Types for gen-content-rules.mjs (ADR 0946 P1). The implementation stays plain
// ESM JavaScript run directly by node; this declaration keeps the vitest import
// typed (an untyped .mjs import resolves to `any`, which is banned here).

/** Repo-relative path of each generated pack copy → its expected content. */
export declare function expectedOutputs(): Record<string, string>;
