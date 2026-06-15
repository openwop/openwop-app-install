/**
 * Provider catalog — server-side mirror of the FE's BYOK wizard data.
 *
 * Reads the single source of truth at the repo-root `providers.json`
 * so adding a new provider model only requires editing one file. The
 * BE uses this for:
 *   - Default model fallback in `vendor.openwop-app.chat-responder`
 *     (when the FE doesn't supply `inputs.model`).
 *   - Forward-compat validation surface (future: reject unknown
 *     provider IDs at run-create with a useful error envelope).
 *
 * esbuild + tsx both handle JSON imports natively. In dev the JSON
 * lives on disk; in the production bundle it's inlined.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, parse as parsePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProviderModel {
  id: string;
  label: string;
  contextWindow: number;
  capabilities: readonly string[];
  cost?: { input: number; output: number };
  recommended?: boolean;
}

interface ProviderConfig {
  id: string;
  label: string;
  models: readonly ProviderModel[];
  [extra: string]: unknown;
}

interface ProvidersDocument {
  providers: readonly ProviderConfig[];
  [extra: string]: unknown;
}

/**
 * Locate providers.json without hard-coding directory depth. Walks UP from this
 * module's dir checking each ancestor for `providers.json`, returning the
 * nearest. Layout-independent — resolves the repo-root providers.json whether
 * running from `src/providers/` (tsx dev) or the `lib/` esbuild bundle, and
 * finds a copy vendored alongside the bundle (Dockerfile) since the walk starts
 * at `here`. `OPENWOP_PROVIDERS_PATH` overrides for forks / tests / unusual layouts.
 *
 * (Replaces a fixed `../../../../` + `../` + `./` candidate list that was
 * calibrated for the old apps/workflow-engine monorepo layout and broke once the
 * app became its own repo with providers.json at the root.)
 */
function locateProvidersJson(): string {
  const override = process.env.OPENWOP_PROVIDERS_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`OPENWOP_PROVIDERS_PATH is set to "${override}" but no file exists there.`);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  const fsRoot = parsePath(dir).root;
  const tried: string[] = [];
  for (;;) {
    const candidate = resolve(dir, 'providers.json');
    tried.push(candidate);
    if (existsSync(candidate)) return candidate;
    if (dir === fsRoot) break;
    dir = dirname(dir);
  }
  throw new Error(
    `providers.json not found walking up from the module dir (${tried.length} ancestors, ` +
      `${tried[0]} … ${tried[tried.length - 1]}). Set OPENWOP_PROVIDERS_PATH, or ensure ` +
      'providers.json sits at the repo root (dev) / is vendored alongside the bundle (Dockerfile, prod).',
  );
}

function loadCatalog(): ProvidersDocument {
  const raw = readFileSync(locateProvidersJson(), 'utf-8');
  return JSON.parse(raw) as ProvidersDocument;
}

const CATALOG = loadCatalog();

export function listProviders(): readonly ProviderConfig[] {
  return CATALOG.providers;
}

export function getProviderConfig(id: string): ProviderConfig | null {
  return CATALOG.providers.find((p) => p.id === id) ?? null;
}

/**
 * Provider ids advertised with `managed: true` in providers.json — the
 * "Try it free"-style tiers whose key the operator holds server-side.
 * The readiness probe cross-references these against the actually-seeded
 * managed keys so an advertised-but-unconfigured tier (dropped/unmounted
 * secret, missing env at boot) is caught at deploy time rather than on
 * the first user run. See managedProvider.ts:getManagedProviderStatuses.
 */
export function listManagedProviderIds(): readonly string[] {
  return CATALOG.providers.filter((p) => p.managed === true).map((p) => p.id);
}

/**
 * Return the default model id for a provider — first `recommended: true`,
 * else first model. Used by the chat responder node when inputs.model
 * isn't supplied.
 */
export function getDefaultModel(providerId: string): string {
  const p = getProviderConfig(providerId);
  if (!p) {
    // Unknown provider — caller will fail at dispatch anyway; return
    // a safe-looking model id so the error message is descriptive.
    return `${providerId}-unknown`;
  }
  const recommended = p.models.find((m) => m.recommended);
  return (recommended ?? p.models[0])?.id ?? `${providerId}-unknown`;
}
