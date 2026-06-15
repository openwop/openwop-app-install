/**
 * Portability service (RFC 0098) — host-sample, best-effort.
 *
 * Invariants:
 *   - `export-bundle-no-credential-material` — export is refs-only; import
 *     REJECTS (before applying) any bundle whose item payload carries a literal
 *     credential value. Connection references travel as `[REDACTED:<id>]`-style
 *     refs, never plaintext.
 *   - import `?dryRun=true` makes ZERO writes (returns a plan only).
 *   - a `dependsOn` cycle is rejected before applying.
 */

import { EXPORT_KINDS, type ExportBundle, type ExportItem, type ImportPlan, type ImportResult } from './types.js';

/** Credential-bearing payload keys (case-insensitive) whose literal string value
 *  must NEVER travel in a bundle (refs only). */
const CREDENTIAL_KEYS = new Set(
  ['apikey', 'api_key', 'clientsecret', 'client_secret', 'password', 'passwd', 'secret', 'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'privatekey', 'private_key', 'bearer', 'authorization'].map((k) => k.toLowerCase()),
);

/** A redacted ref is allowed; a raw value is not. */
function isRedactedRef(v: unknown): boolean {
  return typeof v === 'string' && /^\[REDACTED:[^\]]+\]$/.test(v);
}

/** Recursively scan a payload for a literal credential value. Returns the
 *  offending key path, or null when clean. */
export function findLiteralCredential(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLiteralCredential(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (CREDENTIAL_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.length > 0 && !isRedactedRef(v)) {
        return here;
      }
      const hit = findLiteralCredential(v, here);
      if (hit) return hit;
    }
  }
  return null;
}

export class CredentialMaterialError extends Error {
  constructor(public readonly keyPath: string) {
    super(`Import bundle carries a literal credential value at \`${keyPath}\` — bundles are refs-only (export-bundle-no-credential-material).`);
  }
}

export class DependsOnCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Import bundle has a dependsOn cycle: ${cycle.join(' → ')}.`);
  }
}

export class MalformedBundleError extends Error {}

function assertWellFormed(bundle: unknown): asserts bundle is ExportBundle {
  if (!bundle || typeof bundle !== 'object') throw new MalformedBundleError('bundle MUST be an object');
  const b = bundle as Record<string, unknown>;
  if (b.bundleVersion !== '1') throw new MalformedBundleError('bundleVersion MUST be "1"');
  if (!b.source || typeof b.source !== 'object' || typeof (b.source as Record<string, unknown>).origin !== 'string') {
    throw new MalformedBundleError('source.origin is required');
  }
  if (!Array.isArray(b.items)) throw new MalformedBundleError('items MUST be an array');
  for (const it of b.items as unknown[]) {
    const item = it as Record<string, unknown>;
    if (typeof item.ref !== 'string' || !EXPORT_KINDS.includes(item.kind as never)) {
      throw new MalformedBundleError('each item MUST have a string ref and a known kind');
    }
  }
}

/** Topological order; throws DependsOnCycleError on a cycle. */
function topoOrder(items: ExportItem[]): string[] {
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const stack: string[] = [];
  const visit = (ref: string): void => {
    const s = state.get(ref);
    if (s === 'done') return;
    if (s === 'visiting') {
      const idx = stack.indexOf(ref);
      throw new DependsOnCycleError([...stack.slice(idx), ref]);
    }
    state.set(ref, 'visiting');
    stack.push(ref);
    for (const dep of byRef.get(ref)?.dependsOn ?? []) {
      if (byRef.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(ref, 'done');
    order.push(ref);
  };
  for (const i of items) visit(i.ref);
  return order;
}

/**
 * Validate a bundle for import. Runs BEFORE any apply/scope decision so a leaky
 * bundle is rejected 422 even on `?dryRun=true` (the conformance leg).
 */
export function validateForImport(rawBundle: unknown): { bundle: ExportBundle; order: string[] } {
  assertWellFormed(rawBundle);
  const bundle = rawBundle;
  for (const item of bundle.items) {
    const hit = findLiteralCredential(item.payload, `${item.kind}:${item.ref}.payload`);
    if (hit) throw new CredentialMaterialError(hit);
  }
  const order = topoOrder(bundle.items); // throws on cycle
  return { bundle, order };
}

export function planImport(rawBundle: unknown): ImportPlan {
  const { bundle, order } = validateForImport(rawBundle);
  const byKind: Record<string, number> = {};
  for (const i of bundle.items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return { dryRun: true, itemCount: bundle.items.length, byKind, order };
}

export function applyImport(rawBundle: unknown): ImportResult {
  const { bundle, order } = validateForImport(rawBundle);
  // Sample-grade: "install" is recording the refs in dependency order. A real
  // host would materialize each kind into its store here (still refs-only — a
  // connection-ref re-binds to a host secret by id, never a plaintext value).
  return { dryRun: false, imported: bundle.items.length, refs: order };
}

/** Build a refs-only export bundle for `tenant`. Sample-grade demo content —
 *  every item carries refs/ids only, never a secret value. */
export function buildExportBundle(tenant: string, kinds?: string[]): ExportBundle {
  const all: ExportItem[] = [
    { kind: 'roster', ref: `roster:${tenant}:chief-of-staff`, payload: { persona: 'chief-of-staff' } },
    { kind: 'prompt-template', ref: `pt:${tenant}:weekly-digest`, payload: { template: 'Summarize {{week}}', variables: ['week'] } },
    {
      kind: 'connection-ref',
      ref: `conn:${tenant}:github`,
      dependsOn: [`roster:${tenant}:chief-of-staff`],
      // refs only — the credential is a host secret id, never the value.
      payload: { provider: 'github', credentialRef: '[REDACTED:conn-github]' },
    },
  ];
  const items = kinds && kinds.length ? all.filter((i) => kinds.includes(i.kind)) : all;
  return { bundleVersion: '1', source: { origin: `host:openwop-app:${tenant}`, exportedAt: new Date().toISOString() }, items };
}
