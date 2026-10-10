/**
 * RFC 0233 — the connection-provider registry reads (`listConnectionProviders`,
 * `resolveConnectionProvider`), the normative observation path for
 * `connection-packs.md` §Provider identity and §The qualified form.
 *
 * Host-global and content-free (§B.2, §B.6): a row is an id, a source and a
 * pack name, and a refusal adds a code and a holder. Nothing here reads an
 * endpoint, a scope catalog or a credential.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from '../../host/_repoPath.js';
import { createLogger } from '../../observability/logger.js';
import { installConnectionPackManifest } from './connectionPackLoader.js';
import { getProvider, listProviders, providerPackOwner, providerRefusals } from './providerRegistry.js';

const log = createLogger('connections.providerRegistryRead');

export interface ProviderRow { id: string; source: 'builtin' | 'pack'; packName?: string }

function rowFor(id: string): ProviderRow {
  const owner = providerPackOwner(id);
  return owner ? { id, source: 'pack', packName: owner } : { id, source: 'builtin' };
}

/** §B.3–§B.5 — every definition the host resolves against, and the refusals. */
export function providerRegistryPage(): { providers: ProviderRow[]; refusals: ReturnType<typeof providerRefusals> } {
  // The registry is keyed by id, so each bare id is already listed once (§B.4).
  const providers = listProviders().map((p) => rowFor(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  return { providers, refusals: providerRefusals() };
}

/**
 * §C — resolve one reference. A bare id resolves to its one definition; the
 * qualified form (`pack`) resolves ONLY to that pack's definition, never to a
 * built-in or another pack's.
 */
export function resolveProviderRow(providerId: string, pack?: string): ProviderRow | null {
  if (pack !== undefined) return getProvider(`${pack}#${providerId}`) ? rowFor(providerId) : null;
  return getProvider(providerId) ? rowFor(providerId) : null;
}

/**
 * §D — the conformance fixture pair, installed ONLY when the operator sets
 * `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true`: the first pack, then its rival
 * claiming the same bare id, through the normal install path, BEFORE the read
 * is served (call it during boot). The provider is fictional and has no
 * endpoint anyone calls.
 */
export const PROVIDER_FIXTURE_FILES = ['connection-pack-acme-widgets.json', 'connection-pack-acme-widgets-rival.json'] as const;

export function installConformanceProviderFixtures(env: NodeJS.ProcessEnv = process.env): { attempted: number } {
  if ((env.OPENWOP_CONFORMANCE_PROVIDER_FIXTURES ?? '').trim().toLowerCase() !== 'true') return { attempted: 0 };
  const dir = join(
    locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'conformance-fixtures', `connection-packs/${PROVIDER_FIXTURE_FILES[0]}`),
    'connection-packs',
  );
  let attempted = 0;
  for (const file of PROVIDER_FIXTURE_FILES) {
    const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    const outcome = installConnectionPackManifest(manifest);
    attempted += 1;
    log.info('conformance_provider_fixture_install', { file, installed: outcome.installed, codes: (outcome.errors ?? []).map((e) => e.code) });
  }
  return { attempted };
}
