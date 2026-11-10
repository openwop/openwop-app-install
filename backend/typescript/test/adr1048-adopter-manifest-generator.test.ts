/**
 * ADR 1048 D4 — `gen-steward-manifest.mjs --adopter`, the re-export fix in the
 * reach classifier, and the CENSUS RATCHET over the adopter tier.
 *
 * Every case builds a throwaway adopter tree (packs/, a steward manifest, and
 * `backend/typescript/src/adopter/packPins.ts`) — never the real one, so a green
 * here is the generator's behaviour and not whatever this checkout ships.
 *
 * Sabotage witnesses (ADR 1048 §Sabotage):
 *   S12 re-export: drop `resolveImportedBinding` from the walk ⇒ the re-exported
 *       `ask` reads `unresolved` and the ai-invocation-log assertion goes red.
 *   S13 escaping / bare specifiers are followed ⇒ the "never followed" cases go red.
 *   S14 the ratchet: any added node, or a node moving between served and held,
 *       changes the serialised manifest — the `--check` comparison.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adopterCensus,
  buildAdopterManifest,
  readAdopterManifest,
  serialiseManifest,
} from '../../../scripts/lib/adopter-pack-manifest.mjs';
import { buildImplIndex, classifyNodeReach, resolveImportedBinding } from '../../../scripts/lib/packNodeReach.mjs';
import { packContentDigest } from '../../../scripts/lib/pack-content-digest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KEY = 'vendor.acme1048.nodes';
const T = (n: string): string => `${KEY}.${n}`;

let root: string;

interface Node { typeId: string; role?: string; capabilities?: string[] }

function writeTree(opts: { nodes?: Node[]; index?: string; files?: Record<string, string>; pins?: Record<string, string>; adopterSrc?: boolean } = {}): void {
  const packs = join(root, 'packs');
  // One upstream (steward) pack, so the tree has a partition to respect.
  const up = join(packs, 'core.openwop.fix1048');
  mkdirSync(up, { recursive: true });
  writeFileSync(join(up, 'pack.json'), JSON.stringify({ name: 'core.openwop.fix1048', version: '1.0.0', nodes: [{ typeId: 'core.openwop.fix1048.write', role: 'side-effect' }] }));
  writeFileSync(join(up, 'index.mjs'), "export const nodes = { 'core.openwop.fix1048.write': write };\nexport async function write(ctx) { return { status: 'success' }; }\n");
  writeFileSync(join(packs, '.steward-manifest.json'), JSON.stringify({ version: 1, packs: { 'core.openwop.fix1048': { version: '1.0.0', files: 2, digest: packContentDigest(up) } } }));

  const dir = join(packs, KEY);
  mkdirSync(dir, { recursive: true });
  const nodes = opts.nodes ?? [
    { typeId: T('ask'), role: 'side-effect', capabilities: ['side-effectful'] },
    { typeId: T('insert'), role: 'side-effect' },
    { typeId: T('opaque'), role: 'side-effect' },
    { typeId: T('lookup'), role: 'read' },
  ];
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name: KEY, version: '1.0.0', nodes }, null, 2));
  writeFileSync(join(dir, 'index.mjs'), opts.index ?? [
    // Book AI's measured shape: index.mjs only re-exports the node function.
    "import { ask } from './ask.mjs';",
    "export { ask } from './ask.mjs';",
    "import { opaque } from 'some-lib';",
    `export const nodes = { '${T('ask')}': ask, '${T('insert')}': insert, '${T('opaque')}': opaque, '${T('lookup')}': lookup };`,
    'export async function insert(ctx) { return ctx.surfaces.records.insert({}); }',
    'export async function lookup(ctx) { return ctx.surfaces.records.get(1); }',
    '',
  ].join('\n'));
  const files = opts.files ?? {
    'ask.mjs': "import { callModel } from './model.mjs';\nexport async function ask(ctx) { return callModel(ctx); }\n",
    'model.mjs': 'export async function callModel(ctx) { return ctx.callAI({ prompt: "hi" }); }\n',
  };
  for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src);
  if (opts.adopterSrc !== false) {
    mkdirSync(join(root, 'backend/typescript/src/adopter'), { recursive: true });
    const pins = opts.pins ?? { [KEY]: '1.0.0' };
    writeFileSync(join(root, 'backend/typescript/src/adopter/packPins.ts'),
      `export const ADOPTER_PACK_PINS: Readonly<Record<string, string>> = {\n${Object.entries(pins).map(([k, v]) => `  '${k}': '${v}',`).join('\n')}\n};\n`);
  }
}

const entry = () => buildAdopterManifest(root).packs[KEY]!;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owp-1048-gen-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('ADR 1048 D4 — the --adopter generator', () => {
  it('is INERT where there is no src/adopter/ (upstream): it refuses rather than claim a first-party pack', () => {
    writeTree({ adopterSrc: false });
    expect(() => buildAdopterManifest(root)).toThrow(/inert/);
  });

  it('claims exactly the directories the steward manifest does not, with the floor half derived', () => {
    writeTree();
    const m = buildAdopterManifest(root);
    expect(Object.keys(m.packs)).toEqual([KEY]);
    const e = m.packs[KEY]!;
    expect(e.version).toBe('1.0.0');
    expect(e.digest).toBe(packContentDigest(join(root, 'packs', KEY)));
    expect(e.declared).toEqual([T('ask'), T('insert'), T('lookup'), T('opaque')]);
    // ask reaches ctx.callAI through TWO sibling modules ⇒ held live under the invocation log.
    expect(e.held['ai-invocation-log']).toEqual([T('ask')]);
    // insert: readable, no AI ⇒ served. opaque: unreadable ⇒ served too (fail CLOSED), and named.
    expect(e.served).toEqual([T('insert'), T('opaque')]);
    expect(e.servedUnresolved).toEqual([T('opaque')]);
  });

  it.each([
    ['a missing role', [{ typeId: T('x') }], /no recognized role/],
    ['a reserved-prefix directory', null, /reserved_prefix/],
    ['a pin that disagrees', undefined, /pin_version/],
  ])('refuses to write on %s', (label, nodes, re) => {
    if (label === 'a reserved-prefix directory') {
      writeTree();
      const evil = join(root, 'packs', 'core.openwop.evil');
      mkdirSync(evil);
      writeFileSync(join(evil, 'pack.json'), JSON.stringify({ name: 'core.openwop.evil', version: '1.0.0', nodes: [] }));
    } else if (label === 'a pin that disagrees') {
      writeTree({ pins: { [KEY]: '2.0.0' } });
    } else {
      writeTree({ nodes: nodes as Node[], index: `export const nodes = { '${T('x')}': x };\nexport async function x() {}\n`, files: {} });
    }
    expect(() => buildAdopterManifest(root)).toThrow(re);
  });

  it('an adopter typeId that collides with an upstream one is a build failure', () => {
    writeTree({ nodes: [{ typeId: 'core.openwop.fix1048.write', role: 'pure' }], index: "export const nodes = { 'core.openwop.fix1048.write': w };\nexport async function w() {}\n", files: {} });
    expect(() => buildAdopterManifest(root)).toThrow(/conflicting roles/);
  });
});

describe('ADR 1048 D3(c) — declared replay classes: own nodes, per node, applied last', () => {
  function withReplayClass(rc: Record<string, string>): void {
    writeTree();
    const m = buildAdopterManifest(root);
    m.packs[KEY]!.replayClass = rc;
    writeFileSync(join(root, 'packs', '.adopter-manifest.json'), serialiseManifest(m));
  }

  it('`pure` holds a floor node live (declared-pure), `served` serves a held one — and the census lists both', () => {
    withReplayClass({ [T('insert')]: 'pure', [T('ask')]: 'served' });
    const e = entry();
    expect(e.held['declared-pure']).toEqual([T('insert')]);
    expect(e.served).toEqual([T('ask'), T('opaque')]);
    expect(e.held['ai-invocation-log']).toEqual([]);
    const census = adopterCensus(buildAdopterManifest(root)).join('\n');
    expect(census).toContain(`declared replay class: ${T('insert')} = pure`);
    expect(census).toContain(`declared replay class: ${T('ask')} = served`);
  });

  it('a wildcard is refused — declaring `pure` is explicit per node', () => {
    withReplayClass({ [`${KEY}.*`]: 'pure' });
    expect(() => buildAdopterManifest(root)).toThrow(/replay_class/);
  });

  it('a class for a node that is not the pack\'s own is refused', () => {
    withReplayClass({ 'core.openwop.fix1048.write': 'pure' });
    expect(() => buildAdopterManifest(root)).toThrow(/replay_class/);
  });
});

describe('ADR 1048 — the CENSUS RATCHET: the committed adopter manifest is the baseline (S14)', () => {
  function commit(): string {
    const s = serialiseManifest(buildAdopterManifest(root));
    writeFileSync(join(root, 'packs', '.adopter-manifest.json'), s);
    return s;
  }

  it('unchanged tree ⇒ identical; an ADDED node ⇒ different', () => {
    writeTree();
    const base = commit();
    expect(serialiseManifest(buildAdopterManifest(root))).toBe(base);
    const pj = join(root, 'packs', KEY, 'pack.json');
    const m = JSON.parse(readFileSync(pj, 'utf8')) as { nodes: Node[] };
    m.nodes.push({ typeId: T('extra'), role: 'pure' });
    writeFileSync(pj, JSON.stringify(m));
    expect(serialiseManifest(buildAdopterManifest(root))).not.toBe(base);
  });

  it('a node MOVING from served to held (its role changes) ⇒ different, even with the same node set', () => {
    writeTree();
    const before = buildAdopterManifest(root).packs[KEY]!;
    const pj = join(root, 'packs', KEY, 'pack.json');
    const m = JSON.parse(readFileSync(pj, 'utf8')) as { nodes: Node[] };
    m.nodes = m.nodes.map((n) => (n.typeId === T('insert') ? { ...n, role: 'gate', capabilities: ['side-effectful'] } : n));
    writeFileSync(pj, JSON.stringify(m));
    const after = buildAdopterManifest(root).packs[KEY]!;
    expect(before.served).toContain(T('insert'));
    expect(after.served).not.toContain(T('insert'));
    expect(after.held['deferred-role-semantics']).toEqual([T('insert')]);
  });

  it('the CLI --check fails on drift and names the regenerate command; passes once regenerated', () => {
    writeTree();
    cpSync(join(REPO, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'gen-steward-manifest.mjs'), join(root, 'scripts', 'gen-steward-manifest.mjs'));
    const run = (...args: string[]): { code: number; out: string } => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(root, 'scripts', 'gen-steward-manifest.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const before = run('--check');
    expect(before.code).toBe(1);
    expect(before.out).toContain('--adopter');
    expect(run('--adopter').code).toBe(0);
    expect(readAdopterManifest(root)?.packs[KEY]).toBeDefined();
    expect(run('--check')).toMatchObject({ code: 0 });
    writeFileSync(join(root, 'packs', KEY, 'index.mjs'), `${readFileSync(join(root, 'packs', KEY, 'index.mjs'), 'utf8')}// drift\n`);
    const drifted = run('--check');
    expect(drifted.code).toBe(1);
    expect(drifted.out).toMatch(/adopter-manifest\.json is stale[\s\S]*content changed/);
  });

  it('the CLI --check refuses a HAND-EDITED floor half (a node moved to held, every digest unchanged)', () => {
    writeTree();
    cpSync(join(REPO, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'gen-steward-manifest.mjs'), join(root, 'scripts', 'gen-steward-manifest.mjs'));
    const script = join(root, 'scripts', 'gen-steward-manifest.mjs');
    execFileSync(process.execPath, [script, '--adopter'], { stdio: 'ignore' });
    const file = join(root, 'packs', '.adopter-manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as { packs: Record<string, { served: string[]; held: Record<string, string[]> }> };
    const e = m.packs[KEY]!;
    e.served = e.served.filter((t) => t !== T('insert'));
    e.held['declared-pure'] = [T('insert')];
    writeFileSync(file, serialiseManifest(m));
    let code = 0;
    let out = '';
    try {
      execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const x = err as { status?: number; stdout?: string; stderr?: string };
      code = x.status ?? 1;
      out = `${x.stdout ?? ''}${x.stderr ?? ''}`;
    }
    expect(code).toBe(1);
    expect(out).toContain('floor half changed');
  });

  it('THIS tree: upstream tracks no adopter manifest; an adopter tree\'s committed one is current', () => {
    const committed = join(REPO, 'packs', '.adopter-manifest.json');
    if (!existsSync(join(REPO, 'backend/typescript/src/adopter'))) {
      // openwop-app itself — `build-whitelabel-zip.sh` refuses to ship one.
      expect(existsSync(committed), 'upstream must never carry packs/.adopter-manifest.json (ADR 1048)').toBe(false);
      return;
    }
    if (!existsSync(committed)) return; // an adopter with no packs of its own
    expect(serialiseManifest(buildAdopterManifest(REPO)), 'run: node scripts/gen-steward-manifest.mjs --adopter').toBe(readFileSync(committed, 'utf8'));
  });
});

describe('ADR 1048 — the reach classifier follows relative re-exports, inside the pack only', () => {
  it('S12: a node function re-exported from a sibling resolves — and is seen reaching ctx.callAI', () => {
    writeTree();
    expect(classifyNodeReach(T('ask'), buildImplIndex(root))).toEqual({ kind: 'invocation-log' });
  });

  it('`export { x } from` alone (no import line) resolves too', () => {
    writeTree({ index: `export { ask } from './ask.mjs';\nimport { ask } from './ask.mjs';\nexport const nodes = { '${T('ask')}': ask };\n`, nodes: [{ typeId: T('ask'), role: 'side-effect' }] });
    expect(classifyNodeReach(T('ask'), buildImplIndex(root)).kind).toBe('invocation-log');
  });

  it('S13: a bare specifier is never followed — even when a same-named file sits in the pack', () => {
    writeTree({
      index: `import { ask } from 'helper.mjs';\nexport const nodes = { '${T('ask')}': ask };\n`,
      nodes: [{ typeId: T('ask'), role: 'side-effect' }],
      files: { 'helper.mjs': 'export async function ask(ctx) { return ctx.callAI({}); }\n' },
    });
    expect(classifyNodeReach(T('ask'), buildImplIndex(root)).kind).toBe('unresolved');
    const index = join(root, 'packs', KEY, 'index.mjs');
    expect(resolveImportedBinding(index, "import { x } from 'node:fs';", 'x', join(root, 'packs', KEY))).toBeNull();
  });

  it('S13: a relative path that ESCAPES the pack dir is never followed', () => {
    writeTree({ index: `import { ask } from '../outside.mjs';\nexport const nodes = { '${T('ask')}': ask };\n`, nodes: [{ typeId: T('ask'), role: 'side-effect' }] });
    writeFileSync(join(root, 'packs', 'outside.mjs'), 'export async function ask(ctx) { return ctx.callAI({}); }\n');
    expect(classifyNodeReach(T('ask'), buildImplIndex(root)).kind).toBe('unresolved');
  });

  it('S13: a symlink inside the pack that points OUTSIDE it is never followed', () => {
    writeTree({ index: `import { ask } from './link.mjs';\nexport const nodes = { '${T('ask')}': ask };\n`, nodes: [{ typeId: T('ask'), role: 'side-effect' }], files: {} });
    writeFileSync(join(root, 'outside.mjs'), 'export async function ask(ctx) { return ctx.callAI({}); }\n');
    symlinkSync(join(root, 'outside.mjs'), join(root, 'packs', KEY, 'link.mjs'));
    expect(classifyNodeReach(T('ask'), buildImplIndex(root)).kind).toBe('unresolved');
  });
});
