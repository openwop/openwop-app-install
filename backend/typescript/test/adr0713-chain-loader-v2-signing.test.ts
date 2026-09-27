/**
 * ADR 0713 Phase 1b — the chain-pack loader admits the v2 `signing` block that
 * `spec/v2/core/packs.md` §Signing requires and the registry publishes.
 *
 * MEASURED on production revision 00705 (2026-09-17): once the installer could
 * read v2 manifests, all 16 registry-installed chain packs installed and then
 * EVERY one was rejected by this loader — `workflow_chain_pack_manifest_invalid:
 * /signing must NOT have additional properties (keyId)` — because the corpus
 * chain-pack schema still carries the v1 `Signing` def. The vendored copies kept
 * serving, so nothing visible broke, and no registry chain pack could ever load.
 *
 * WHD-15 — that was first fixed by a workaround (`manifestForCorpusSchema`: check
 * the v2 block against the prose, strip it, validate the rest against v1). Corpus
 * tag v2.32.0 fixed the v2 schema, and the loader now routes a v2-shaped manifest
 * to it WHOLE; the workaround is deleted. The switch was decided by
 * `scripts/adr0713-whd15-chain-schema-routing.ts` (zero verdicts differ across the
 * in-tree + published-registry population), and the tests below pin what that
 * script cannot: that the v2 route is really the v2 SCHEMA, and that the schema
 * really does subsume the prose check the loader stopped running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  loadWorkflowChainPacks,
  getChain,
  chainManifestSchemaTree,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { manifestSigningKeyId } from '../src/packs/registryInstaller.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';

const V2_SIGNING = { keyId: 'openwop-team-1', scheme: 'ed25519-canonical-json' };
const V1_SIGNING = { publicKeyRef: 'keys/p.pem', signatureRef: 'p.sig', method: 'manual' };

/** Signing blocks the PROSE check (`manifestSigningKeyId(…, 'v2')`) refuses. The
 *  loader used to run that check itself; WHD-15 dropped it on the claim that the
 *  v2 schema refuses every one of these too. This table is that claim, pinned. */
const PROSE_REFUSED: Array<{ label: string; signing: Record<string, unknown> }> = [
  { label: 'no-keyid', signing: { scheme: 'ed25519-canonical-json' } },
  { label: 'empty-keyid', signing: { keyId: '', scheme: 'ed25519-canonical-json' } },
  { label: 'nonstring-keyid', signing: { keyId: 7, scheme: 'ed25519-canonical-json' } },
  { label: 'no-scheme', signing: { keyId: 'openwop-team-1' } },
  { label: 'wrong-scheme', signing: { keyId: 'openwop-team-1', scheme: 'ed25519' } },
  { label: 'v1-method', signing: { ...V2_SIGNING, method: 'manual' } },
  { label: 'v1-publickeyref', signing: { ...V2_SIGNING, publicKeyRef: 'keys/p.pem' } },
];

function chainPack(name: string, chainId: string, signing: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, version: '1.0.0', kind: 'workflow-chain', description: 'fixture',
    engines: { openwop: '>=1.0.0 <3.0.0' },
    ...extra,
    ...(signing === undefined ? {} : { signing }),
    chains: [{
      chainId, version: '1.0.0', label: 'Fixture', description: 'fixture',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      dag: { nodes: [{ id: 'noop', typeId: 'core.noop' }] },
    }],
  };
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'adr0713-chains-'));
  const write = (dir: string, manifest: Record<string, unknown>) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'pack.json'), JSON.stringify(manifest, null, 2));
  };
  write('v2-signed', chainPack('core.openwop.workflows.adr0713-v2', 'adr0713.v2-signed', V2_SIGNING));
  write('v2-bad-scheme', chainPack('core.openwop.workflows.adr0713-bad', 'adr0713.bad-scheme', { keyId: 'k', scheme: 'ed25519' }));
  write('v2-mixed', chainPack('core.openwop.workflows.adr0713-mixed', 'adr0713.mixed', { ...V2_SIGNING, method: 'manual' }));
  write('unsigned', chainPack('core.openwop.workflows.adr0713-unsigned', 'adr0713.unsigned', undefined));
  write('v1-signed', chainPack('core.openwop.workflows.adr0713-v1', 'adr0713.v1-signed', V1_SIGNING));
  write('v2-with-v1-block', chainPack('core.openwop.workflows.adr0713-v2v1', 'adr0713.v2-with-v1-block', { ...V2_SIGNING, ...V1_SIGNING }));
  // The four ROUTE WITNESSES — manifests on which the two schemas DISAGREE, so the
  // verdict names the schema that judged them. `engines` is open in v1 and closed
  // in v2; an `openwop-` extension key is admitted by v2 and refused by v1.
  const OPEN_ENGINES = { engines: { openwop: '>=1.0.0 <3.0.0', node: '>=20' } };
  const OPENWOP_EXT = { 'openwop-note': 'a v2-only extension prefix' };
  write('v2-open-engines', chainPack('core.openwop.workflows.adr0713-w1', 'adr0713.v2-open-engines', V2_SIGNING, OPEN_ENGINES));
  write('v2-openwop-ext', chainPack('core.openwop.workflows.adr0713-w2', 'adr0713.v2-openwop-ext', V2_SIGNING, OPENWOP_EXT));
  write('unsigned-open-engines', chainPack('core.openwop.workflows.adr0713-w3', 'adr0713.unsigned-open-engines', undefined, OPEN_ENGINES));
  write('unsigned-openwop-ext', chainPack('core.openwop.workflows.adr0713-w4', 'adr0713.unsigned-openwop-ext', undefined, OPENWOP_EXT));
  for (const { label, signing } of PROSE_REFUSED) {
    write(`prose-${label}`, chainPack(`core.openwop.workflows.adr0713-prose-${label}`, `adr0713.prose-${label}`, signing));
  }
  _resetChainRegistryForTest();
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); _resetChainRegistryForTest(); });

describe('ADR 0713 Phase 1b — chain-pack loader and the v2 signing block', () => {
  it('loads a chain pack whose pack.json carries the v2 { keyId, scheme } block', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e.code]));
    expect(byPack['v2-signed'], JSON.stringify(errors)).toBeUndefined();
    expect(getChain('adr0713.v2-signed')?.packName).toBe('core.openwop.workflows.adr0713-v2');
    expect(getChain('adr0713.unsigned')?.packName, 'no signing block still loads').toBe('core.openwop.workflows.adr0713-unsigned');
  });

  it('still refuses a v2 block with the wrong scheme, or one carrying a v1 field', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    expect(byPack['v2-bad-scheme']?.code).toBe('workflow_chain_pack_manifest_invalid');
    expect(byPack['v2-mixed']?.code).toBe('workflow_chain_pack_manifest_invalid');
    expect(getChain('adr0713.bad-scheme')).toBeNull();
  });

  it('still refuses a v1 block riding on a v2-shaped pack', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    expect(byPack['v2-with-v1-block']?.code).toBe('workflow_chain_pack_manifest_invalid');
    expect(getChain('adr0713.v2-with-v1-block')).toBeNull();
  });

  it('a v1 block, or none, still goes to the v1 schema — unchanged', () => {
    expect(chainManifestSchemaTree(chainPack('x', 'y', V1_SIGNING))).toBe('v1');
    expect(chainManifestSchemaTree(chainPack('x', 'y', undefined))).toBe('v1');
    expect(chainManifestSchemaTree(chainPack('x', 'y', V2_SIGNING))).toBe('v2');
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    expect(errors.find((e) => e.pack === 'v1-signed'), JSON.stringify(errors)).toBeUndefined();
    expect(getChain('adr0713.v1-signed')?.packName).toBe('core.openwop.workflows.adr0713-v1');
  });

  // ── WHD-15 — the loader accepts a v2-signed pack THROUGH the v2 schema ────────
  //
  // "It loads" cannot show that: the workaround this replaced ALSO loaded the
  // `v2-signed` fixture, by stripping the block and asking v1. What names the
  // schema is a manifest the two schemas DISAGREE on. Each witness below has one
  // verdict under v2 and the opposite under strip-and-v1, in BOTH directions, and
  // the unsigned twins pin that the v1 route did not move.
  it('WHD-15 — a v2-signed pack is judged by the v2 schema, an unsigned one still by v1', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));

    // v2 CLOSES `engines`; strip-and-v1 admitted this pack.
    expect(byPack['v2-open-engines']?.code, 'a v2-signed pack with an extra `engines` key loaded — it was NOT judged by the v2 schema').toBe('workflow_chain_pack_manifest_invalid');
    expect(byPack['v2-open-engines']?.message).toContain('/engines');
    expect(getChain('adr0713.v2-open-engines')).toBeNull();
    // v2 ADMITS the `openwop-` extension prefix; strip-and-v1 refused this pack.
    expect(byPack['v2-openwop-ext'], `a v2-signed pack with an openwop- extension key was refused — it was NOT judged by the v2 schema: ${byPack['v2-openwop-ext']?.message}`).toBeUndefined();
    expect(getChain('adr0713.v2-openwop-ext')?.packName).toBe('core.openwop.workflows.adr0713-w2');

    // …and the SAME two bodies, unsigned, get v1's opposite verdicts.
    expect(byPack['unsigned-open-engines'], 'an unsigned pack was routed away from the v1 schema').toBeUndefined();
    expect(getChain('adr0713.unsigned-open-engines')?.packName).toBe('core.openwop.workflows.adr0713-w3');
    expect(byPack['unsigned-openwop-ext']?.code, 'an unsigned pack was routed away from the v1 schema').toBe('workflow_chain_pack_manifest_invalid');
    expect(getChain('adr0713.unsigned-openwop-ext')).toBeNull();
  });

  it('WHD-15 — every block the prose check refused, the v2 schema refuses too (why the loader no longer runs it)', () => {
    // The premise, first: these really ARE the blocks `manifestSigningKeyId` throws
    // on. Without this half the table could drift into blocks the prose admits and
    // the assertion below would go on passing about nothing.
    for (const { label, signing } of PROSE_REFUSED) {
      expect(() => manifestSigningKeyId(signing, 'v2'), label).toThrow(/pack_signature_unverifiable/);
    }
    expect(PROSE_REFUSED).toHaveLength(7);
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    for (const { label } of PROSE_REFUSED) {
      expect(byPack[`prose-${label}`]?.code, `prose-${label} loaded`).toBe('workflow_chain_pack_manifest_invalid');
      expect(byPack[`prose-${label}`]?.message, `prose-${label} was refused, but not over its signing block`).toContain('/signing');
      expect(getChain(`adr0713.prose-${label}`)).toBeNull();
    }
  });

  // ── The corpus fact the routing STANDS ON (2026-09-21, suite 2.32.0 bump) ────
  //
  // History, because it explains why this is aimed where it is: the first tripwire
  // here compiled the ROOT (v1) schema and asserted it rejects `keyId`. A v1
  // `Signing` def is closed by design and always will be, and the corpus fix
  // (openwop#1367) landed in `schemas/v2/` — so that tripwire could never fire, and
  // MEASURED on the bump that carried the fix, it did not. It was then split into
  // two facts: FACT 1 below, and a FACT 2 pinning the RESIDUE ("the schema the
  // LOADER reads still rejects the v2 block, so `manifestForCorpusSchema` is
  // load-bearing"). WHD-15 routed v2-shaped manifests to the v2 schema and deleted
  // that function, so FACT 2 is retired — not by deleting the question, but by the
  // route-witness test above, which asserts the positive form of it.
  //
  // FACT 1 stays: it is now the PREMISE of the loader, not a tripwire beside it. If
  // a corpus bump re-closes the v2 `Signing` def, every registry v2 chain pack
  // fails at the loader again — and this is the test that says why.
  function compileChainSchema(dir: string) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const target = JSON.parse(readFileSync(join(dir, 'workflow-chain-pack-manifest.schema.json'), 'utf8')) as { $id?: string };
    // The v2 schema $refs its siblings (`ids.schema.json#/$defs/chainId`), so they
    // must be registered or the compile throws MissingRefError.
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.schema.json')) continue;
      const sch = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { $id?: string };
      if (sch.$id && sch.$id !== target.$id) { try { ajv.addSchema(sch); } catch { /* duplicate $id — not this test's business */ } }
    }
    return ajv.compile(target);
  }
  const rootSchemasDir = (): string =>
    locateRepoSchemasDir(join(import.meta.dirname, '..', 'src', 'host'), 'workflow-chain-pack-manifest.schema.json');

  it('FACT 1 — the corpus v2 schema NOW admits { keyId, scheme } (openwop#1367, vendored at v2.32.0)', () => {
    const validate = compileChainSchema(join(rootSchemasDir(), 'v2'));
    const ok = validate(chainPack('core.openwop.workflows.adr0713-v2', 'adr0713.v2-signed', V2_SIGNING));
    expect(ok, `the vendored v2 chain-pack schema rejects the v2 signing block again: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    // …and it is closed the right way round: the v1 block is what it refuses.
    expect(validate(chainPack('x', 'y', { publicKeyRef: 'keys/p.pem', signatureRef: 'p.sig', method: 'manual' }))).toBe(false);
  });
});
