/**
 * WF-DUP-1 (WORKFLOWS-ASSESSMENT) — the loader's same-pack duplicate-shadow policy
 * keeps the FIRST-loaded root's copy (roots iterate in precedence order) and quietly
 * info-logs the shadow. That is correct for the vendored-twin case, but a SAME-VERSION
 * shadow with DIFFERENT content means the copies drifted without a version bump (a
 * stale installed pack silently shadowing the updated in-repo copy on a dev machine).
 * The loader must WARN (`workflow_chain_pack_duplicate_content_drift`) on that state
 * while keeping the precedence winner — never an error, never a behavior change.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadWorkflowChainPacks,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SEED_PACK = join(REPO_ROOT, 'examples', 'workflow-chain-packs', 'kicktodo-challenge-factory', 'pack.json');

const scratch = mkdtempSync(join(tmpdir(), 'owp-dup-drift-'));
const rootA = join(scratch, 'rootA');
const rootB = join(scratch, 'rootB');

type SeedManifest = { version: string; chains: Array<{ description: string; version: string; chainId: string }> };

function seedRoots(
  mutateB?: (manifest: SeedManifest) => void,
  mutateA?: (manifest: SeedManifest) => void,
): void {
  const manifest = JSON.parse(readFileSync(SEED_PACK, 'utf8'));
  for (const [root, mutate] of [[rootA, mutateA], [rootB, mutateB]] as const) {
    const dir = join(root, 'seed-pack');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const copy = JSON.parse(JSON.stringify(manifest));
    mutate?.(copy);
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(copy, null, 2));
  }
}

function loadCapturingStdout(): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const { errors } = loadWorkflowChainPacks({ roots: [rootA, rootB] });
    expect(errors).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

function bumpPatch(v: string): string {
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  return `${maj}.${min}.${(pat ?? 0) + 1}`;
}

beforeEach(() => _resetChainRegistryForTest());
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('WF-DUP-1 — same-pack duplicate content-drift detection', () => {
  it('identical same-version twins shadow quietly (info, no drift warn)', () => {
    seedRoots();
    const out = loadCapturingStdout();
    expect(out).toContain('workflow_chain_pack_duplicate_shadowed');
    expect(out).not.toContain('workflow_chain_pack_duplicate_content_drift');
  });

  it('ADR 0713 OQ5 — same PACK version, but the shadowed copy has a HIGHER chain version: the newer chain wins', () => {
    // The 2026-09-17 incident shape: registry approvals 1.0.4 (chains @1.0.0, ungated)
    // shadowed vendored approvals 1.0.4 (chains @1.0.1, gated) because only the pack
    // version was compared.
    seedRoots((m) => {
      m.chains[0].description = 'NEWER chain in the lower-precedence root';
      m.chains[0].version = bumpPatch(m.chains[0].version);
    });
    const out = loadCapturingStdout();
    expect(out).toContain('workflow_chain_pack_duplicate_chain_upgraded');
    const manifest = JSON.parse(readFileSync(SEED_PACK, 'utf8'));
    const kept = getChain(manifest.chains[0].chainId);
    expect(kept?.chain.description).toBe('NEWER chain in the lower-precedence root');
    expect(kept?.chain.version).toBe(bumpPatch(manifest.chains[0].version));
  });

  it('ADR 0713 OQ5 — a LOWER chain version in the shadowed copy does not win (precedence keep + drift warn)', () => {
    seedRoots(undefined, (m) => {
      m.chains[0].description = 'NEWER chain in the higher-precedence root';
      m.chains[0].version = bumpPatch(m.chains[0].version);
    });
    const out = loadCapturingStdout();
    expect(out).not.toContain('workflow_chain_pack_duplicate_chain_upgraded');
    expect(out).toContain('workflow_chain_pack_duplicate_content_drift');
    const manifest = JSON.parse(readFileSync(SEED_PACK, 'utf8'));
    expect(getChain(manifest.chains[0].chainId)?.chain.description).toBe('NEWER chain in the higher-precedence root');
  });

  it('a same-version shadow with DRIFTED content warns and keeps the precedence winner', () => {
    seedRoots((m) => { m.chains[0].description = 'DRIFTED copy — version not bumped'; });
    const out = loadCapturingStdout();
    expect(out).toContain('workflow_chain_pack_duplicate_content_drift');
    // The higher-precedence rootA copy wins — the drifted description never registers.
    const manifest = JSON.parse(readFileSync(SEED_PACK, 'utf8'));
    const kept = getChain(manifest.chains[0].chainId);
    expect(kept?.chain.description).toBe(manifest.chains[0].description);
  });

  it('a DIFFERENT-version shadow stays the quiet precedence path even when content differs', () => {
    seedRoots((m) => {
      (m as unknown as { version: string }).version = '0.0.1-stale';
      m.chains[0].description = 'older copy';
    });
    const out = loadCapturingStdout();
    expect(out).toContain('workflow_chain_pack_duplicate_shadowed');
    expect(out).not.toContain('workflow_chain_pack_duplicate_content_drift');
  });
});

/**
 * WF-DUP-2 — precedence alone is not a safe tie-break. Root order puts the
 * registry-install dir ABOVE `examples/`, so an OLDER installed copy shadowed a
 * NEWER in-tree one and said so only at `info`. Measured on a real host:
 * `~/.openwop-packs/core.openwop.workflows.exec-ops` at 1.1.0 shadowed the 1.2.0
 * copy this branch ships, so a fix to the `review → deliver` gate was INERT and
 * indistinguishable at the run boundary from a branch that never fired. The
 * ordering below is the one that protects all 16 registry-installed
 * `core.openwop.workflows.*` packs, not just the one that was caught.
 */
describe('WF-DUP-2 — duplicate resolution is version-aware', () => {
  const chainId = (JSON.parse(readFileSync(SEED_PACK, 'utf8')) as { chains: Array<{ chainId: string }> })
    .chains[0].chainId;

  it('a NEWER copy in a LOWER-precedence root wins, and the supersede is WARNed', () => {
    // rootA (higher precedence) = the stale registry copy; rootB = the newer in-tree copy.
    seedRoots(
      (m) => { m.version = '9.9.9'; m.chains[0].description = 'NEWER — the fix'; },
      (m) => { m.version = '1.0.0'; m.chains[0].description = 'OLDER — the stale install'; },
    );
    const out = loadCapturingStdout();
    expect(getChain(chainId)?.packVersion).toBe('9.9.9');
    expect(getChain(chainId)?.chain.description).toBe('NEWER — the fix');
    expect(out).toContain('workflow_chain_pack_duplicate_upgraded');
    // The supersede is never announced at `info` — that level is what hid WF-DUP-2.
    expect(out).toMatch(/"level":"warn"[^\n]*workflow_chain_pack_duplicate_upgraded|workflow_chain_pack_duplicate_upgraded[^\n]*"level":"warn"/);
  });

  it('the superseded copy stops being reported as installed for that chain', () => {
    seedRoots(
      (m) => { m.version = '9.9.9'; },
      (m) => { m.version = '1.0.0'; },
    );
    _resetChainRegistryForTest();
    const { installed } = loadWorkflowChainPacks({ roots: [rootA, rootB] });
    const owners = installed.filter((p) => p.chainIds.includes(chainId));
    expect(owners).toHaveLength(1);
    expect(owners[0].packVersion).toBe('9.9.9');
    // A pack left owning zero chains is not "installed" at all.
    expect(installed.some((p) => p.packVersion === '1.0.0')).toBe(false);
  });

  it('an OLDER copy in a lower root still loses quietly (no spurious upgrade)', () => {
    seedRoots(
      (m) => { m.version = '1.0.0'; },
      (m) => { m.version = '9.9.9'; },
    );
    const out = loadCapturingStdout();
    expect(getChain(chainId)?.packVersion).toBe('9.9.9');
    expect(out).not.toContain('workflow_chain_pack_duplicate_upgraded');
    expect(out).toContain('workflow_chain_pack_duplicate_shadowed');
  });

  it('an explicit operator-override root keeps its OLDER pin — but WARNs with both versions', () => {
    seedRoots(
      (m) => { m.version = '9.9.9'; },
      (m) => { m.version = '1.0.0'; },
    );
    const prev = process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
    process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = rootA;
    try {
      const out = loadCapturingStdout();
      expect(getChain(chainId)?.packVersion).toBe('1.0.0');
      expect(out).toContain('workflow_chain_pack_duplicate_older_kept');
      expect(out).toContain('operator_override_root');
      expect(out).toContain('9.9.9'); // the version it is NOT running is named
      expect(out).not.toContain('workflow_chain_pack_duplicate_upgraded');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
      else process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = prev;
    }
  });

  it('a PRERELEASE never supersedes the release of the same core (SemVer §11)', () => {
    seedRoots(
      (m) => { m.version = '2.0.0-rc.1'; },
      (m) => { m.version = '2.0.0'; },
    );
    const out = loadCapturingStdout();
    expect(getChain(chainId)?.packVersion).toBe('2.0.0');
    expect(out).not.toContain('workflow_chain_pack_duplicate_upgraded');
  });
});
