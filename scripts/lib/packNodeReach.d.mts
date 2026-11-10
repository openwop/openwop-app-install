/**
 * Types for `packNodeReach.mjs` (ADR 0572 P3; ADR 1048 adds the cross-module
 * walk), for backend tests that import it under `tsc --noEmit`.
 */
export interface ImplInfo { pack: string; src: string; fn: string; file?: string; packDir?: string }
export type NodeReach =
  | { kind: 'unresolved'; why: string }
  | { kind: 'invocation-log' }
  | { kind: 'ai-opaque'; caps: string[] }
  | { kind: 'no-ai-reach' };
export const OPAQUE_HOST_AI_CAPABILITIES: readonly string[];
export const NOT_INVOCATION_LOGGED_AI: readonly string[];
export const DEFERRED_SEMANTICS_ROLES: readonly string[];
export function buildImplIndex(root: string): Map<string, ImplInfo>;
export function bodyOf(src: string, name: string, depth?: number): string | null;
export function resolveImportedBinding(file: string | null, src: string, name: string, packDir: string | null): { file: string; src: string; name: string } | null;
export function reachableText(src: string, rootFn: string, maxDepth?: number, at?: { file: string | null; packDir: string } | null): { text: string; resolvable: boolean };
export function classifyNodeReach(typeId: string, impl: Map<string, ImplInfo>): NodeReach;
