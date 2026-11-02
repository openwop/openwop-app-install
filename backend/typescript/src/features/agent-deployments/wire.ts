/**
 * ADR 1005 D4 (RFC 0254 §D) — is `transitionRunId` on the wire yet? True iff the
 * vendored v2 `agent-deployment.schema.json` defines it. The record is closed, so
 * the host sends the field only once the pinned suite's schemas seat it (the ADR
 * 0972 D9 / `rfc0249Wire.ts` precedent). The management run itself is minted
 * either way; only the pointer to it waits for the pin.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../../host/_repoPath.js';

let cached: boolean | undefined;

export function transitionRunIdOnWire(): boolean {
  if (cached !== undefined) return cached;
  try {
    const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
    cached = /"transitionRunId"/.test(readFileSync(join(dir, 'agent-deployment.schema.json'), 'utf8'));
  } catch {
    cached = false;
  }
  return cached;
}

/** Test seam: re-read the vendored schema (or force a value). */
export function resetTransitionRunIdWire(force?: boolean): void {
  cached = force;
}
