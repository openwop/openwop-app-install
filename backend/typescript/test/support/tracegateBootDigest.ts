/**
 * ADR 0968 P2 — the boot-outcome digest, for Tracegate's SHADOW measurement only.
 *
 * The recorder (scripts/lib/tracegate-recorder.mjs) calls `bootDigest(app, mod)`
 * inside createApp's 'end' mark, so the registries are read as boot left them,
 * before the test body runs; only when OPENWOP_TRACEGATE_RECORD is set. The
 * registries are looked up among the modules already evaluated, never imported
 * (an import at the mark cannot finish in time without making createApp wait:
 * MEASURED 2026-10-23, a preload started at the 'start' mark was not ready at
 * 'end' in 60 of 67 booting files). The recorder leaves this module out of
 * footprints. Nothing selects or skips a test on it yet: the
 * shadow log asks "had boot produced the same state, would this file have been
 * skippable?", and the data goes back to the user before any rule uses it.
 *
 * WHAT IT COVERS. The Express route table in order (path, methods, and every
 * handler by SOURCE hash), and every boot registry with an exported list
 * accessor (the 2026-10-23 survey in ADR 0968): agent tools, node types, agents,
 * chains, chain-backed and registered workflows, toggles and feature
 * dependencies, public paths, feature surfaces, artifact types, host surfaces,
 * v2 extension keys, prompt templates, connection providers, form templates,
 * subject erasers and key resolvers, data exporters, kv age-outs, upgrade handlers.
 *
 * WHAT IT CANNOT SEE (ADR 0968 open question): registries with no list accessor —
 * retention purgers, run-terminal listeners, run-start contributors, exception
 * sources, submission sinks, inbound webhook observers/gates, the approval
 * eligibility checks, canvas kits, hook arrays in hostExtPersistence and
 * accessControlService — and `setX()` singletons. A boot-wiring change that only
 * alters one of those reads here as "unchanged", which is exactly the kind of
 * miss the shadow's would-skip-but-failed column and the P2 soundness probe exist
 * to expose.
 *
 * Stable across worktrees: the repo root is replaced by a token, and fields known
 * to vary by clock or machine (agent `registeredAt`, chain `sourceRoot`) are dropped.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Express } from 'express';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const VOLATILE = new Set(['registeredAt', 'sourceRoot']);
const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Deterministic JSON: sorted keys, functions by source hash, cycles cut. */
function canon(v: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof v === 'function') return `fn:${sha(Function.prototype.toString.call(v))}`;
  if (typeof v === 'string') return v.split(ROOT).join('<root>');
  if (v === null || typeof v !== 'object') return v;
  if (depth > 12) return '<deep>';
  if (seen.has(v)) return '<cycle>';
  seen.add(v);
  if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
  if (v instanceof Map) return ['<map>', ...[...v].map(([k, x]) => [canon(k, seen, depth + 1), canon(x, seen, depth + 1)]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))];
  if (v instanceof Set) return ['<set>', ...[...v].map((x) => canon(x, seen, depth + 1)).map((x) => JSON.stringify(x)).sort()];
  if (Array.isArray(v)) return v.map((x) => canon(x, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) out[k] = canon((v as Record<string, unknown>)[k], seen, depth + 1);
  return out;
}

interface Layer {
  name?: string;
  regexp?: RegExp;
  handle?: ((...a: unknown[]) => unknown) & { stack?: Layer[] };
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
}
/** The route table in ORDER (order is semantic: middleware before routes). */
function routes(stack: Layer[] | undefined): unknown[] {
  return (stack ?? []).map((l) => (l.route
    ? { path: canon(l.route.path), methods: Object.keys(l.route.methods).sort(), handlers: l.route.stack.map((s) => canon(s.handle)) }
    : { use: l.name, re: l.regexp ? `${l.regexp.source}` : null, handle: canon(l.handle), ...(l.handle?.stack ? { sub: routes(l.handle.stack) } : {}) }));
}

/** Resolves a src module (path under src/, no extension) to the exports the
 *  test file already evaluated; throws when it is not loaded. */
export type ModuleLookup = (rel: string) => unknown;

/** One digest of what `createApp` left behind. Each part is hashed separately so a
 *  later probe can say WHICH registry changed; the digest is the hash of the parts.
 *  SYNCHRONOUS on purpose: the recorder discards the coverage window this call
 *  runs in, and no other code can run inside a synchronous call, so exactly the
 *  digest's own work is discarded and the footprint is what it would have been
 *  without it (ADR 0968 P2: shadow data must not change what a gate selects).
 *  It imports no src module: every registry comes from `mod`, i.e. from the
 *  modules this test file's boot already evaluated, so it loads nothing. */
export function bootDigest(app: Express, mod: ModuleLookup): string {
  const parts: Record<string, unknown> = {};
  const part = (name: string, read: () => unknown): void => {
    try { parts[name] = sha(JSON.stringify(canon(read()))); } catch (e) { parts[name] = `error:${(e as Error).message}`; }
  };
  // `call(o, 'f', …)` calls method f of o (a module's exports or a registry object).
  const call = (o: unknown, fn: string, ...a: unknown[]): unknown => {
    const f = (o as Record<string, unknown> | undefined)?.[fn];
    if (typeof f !== 'function') throw new Error(`no ${fn}()`);
    return (f as (...x: unknown[]) => unknown).apply(o, a);
  };
  const fx = (rel: string, fn: string): unknown => call(mod(rel), fn);
  const ids = (v: unknown): string[] => v as string[];
  part('routes', () => routes((app as unknown as { _router?: { stack: Layer[] } })._router?.stack));
  part('agentTools', () => { const t = mod('host/agentToolProvider'); return ids(call(t, 'builtinAgentToolIds')).map((id) => [id, call(t, 'builtinAgentTool', id)]); });
  part('safeModeApprovals', () => fx('host/agentToolProvider', 'declaredSafeModeApprovals'));
  part('nodeTypes', () => { const r = fx('executor/nodeRegistry', 'getNodeRegistry'); return ids(call(r, 'listTypeIds')).map((id) => [id, call(r, 'get', id)]); });
  part('agents', () => { const r = fx('executor/agentRegistry', 'getAgentRegistry'); return [call(r, 'list'), call(r, 'listRefused')]; });
  part('chains', () => fx('host/workflowChainPackLoader', 'listChains'));
  part('chainLoadStatus', () => fx('host/chainPackLoadStatus', 'chainPackLoadStatus'));
  part('chainBackedWorkflows', () => fx('host/chainBackedWorkflows', 'listChainBackedWorkflows'));
  part('registeredWorkflows', () => fx('host/workflowsRegistry', 'listRegisteredWorkflows'));
  part('toggles', () => ['listToggleDefaults', 'enforcedFeatureDependencies', 'listRegisteredFeatureIds'].map((f) => fx('host/featureToggles/registry', f)));
  part('publicPaths', () => fx('middleware/auth', 'featurePublicPaths'));
  part('featureSurfaces', () => fx('host/featureSurfaces', 'registeredFeatureSurfaceIds'));
  part('artifactTypes', () => fx('host/artifactTypes', 'listArtifactTypes'));
  part('hostSurfaces', () => fx('bootstrap/hostSurfaceRegistry', 'listHostSurfaces'));
  part('v2Extensions', () => fx('host/discoveryExtensions', 'listV2ExtensionKeys'));
  part('promptTemplates', () => fx('host/promptStore', 'listTemplates'));
  part('connectionProviders', () => ['listProviders', 'providerRefusals'].map((f) => fx('features/connections/providerRegistry', f)));
  part('formTemplates', () => fx('host/formContentPackLoader', 'listFormTemplateEntries'));
  part('subjectErasers', () => ['registeredSubjectEraserIds', 'registeredSubjectKeyResolverNames'].map((f) => fx('host/subjectErasure', f)));
  part('dataExporters', () => fx('host/featureDataExport', 'exportableFeatureIds'));
  part('kvAgeOut', () => fx('host/kvAgeOut', '__listKvAgeOutForTest'));
  part('upgradeHandlers', () => fx('host/upgradeRegistry', '__listUpgradeHandlersForTest'));
  return `v1:${sha(JSON.stringify(parts))}:${JSON.stringify(parts)}`;
}
