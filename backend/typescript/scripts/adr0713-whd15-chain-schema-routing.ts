/**
 * ADR 0713 / WHD-15 — does routing v2-shaped workflow-chain pack manifests to the
 * v2 schema change WHAT SERVES?
 *
 * ADR 0713 Phase 1b taught the chain loader to admit the registry's v2 `signing`
 * block by checking it against the prose, STRIPPING it, and validating the rest
 * against the ROOT (v1) schema (`manifestForCorpusSchema`). Corpus tag v2.32.0
 * fixed the v2 schema (openwop#1367), so the workaround can retire — by routing a
 * v2-shaped manifest to `schemas/v2/` with its signing block left IN.
 *
 * That is a reader repair, and ADR 0713's own ~30-minute production regression came
 * from exactly one of those: fixing a failing reader changed which packs served.
 * The v2 schema differs from v1 in more than `signing` — `engines` is closed,
 * `typeId` / `chainId` / `keyId` take the `ids.schema.json` grammars (typeId now
 * REQUIRES a dotted namespace; chainId is capped at 128, not 256), and the
 * extension prefix admits `openwop-`. Any of those can flip a verdict in either
 * direction. So the switch is decided by this measurement, not by reading the diff.
 *
 * ── THE PREDICATE (so it can be re-run, not trusted) ────────────────────────
 * Population:
 *   (a) every `pack.json` with `kind:"workflow-chain"` one level under the repo's
 *       `packs/` and `examples/workflow-chain-packs/`;
 *   (b) every `.tgz` inside a `-/` directory anywhere beneath `registry/v2/` of an
 *       `openwop-registry` checkout (`--registry <dir>`, repeatable), `pack.json`
 *       read from the tarball ROOT, kept when `kind:"workflow-chain"`;
 *   (c) optionally any `--extra-root <dir>` of installed packs (one level, like a
 *       loader root) — for a box that actually HAS a registry-installed population.
 *
 * Three arms, per manifest:
 *   LEGACY   — a FROZEN MIRROR of the pre-WHD-15 gate: v2 block checked against the
 *              prose (`manifestSigningKeyId`), stripped, remainder → v1 schema.
 *              A mirror, because the code it mirrors is what WHD-15 deletes; it is
 *              only trustworthy because this script proved LEGACY ≡ LOADER on the
 *              whole population BEFORE the loader changed (see the commit record).
 *   PROPOSED — v2-shaped (`signing` carries `keyId` or `scheme`) → v2 schema, block
 *              left in; anything else → v1 schema, untouched. Implemented HERE,
 *              independently of the loader.
 *   LOADER   — the REAL `loadWorkflowChainPacks`, run over the population
 *              materialised one-manifest-per-root (so no cross-pack shadowing or
 *              chainId conflict can stand in for a schema verdict). "Rejected" means
 *              the schema gate's `workflow_chain_pack_manifest_invalid`; every later
 *              stage (signature, cycle, composition, precedence) is untouched by
 *              WHD-15 and sees the same manifest under either path.
 *
 * Before the switch LOADER must equal LEGACY (the mirror is honest); after it,
 * LOADER must equal PROPOSED (the loader does what was measured). The script states
 * which one it found and exits 1 if it is NEITHER — a loader that matches no
 * measured arm is serving something nobody decided on.
 *
 * It reads; it never mounts, installs or boots anything (CLAUDE.md § "the pack
 * hazard that IS real"). Tarballs are read with `tar -xzO`, nothing is unpacked.
 *
 * Usage (from backend/typescript; never run by CI — the registry is not in-tree):
 *   OPENWOP_LOG_LEVEL=error node_modules/.bin/tsx scripts/adr0713-whd15-chain-schema-routing.ts \
 *     --registry ~/dev/openwop-registry [--registry <another>] [--extra-root <dir>] [--json <out>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { manifestSigningKeyId } from '../src/packs/registryInstaller.js';
import { _resetChainRegistryForTest, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = locateRepoSchemasDir(join(HERE, '..', 'src', 'host'), 'workflow-chain-pack-manifest.schema.json');
const REPO_ROOT = dirname(SCHEMAS_DIR);
const CHAIN_SCHEMA = 'workflow-chain-pack-manifest.schema.json';

type Shape = 'v2-signed' | 'v1-signed' | 'unsigned' | 'other-signing';
interface Verdict { ok: boolean; errors: string[] }
interface Row {
  source: string;
  id: string;
  name: string;
  version: string;
  shape: Shape;
  legacy: Verdict;
  proposed: Verdict;
  loader: Verdict;
}

// ── schema compilation ──────────────────────────────────────────────────────
/** The v2 schema `$ref`s its siblings (`ids.schema.json#/$defs/chainId`), so they
 *  are registered first or the compile throws MissingRefError. The v1 schema is
 *  self-contained; registering its siblings too is harmless and keeps one path. */
function compileChainSchema(dir: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const target = JSON.parse(readFileSync(join(dir, CHAIN_SCHEMA), 'utf8')) as { $id?: string };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.schema.json') || f === CHAIN_SCHEMA) continue;
    const sibling = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { $id?: string };
    if (sibling.$id && sibling.$id !== target.$id && !ajv.getSchema(sibling.$id)) ajv.addSchema(sibling);
  }
  return ajv.compile(target);
}
const validateV1 = compileChainSchema(SCHEMAS_DIR);
const validateV2 = compileChainSchema(join(SCHEMAS_DIR, 'v2'));

const firstErrors = (errs: ErrorObject[] | null | undefined): string[] =>
  (errs ?? []).slice(0, 2).map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`);

// ── the arms ────────────────────────────────────────────────────────────────
function signingOf(raw: unknown): Record<string, unknown> | undefined {
  const s = (raw as { signing?: unknown }).signing;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : undefined;
}
/** The routing predicate — byte-for-byte the condition `manifestForCorpusSchema`
 *  used to decide a block was "v2", so the two arms split the population on the
 *  same line and a differing verdict is a SCHEMA difference, never a routing one. */
function isV2Shaped(raw: unknown): boolean {
  const s = signingOf(raw);
  return !!s && ('keyId' in s || 'scheme' in s);
}
function shapeOf(raw: unknown): Shape {
  const s = signingOf(raw);
  if (!s) return 'unsigned';
  if (typeof s.keyId === 'string') return 'v2-signed';
  if ('publicKeyRef' in s || 'signatureRef' in s || 'method' in s) return 'v1-signed';
  return 'other-signing';
}

/** FROZEN MIRROR of `manifestForCorpusSchema` + the v1 validate that followed it
 *  (workflowChainPackLoader.ts as of `51fc3f6d9`). Do not "improve" it: its only
 *  job is to keep saying what the deleted code said. */
function legacyVerdict(raw: unknown): Verdict {
  if (!isV2Shaped(raw)) {
    return validateV1(raw) ? { ok: true, errors: [] } : { ok: false, errors: firstErrors(validateV1.errors) };
  }
  try {
    manifestSigningKeyId(signingOf(raw), 'v2');
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const { signing: _stripped, ...rest } = raw as Record<string, unknown>;
  void _stripped;
  return validateV1(rest) ? { ok: true, errors: [] } : { ok: false, errors: firstErrors(validateV1.errors) };
}

function proposedVerdict(raw: unknown): Verdict {
  const validate = isV2Shaped(raw) ? validateV2 : validateV1;
  return validate(raw) ? { ok: true, errors: [] } : { ok: false, errors: firstErrors(validate.errors) };
}

/** The real loader, one manifest per root. The schema gate reports under the
 *  DIRECTORY name (`pack: entry`); every later stage reports under `manifest.name`
 *  — so the fixed entry name below is what isolates the gate's verdict. */
const LOADER_ENTRY = 'whd15-subject';
function loaderVerdict(raw: unknown, scratch: string, n: number): Verdict {
  const root = join(scratch, String(n));
  mkdirSync(join(root, LOADER_ENTRY), { recursive: true });
  writeFileSync(join(root, LOADER_ENTRY, 'pack.json'), JSON.stringify(raw));
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [root] });
  const gate = errors.filter((e) => e.pack === LOADER_ENTRY && e.code === 'workflow_chain_pack_manifest_invalid');
  return gate.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: gate.map((e) => e.message.slice(0, 300)).slice(0, 2) };
}

// ── population ──────────────────────────────────────────────────────────────
interface Subject { source: string; id: string; raw: unknown }

function fromPackRoot(root: string, source: string): Subject[] {
  if (!existsSync(root)) return [];
  const out: Subject[] = [];
  for (const entry of readdirSync(root).sort()) {
    const file = join(root, entry, 'pack.json');
    if (!existsSync(file) || !statSync(join(root, entry)).isDirectory()) continue;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Repo packs are named relative to the repo; an `--extra-root` lives anywhere,
    // and a `../../..` chain out of the repo names nothing a reader can find.
    const id = file.startsWith(REPO_ROOT) ? relative(REPO_ROOT, file) : file;
    if ((raw as { kind?: unknown }).kind === 'workflow-chain') out.push({ source, id, raw });
  }
  return out;
}

function findTarballs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) findTarballs(p, acc);
    else if (entry.endsWith('.tgz') && dirname(p).endsWith('/-')) acc.push(p);
  }
  return acc;
}
function packJsonFromTarball(tgz: string): unknown | undefined {
  for (const member of ['pack.json', './pack.json']) {
    try {
      return JSON.parse(execFileSync('tar', ['-xzOf', tgz, member], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { /* try the other spelling of the root member */ }
  }
  return undefined;
}
function fromRegistry(checkout: string): { subjects: Subject[]; tarballs: number; unreadable: string[]; commit: string } {
  const v2 = join(checkout, 'registry', 'v2');
  if (!existsSync(v2)) throw new Error(`no registry/v2 under ${checkout}`);
  let commit = 'unknown';
  try { commit = execFileSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const tarballs = findTarballs(v2);
  const subjects: Subject[] = [];
  const unreadable: string[] = [];
  for (const tgz of tarballs) {
    const raw = packJsonFromTarball(tgz);
    if (raw === undefined) { unreadable.push(relative(checkout, tgz)); continue; }
    if ((raw as { kind?: unknown }).kind === 'workflow-chain') subjects.push({ source: `registry@${commit}`, id: relative(checkout, tgz), raw });
  }
  return { subjects, tarballs: tarballs.length, unreadable, commit };
}

// ── main ────────────────────────────────────────────────────────────────────
function argsOf(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1] as string); });
  return out;
}

const subjects: Subject[] = [
  ...fromPackRoot(join(REPO_ROOT, 'packs'), 'repo:packs'),
  ...fromPackRoot(join(REPO_ROOT, 'examples', 'workflow-chain-packs'), 'repo:examples'),
];
const registries = argsOf('--registry');
if (registries.length === 0) {
  console.error('REFUSING: no --registry <openwop-registry checkout>. The in-repo packs are all v1-shaped, so a run without the registry measures the arm WHD-15 does not change and would read as a clean zero.');
  process.exit(2);
}
for (const checkout of registries) {
  const r = fromRegistry(checkout);
  console.log(`registry ${checkout} @ ${r.commit}: ${r.tarballs} tarballs, ${r.subjects.length} kind:workflow-chain, ${r.unreadable.length} with no readable root pack.json`);
  for (const u of r.unreadable) console.log(`  UNREADABLE ${u}`);
  subjects.push(...r.subjects);
}
for (const extra of argsOf('--extra-root')) subjects.push(...fromPackRoot(extra, `extra:${extra}`));

const scratch = mkdtempSync(join(tmpdir(), 'whd15-'));
const rows: Row[] = [];
try {
  subjects.forEach((s, n) => {
    const m = s.raw as { name?: unknown; version?: unknown };
    rows.push({
      source: s.source, id: s.id, name: String(m.name), version: String(m.version), shape: shapeOf(s.raw),
      legacy: legacyVerdict(s.raw), proposed: proposedVerdict(s.raw), loader: loaderVerdict(s.raw, scratch, n),
    });
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
  _resetChainRegistryForTest();
}

const count = (pred: (r: Row) => boolean): number => rows.filter(pred).length;
console.log(`\nPOPULATION: ${rows.length} workflow-chain manifests`);
for (const src of [...new Set(rows.map((r) => r.source))]) {
  const of = rows.filter((r) => r.source === src);
  const shapes = (['v2-signed', 'v1-signed', 'unsigned', 'other-signing'] as const).map((sh) => `${sh}=${of.filter((r) => r.shape === sh).length}`).join(' ');
  console.log(`  ${src}: ${of.length}  (${shapes})`);
}

console.log('\nCONFUSION TABLE — LEGACY (rows) × PROPOSED (columns), per shape');
for (const sh of ['v2-signed', 'v1-signed', 'unsigned', 'other-signing'] as const) {
  const of = rows.filter((r) => r.shape === sh);
  if (of.length === 0) continue;
  const c = (l: boolean, p: boolean): number => of.filter((r) => r.legacy.ok === l && r.proposed.ok === p).length;
  console.log(`  ${sh} (n=${of.length})`);
  console.log(`    legacy ACCEPT → proposed ACCEPT: ${c(true, true)}    legacy ACCEPT → proposed REJECT: ${c(true, false)}   ← newly REJECTED`);
  console.log(`    legacy REJECT → proposed ACCEPT: ${c(false, true)}   ← newly ACCEPTED    legacy REJECT → proposed REJECT: ${c(false, false)}`);
}

const newlyRejected = rows.filter((r) => r.legacy.ok && !r.proposed.ok);
const newlyAccepted = rows.filter((r) => !r.legacy.ok && r.proposed.ok);
console.log(`\nNEWLY REJECTED by the proposed path: ${newlyRejected.length}`);
for (const r of newlyRejected) console.log(`  ${r.id} (${r.name}@${r.version}, ${r.shape})\n    ${r.proposed.errors.join('\n    ')}`);
console.log(`NEWLY ACCEPTED by the proposed path: ${newlyAccepted.length}`);
for (const r of newlyAccepted) console.log(`  ${r.id} (${r.name}@${r.version}, ${r.shape})\n    legacy said: ${r.legacy.errors.join('\n    ')}`);

const loaderVsLegacy = count((r) => r.loader.ok !== r.legacy.ok);
const loaderVsProposed = count((r) => r.loader.ok !== r.proposed.ok);
console.log(`\nWHICH ARM IS THE LOADER? disagreements with LEGACY: ${loaderVsLegacy}; with PROPOSED: ${loaderVsProposed}`);
for (const r of rows.filter((x) => x.loader.ok !== x.legacy.ok || x.loader.ok !== x.proposed.ok)) {
  console.log(`  ${r.id}: loader=${r.loader.ok} legacy=${r.legacy.ok} proposed=${r.proposed.ok}\n    ${[...r.loader.errors, ...r.legacy.errors, ...r.proposed.errors].slice(0, 2).join('\n    ')}`);
}
console.log(`LOADER accepts ${count((r) => r.loader.ok)} / ${rows.length}; LEGACY ${count((r) => r.legacy.ok)}; PROPOSED ${count((r) => r.proposed.ok)}`);

const [jsonOut] = argsOf('--json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));

// A population with no v2-signed manifest cannot speak to the v2 arm at all — the
// number it produces would be a zero from a probe that never reached the thing.
if (count((r) => r.shape === 'v2-signed') === 0) {
  console.error('\nVOID: zero v2-signed manifests in the population — nothing here exercises the v2 route.');
  process.exit(2);
}
if (loaderVsLegacy !== 0 && loaderVsProposed !== 0) {
  console.error('\nFAIL: the loader matches NEITHER measured arm.');
  process.exit(1);
}
console.log(`\nVERDICT: newly-rejected=${newlyRejected.length} newly-accepted=${newlyAccepted.length}; the loader currently implements ${loaderVsLegacy === 0 && loaderVsProposed === 0 ? 'BOTH arms (they agree everywhere)' : loaderVsLegacy === 0 ? 'LEGACY' : 'PROPOSED'}.`);
