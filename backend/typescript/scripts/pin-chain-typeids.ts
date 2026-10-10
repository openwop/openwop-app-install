/**
 * ADR 0766 P2 — pin every in-tree workflow-chain node reference to the version
 * this host actually runs (RFC 0177 §E.1, "Exact pins").
 *
 *   npm run chains:pin                       # --check: report, change nothing (exit 1 if work remains)
 *   npm run chains:pin -- --write            # pin every UNPINNED reference
 *   npm run chains:pin -- --write --repin    # also rewrite a pin that no longer matches
 *   npm run chains:pin -- --pack <dir-name>  # limit to one pack under examples/workflow-chain-packs
 *
 * WHERE THE VERSION COMES FROM, AND WHY IT IS A BOOTED APP. 27 of the 182 node
 * types these chains reference are host-local modules whose version lives in
 * TypeScript source, not in any pack manifest, so a manifest scan cannot pin
 * them. The only complete answer is the catalog of a booted host
 * (`buildNodeCatalog()`) — which is also exactly what the runtime unmet-pin check
 * reads (ADR 0766 D3), so a chain this tool pins cannot then be reported as an
 * install gap by the same host.
 *
 * ISOLATION (architect review, HIGH). `createApp` mounts the repo's `packs/` into
 * `resolveDefaultPackDir()`. Booted against the shared `~/.openwop-packs` it would
 * (a) re-point every symlink there at this worktree — the CLAUDE.md "backend boot
 * outside vitest" hazard — and (b) could read a version another worktree or a
 * registry install put there. So the pack dir is a fresh private temp dir, set
 * BEFORE the app is imported, and the registry install list is cleared: the
 * versions read are this checkout's, and nothing shared is touched.
 *
 * WHY TEXT EDITS. Same reason as #3940: rewriting via JSON.stringify would
 * reformat every file. Each edit is a quoted-string replacement, and every
 * written file is then RE-PARSED and checked — its pins complete, and the
 * manifest otherwise deep-equal to the original — so an edit that hit the wrong
 * `"typeId"` fails loudly instead of shipping.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_PACK_DIR = mkdtempSync(join(tmpdir(), 'owp-pin-chains-'));
process.env.OPENWOP_PACK_DIR = TMP_PACK_DIR;
// grade-code C-12 — never leave the scratch pack dir behind.
process.on('exit', () => rmSync(TMP_PACK_DIR, { recursive: true, force: true }));
delete process.env.OPENWOP_INSTALL_PACKS;
process.env.OPENWOP_STORAGE_DSN = 'memory://';
process.env.OPENWOP_LOG_LEVEL = process.env.OPENWOP_LOG_LEVEL ?? 'error';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const REPIN = args.includes('--repin');
const onlyPack = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : undefined;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// grade-code C-12 — the e2e fixture chains load through the same loader, which
// refuses an unpinned reference, so they are pinned by the same tool.
const CHAIN_ROOTS = [
  join(REPO, 'examples', 'workflow-chain-packs'),
  join(REPO, 'frontend', 'react', 'e2e', 'fixtures', 'chain-packs'),
].filter((r) => existsSync(r));

const { createApp } = await import('../src/index.js');
const { buildNodeCatalog } = await import('../src/host/nodeCatalogBuilder.js');
const { chainPinFindings, normalizeChainPins, parseNodeRef } = await import('../src/host/chainPinRule.js');

await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'pin-chain-typeids', serviceVersion: '0', enableConsoleTracer: false });
const installed = new Map(buildNodeCatalog().map((n) => [n.typeId, n.version]));

interface Edit { from: string; to: string }
interface PackReport { root: string; dir: string; edits: Edit[]; stale: string[]; unresolvable: string[] }

function planPack(root: string, dir: string): PackReport {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'pack.json'), 'utf8')) as { chains: Array<Record<string, unknown>> };
  const edits = new Map<string, string>();
  const stale = new Set<string>();
  const unresolvable = new Set<string>();
  for (const chain of manifest.chains) {
    const nodes = ((chain['dag'] as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes) ?? [];
    const refs = nodes.flatMap((n) => [n['typeId'], (n['compensation'] as { nodeTypeId?: unknown } | undefined)?.nodeTypeId])
      .filter((r): r is string => typeof r === 'string');
    for (const ref of refs) {
      const { typeId, version } = parseNodeRef(ref);
      const want = installed.get(typeId);
      if (!want) { unresolvable.add(typeId); continue; }
      if (version === null) { edits.set(ref, `${typeId}@${want}`); continue; }
      if (version !== want) {
        if (REPIN) edits.set(ref, `${typeId}@${want}`);
        else stale.add(`${ref} (installed ${want})`);
      }
    }
  }
  return { root, dir, edits: [...edits].map(([from, to]) => ({ from, to })), stale: [...stale].sort(), unresolvable: [...unresolvable].sort() };
}

/** Apply the edits as quoted-string replacements on the `typeId` / `nodeTypeId`
 *  keys only, then prove the result: every reference pinned, and the manifest
 *  otherwise identical to the original. Throws — before writing — on any drift. */
function applyPack(report: PackReport): void {
  const file = join(report.root, report.dir, 'pack.json');
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (const { from, to } of report.edits) {
    const pattern = new RegExp(`("(?:typeId|nodeTypeId)"\\s*:\\s*)"${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    text = text.replace(pattern, `$1"${to}"`);
  }
  const before = JSON.parse(original) as { chains: Array<Record<string, unknown>> };
  const after = JSON.parse(text) as { chains: Array<Record<string, unknown>> };
  const bare = (m: { chains: Array<Record<string, unknown>> }) => JSON.stringify({ ...m, chains: m.chains.map((c) => normalizeChainPins(c).chain) });
  if (bare(before) !== bare(after)) throw new Error(`${report.dir}: the edit changed more than node pins — refusing to write`);
  const leftover = after.chains.flatMap((c) => chainPinFindings(c)).filter((f) => !f.site.startsWith('subChains['));
  // Holds under --repin too (grade-code C-12): repinning never un-pins.
  if (leftover.length > 0) {
    throw new Error(`${report.dir}: references still unpinned after the edit: ${leftover.map((f) => f.ref).join(', ')}`);
  }
  writeFileSync(file, text);
}

const packs = CHAIN_ROOTS.flatMap((root) => readdirSync(root)
  .filter((d) => existsSync(join(root, d, 'pack.json')))
  .filter((d) => (JSON.parse(readFileSync(join(root, d, 'pack.json'), 'utf8')) as { kind?: string }).kind === 'workflow-chain')
  .filter((d) => onlyPack === undefined || d === onlyPack)
  .sort()
  .map((dir) => ({ root, dir })));

let pending = 0;
let blocked = 0;
for (const { root, dir } of packs) {
  const report = planPack(root, dir);
  if (report.unresolvable.length > 0) {
    blocked += 1;
    console.log(`✗ ${dir}: no installed version for ${report.unresolvable.join(', ')} — cannot pin (is the node pack's nodes[].version declared?)`);
    continue;
  }
  if (report.stale.length > 0) console.log(`! ${dir}: pinned to a version this host does not run: ${report.stale.join(', ')} (re-run with --repin)`);
  if (report.edits.length === 0) continue;
  pending += 1;
  if (WRITE) {
    applyPack(report);
    console.log(`✓ ${dir}: pinned ${report.edits.length} reference(s)`);
  } else {
    console.log(`· ${dir}: ${report.edits.length} reference(s) to pin`);
  }
}
if (WRITE && pending > 0) console.log('\nNext: bump each written pack AND each changed chain one patch (check-pack-version-bump requires both), then re-publish any registry-published pack.');
console.log(`\n${packs.length} chain pack(s) scanned · ${pending} ${WRITE ? 'written' : 'with work pending'} · ${blocked} blocked`);
process.exit(blocked > 0 || (!WRITE && pending > 0) ? 1 : 0);
