/**
 * ADR 0972 D9 — is the RFC 0249 wire available on this host? True iff the vendored
 * v2 schemas carry it (`proposal-submit.schema.json` exists and
 * `proposal.schema.json` defines `installedArtifact`). Both schemas are closed, so
 * the host serves the proposal operations, advertises their facet members and
 * lists their scopes only once the pin that defines them is vendored (the RFC 0246
 * precedent, `evals/evalCapability.ts`). In `host/` because the scope list
 * (`protocolAuthorization.ts`) reads it as well as the proposals feature.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from './_repoPath.js';

let cachedWire: boolean | undefined;

export function rfc0249WireAvailable(): boolean {
  if (cachedWire !== undefined) return cachedWire;
  try {
    const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
    cachedWire = existsSync(join(dir, 'proposal-submit.schema.json'))
      && /"installedArtifact"/.test(readFileSync(join(dir, 'proposal.schema.json'), 'utf8'));
  } catch {
    cachedWire = false;
  }
  return cachedWire;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0249WireCache(force?: boolean): void {
  cachedWire = force;
}
