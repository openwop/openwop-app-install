/** Types for scripts/featureGateDeclarations.mjs (ADR 1031 P2). */
export declare function featureGateDeclarations(src: string): Array<{ srcRel: string; decl: Record<string, unknown> }>;
/** The `[file, ...rest]` rows features declare under `gate.key`, `file` made `src/`-relative. */
export declare function declaredRows(src: string, gate: string, key: string): unknown[][];
