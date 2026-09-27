/**
 * ADR 0331 §D4-B — the engine moved to `lib/formEngine.ts` (the neutral home);
 * this shim preserves every existing import site verbatim.
 */
export * from '../lib/formEngine.js';
