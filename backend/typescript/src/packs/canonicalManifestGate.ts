/**
 * PMC-5 — canonical manifest validation at the INSTALL boundary.
 *
 * `registryInstaller` verifies a pack's SHA-256 SRI integrity and its Ed25519
 * signature. Neither says anything about SHAPE: a signature proves AUTHORSHIP.
 * So a correctly-signed pack whose `pack.json` violates its published manifest
 * schema installed cleanly, and the defect only surfaced later — as a type that
 * silently failed to register, with nothing reported to the installer.
 *
 * WHY THE BOUNDARY AND NOT THE LOADER. The canonical schemas describe a
 * *published* pack ("Manifest for a published OpenWOP artifact-type pack"). In-tree
 * host packs are never published — they are the host's private extension
 * mechanism, and 115 of this repo's 205 packs use a `feature.` namespace the
 * canonical name pattern does not admit. Validating in the loader would reject
 * them at boot. Validating here checks exactly what it should: bytes arriving
 * from a registry.
 *
 * WHY ONLY SOME KINDS. Measured across `packs/` before writing this:
 *   form-content  : 1/1 pass
 *   artifact-type : 0/4 pass  (inline `schema` vs canonical `schemaRef`; missing
 *                              `engines`; and `artifactTypeId` must match
 *                              `^(core|vendor|community|private)\.` while this host
 *                              ships `doc.one-pager` / `brand.kit`)
 * Enforcing every kind today would reject packs this repo ships. `ENFORCED_KINDS`
 * therefore lists only kinds whose packs already validate; adding one is a CLAIM
 * that every pack of that kind passes, and `pack-manifest-canonical-validity.test.ts`
 * is the ratchet that keeps the claim true. Full analysis + the blocked items:
 * `docs/steward/PACK-MANIFEST-CANONICAL-GAP.md`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { locateRepoSchemasDir } from '../host/_repoPath.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('packs.canonicalManifestGate');

/** kind → canonical schema filename. ONLY kinds whose shipped packs validate. */
export const ENFORCED_KINDS: Readonly<Record<string, string>> = {
  'form-content': 'form-content-pack-manifest.schema.json',
};

const validators = new Map<string, ValidateFunction | null>();

function validatorFor(kind: string): ValidateFunction | null {
  if (validators.has(kind)) return validators.get(kind) ?? null;
  const file = ENFORCED_KINDS[kind];
  let compiled: ValidateFunction | null = null;
  if (file) {
    try {
      const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), file);
      const path = join(dir, file);
      if (existsSync(path)) {
        compiled = new Ajv2020({ strict: false, allErrors: true })
          .compile(JSON.parse(readFileSync(path, 'utf8')) as object);
      } else {
        // Fail OPEN here, loudly. A missing vendored schema is a packaging bug in
        // THIS host; refusing every install because we mislaid a file would turn a
        // local mistake into an outage. The test asserts the schema is present so
        // this branch cannot be reached silently in CI.
        log.warn('canonical schema for an enforced kind is missing — install not gated', { kind, file });
      }
    } catch (err) {
      log.warn('canonical schema failed to compile — install not gated', { kind, file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  validators.set(kind, compiled);
  return compiled;
}

/**
 * Throw when `packJsonBytes` declares an ENFORCED kind and violates its canonical
 * schema. Unknown/unenforced kinds pass through untouched.
 *
 * @param packJsonBytes the SIGNATURE-VERIFIED `pack.json` bytes — validate what was
 *                      actually signed, never a re-read from disk.
 */
export function assertCanonicalManifest(packJsonBytes: Uint8Array): void {
  let manifest: { kind?: unknown; name?: unknown };
  try {
    manifest = JSON.parse(Buffer.from(packJsonBytes).toString('utf8')) as { kind?: unknown; name?: unknown };
  } catch {
    throw new Error('pack_manifest_unparseable: pack.json is not valid JSON');
  }
  const kind = typeof manifest.kind === 'string' ? manifest.kind : undefined;
  const packName = typeof manifest.name === 'string' ? manifest.name : '';
  if (!kind || !(kind in ENFORCED_KINDS)) return;

  const validate = validatorFor(kind);
  if (!validate) return;
  if (validate(manifest)) return;

  const detail = (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
    .join('; ');
  log.warn('pack rejected: manifest violates its canonical schema', { kind, name: packName, detail });
  throw new Error(`pack_manifest_invalid (${kind}): ${detail}`);
}
