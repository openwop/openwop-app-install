/**
 * RFC 0266 — bring a workflow-chain pack authored OUTSIDE the registry onto v2.
 *
 *   npm run chains:migrate-v2 -- <pack-dir|pack.json> [...]           # report, change nothing (exit 1 if work remains)
 *   npm run chains:migrate-v2 -- <pack-dir|pack.json> [...] --write   # apply the safe rewrite
 *
 * WHY THIS EXISTS. This host verifies only v2 signatures (spec/v2/core/packs.md
 * §Signing) and refuses a v1 signing block (`method` / `publicKeyRef` /
 * `signatureRef`) with `workflow_chain_pack_signing_v1`. A v1 signature cannot be
 * relabelled into v2: the spec says such a pack "MUST be re-signed, not
 * relabeled", and any edit to `pack.json` voids the old signature anyway. Only the
 * registry signs v2 (`ed25519-canonical-json`, over the canonical `pack.json` in
 * its v2 tree). So the path for a v1-signed pack is:
 *
 *   1. a registry pack: install it from the registry's v2 tree (the installer
 *      reads nothing else), where the registry has already re-signed it;
 *   2. a pack authored elsewhere: run this tool, then submit the pack to the
 *      registry, which signs it on merge.
 *
 * WHAT IT CHANGES (only with --write; every edit is reported first):
 *   - removes a v1 signing block. A v2 `{ keyId, scheme }` block is kept;
 *   - nothing else. The engine range and node pins are the author's to declare,
 *     so they are reported, never guessed: an `engines.openwop` that does not
 *     admit major 2 is a finding, and unpinned or ranged node references are
 *     handed to `npm run chains:pin -- --write`.
 * After the rewrite the manifest is validated against the vendored
 * `schemas/v2/workflow-chain-pack-manifest.schema.json`; a pack that still fails
 * is reported with the schema errors and exits non-zero.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileV2Schema } from '../src/host/v2SchemaCompile.js';
import { locateRepoSchemasV2Dir } from '../src/host/_repoPath.js';
import { v1SigningFields } from '../src/host/workflowChainPackLoader.js';
import { chainPinFindings, describePinFindings } from '../src/host/chainPinRule.js';

const RANGE = /^>=\s*(\d+)(?:\.\d+){0,2}\s+<\s*(\d+)\.0\.0$/;

export interface MigrationReport {
  file: string;
  changes: string[];
  findings: string[];
  valid: boolean;
}

/** Pure: what the migration does to one manifest. Exported for the test. */
export function migrateChainManifest(raw: Record<string, unknown>): { manifest: Record<string, unknown>; changes: string[]; findings: string[] } {
  const manifest = structuredClone(raw);
  const changes: string[] = [];
  const findings: string[] = [];
  if (manifest['kind'] !== 'workflow-chain') findings.push(`kind is ${JSON.stringify(manifest['kind'])}, not "workflow-chain"`);
  const v1 = v1SigningFields(manifest['signing']);
  if (v1.length > 0) {
    delete manifest['signing'];
    changes.push(`removed the v1 signing block (${v1.join(', ')}); the registry signs the v2 copy on submission`);
  }
  const range = (manifest['engines'] as { openwop?: unknown } | undefined)?.openwop;
  const m = typeof range === 'string' ? RANGE.exec(range.trim()) : null;
  if (!m) findings.push(`engines.openwop ${JSON.stringify(range)} is not \`>=x[.y[.z]] <M.0.0\` with an explicit ceiling`);
  else if (Number(m[2]) <= 2) findings.push(`engines.openwop "${range as string}" does not admit protocol major 2 — the author must declare v2 compatibility`);
  const chains = Array.isArray(manifest['chains']) ? (manifest['chains'] as Record<string, unknown>[]) : [];
  for (const chain of chains) {
    const pins = chainPinFindings(chain as Parameters<typeof chainPinFindings>[0]);
    if (pins.length > 0) findings.push(`${describePinFindings(pins)} — run \`npm run chains:pin -- --write\``);
  }
  return { manifest, changes, findings };
}

function manifestPath(arg: string): string {
  const p = resolve(arg);
  return existsSync(p) && statSync(p).isDirectory() ? join(p, 'pack.json') : p;
}

function main(argv: string[]): number {
  const write = argv.includes('--write');
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    console.error('usage: npm run chains:migrate-v2 -- <pack-dir|pack.json> [...] [--write]');
    return 2;
  }
  const validate = compileV2Schema(
    locateRepoSchemasV2Dir(dirname(fileURLToPath(import.meta.url)), 'workflow-chain-pack-manifest.schema.json'),
    'workflow-chain-pack-manifest.schema.json',
  );
  let failed = 0;
  for (const t of targets) {
    const file = manifestPath(t);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { manifest, changes, findings } = migrateChainManifest(raw);
    const valid = validate(manifest) === true;
    if (!valid) findings.push(`fails schemas/v2/workflow-chain-pack-manifest.schema.json: ${JSON.stringify(validate.errors)}`);
    if (write && changes.length > 0) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${file}`);
    for (const c of changes) console.log(`  ${write ? 'changed' : 'would change'}: ${c}`);
    for (const f of findings) console.log(`  finding: ${f}`);
    if (changes.length === 0 && findings.length === 0) console.log('  already v2: nothing to do');
    if (findings.length > 0 || (!write && changes.length > 0)) failed++;
  }
  if (failed === 0 && write) console.log('\nNext: submit the pack to the registry; it signs the v2 copy (ed25519-canonical-json) on merge.');
  return failed > 0 ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
