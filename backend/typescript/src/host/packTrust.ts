/**
 * Pack trust tier (ADR 0555 P0) — the SOLE authority on whether a pack's code
 * may execute in this host process.
 *
 * `packs/tarballLoader.ts` and `packs/agentLoader.ts` CALL this module. Neither
 * re-derives a tier, and nothing else may either: two opinions about whether
 * code is trusted is strictly worse than one, because they drift silently and
 * the permissive one wins.
 *
 * ── THE WORD "UNTRUSTED" ALREADY MEANS TWO OTHER THINGS HERE ──────────────
 *
 * Do not grep for it and assume you found this. Pre-existing and unrelated:
 *
 *   `contentTrust: 'trusted' | 'untrusted'`  — prompt-injection fencing of text
 *      entering a model context (`host/promptInjectionGuard.ts`,
 *      `host/toModelToolResult.ts`, `host/agentKnowledgeComposition.ts`).
 *   `trustBoundary: 'untrusted'`             — run metadata marking a run whose
 *      input came from an external MCP peer (`host/mcpServerRouter.ts`).
 *
 * Neither says anything about pack CODE provenance. This module's values are
 * always reached through `PackTrustTier`, never as bare strings, so the three
 * concepts stay distinguishable. (Also deliberately avoided: "quarantine",
 * which ADR 0550 P1 already spent on the conformance scenario set.)
 *
 * ── THE FOUR TIERS AND THEIR EVIDENCE ─────────────────────────────────────
 *
 *   steward           `packs/.steward-manifest.json` carries this pack dir and
 *                     its content digest matches. Attestation BY REPO — see the
 *                     generator's header for why that is the right boundary for
 *                     this tier and why it is weaker than signing.
 *   operator-trusted  `.openwop-installed.json` present and its `contentHashes`
 *                     re-verify. Install-time SRI + Ed25519 already passed.
 *   untrusted         Neither. Unsigned, unknown publisher, hand-dropped, or an
 *                     attestation that FAILED. Not dispatchable.
 *   revoked           An operator revocation row. Never dispatchable, and it
 *                     WINS over both trusted tiers.
 *
 * ── NO DEPLOYMENT POSTURE, AND THAT IS DELIBERATE ─────────────────────────
 *
 * ADR 0555 frames the policy as a "production posture". There is no deployment-
 * profile helper in this codebase to hang that on, and inventing an
 * `OPENWOP_PACK_TRUST_ENFORCE` flag would make the phase vacuous the moment it
 * defaulted off — a security gate nobody turns on is a security gate that
 * cannot fail.
 *
 * It is unnecessary anyway. Refusing to execute a pack that is neither
 * repo-attested nor signature-verified is correct in EVERY posture: that pack
 * is unknown code by definition. Under the steward manifest a normal dev, CI, or
 * production boot classifies every vendored pack `steward`, so the policy is
 * default-ON and breaks nothing. That is what makes the deny path testable —
 * drop an unattested directory into the pack dir and dispatch must refuse.
 *
 * The one escape hatch, `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED`, does NOT
 * reclassify: the pack stays `untrusted` in every report, log, and read
 * surface, and only the dispatch decision relaxes. ADR 0555's rule — "no
 * environment flag may promote an unsigned pack to trusted" — survives
 * verbatim, because nothing is promoted. It is a break-glass, not a dev
 * default; `pack-trust-config.test.ts` pins that no shipped config sets it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from './_repoPath.js';
import { packContentDigest, verifyContentHashes } from '../packs/packContentDigest.js';
import { isPackRevoked, revocationKey } from './packRevocations.js';
import { loadPinnedKeyring } from './packSignature.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.packTrust');

const INSTALL_MARKER = '.openwop-installed.json';
const STEWARD_MANIFEST = '.steward-manifest.json';

export type PackTrustTier = 'steward' | 'operator-trusted' | 'untrusted' | 'revoked';

/** Why a pack landed in its tier. Stable strings — they reach logs and Operations. */
export type PackTrustReason =
  | 'steward_manifest_digest_match'
  | 'install_marker_verified'
  | 'revoked_by_operator'
  | 'manifest_unreadable'
  | 'install_marker_tampered'
  | 'no_attestation';

export interface PackTrustVerdict {
  tier: PackTrustTier;
  reason: PackTrustReason;
  packName: string;
  version: string | null;
  /** The decision the loaders act on. Never infer this from `tier` at a call
   *  site — the allow-unsigned break-glass makes them legitimately disagree. */
  dispatchable: boolean;
  /** Set only when `dispatchable` is true despite an untrusted tier. */
  allowedByBreakGlass?: true;
  /** Extra detail for `install_marker_tampered` (which file). */
  detail?: string;
}

// ── steward manifest ───────────────────────────────────────────────────────

interface StewardManifest {
  version: number;
  packs: Record<string, { version: string | null; files: number; digest: string }>;
}

let manifestCache: StewardManifest | null | undefined;

/**
 * Locate + read `packs/.steward-manifest.json`.
 *
 * Resolved by walking up from THIS MODULE's own location — never from
 * `OPENWOP_LOCAL_PACKS_DIR`. That is the whole point: the env var can move
 * which directories get mounted, but it must not be able to move which
 * attestation file we believe. Anchoring on the code's own path anchors on the
 * artifact, which is exactly what "covered by release provenance" means.
 *
 * Absent or unparseable ⇒ `null` ⇒ nothing is steward. Fails CLOSED.
 */
function stewardManifest(): StewardManifest | null {
  if (manifestCache !== undefined) return manifestCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const packsDir = locateRepoDir(here, 'packs', STEWARD_MANIFEST);
    const parsed = JSON.parse(readFileSync(join(packsDir, STEWARD_MANIFEST), 'utf-8')) as StewardManifest;
    manifestCache = parsed && typeof parsed === 'object' && parsed.packs ? parsed : null;
  } catch {
    manifestCache = null;
  }
  if (manifestCache === null) {
    log.error(
      'steward manifest not found or unreadable — NO pack can be steward-attested; '
        + 'every vendored pack will be untrusted and will not dispatch (ADR 0555 P0 fails closed). '
        + 'Regenerate with `node scripts/gen-steward-manifest.mjs`.',
    );
  }
  return manifestCache;
}

// ── revocation: TWO sources, ONE question ──────────────────────────────────

/**
 * `host/packSignature.ts` (ADR 0367) already carried a revocation list before
 * this module existed: `OPENWOP_TRUSTED_PACK_REVOCATIONS`, a JSON array of
 * `name@version` strings loaded into `PinnedKeyring.revoked` and consulted by
 * `verifyPinned()` for workflow-CHAIN packs. It uses exactly the key format
 * `packRevocations.ts` uses.
 *
 * (ADR 0555 CORRECTION 1 said "there is no trust tier at all". That was too
 * strong and is amended in the ADR: no `steward`/`operator-trusted` tier
 * existed for EXECUTABLE packs, but a `trusted | failed | revoked | unsigned`
 * verdict vocabulary did exist for chain packs, revocation included.)
 *
 * These are not redundant — the keyring list is static operator config baked
 * into a deployment, the durable store is a runtime action that propagates
 * across instances — but they ARE two sources of truth for one question, which
 * is the condition under which two answers drift and the permissive one wins.
 * So this function is the single place either is read for executable packs, and
 * a hit in EITHER revokes.
 *
 * The keyring is memoised: `loadPinnedKeyring()` does filesystem reads and this
 * sits on the pack-load path.
 */
let keyringRevokedCache: ReadonlySet<string> | undefined;

function keyringRevoked(): ReadonlySet<string> {
  if (keyringRevokedCache === undefined) {
    try {
      keyringRevokedCache = loadPinnedKeyring().revoked;
    } catch {
      // `loadPinnedKeyring` already fails closed internally; an unexpected
      // throw here must not read as "nothing is revoked".
      keyringRevokedCache = new Set<string>();
      log.error('pinned keyring revocation list could not be read; relying on the durable store alone');
    }
  }
  return keyringRevokedCache;
}

function revokedByEitherSource(packName: string, version: string | null): boolean {
  if (isPackRevoked(packName, version)) return true;
  if (version === null) return false;
  return keyringRevoked().has(revocationKey(packName, version));
}

/** Test-only: drop the memoised manifest + verdicts + keyring revocations. */
export function __resetPackTrustCachesForTests(): void {
  manifestCache = undefined;
  keyringRevokedCache = undefined;
  verdictCache.clear();
}

// ── policy ─────────────────────────────────────────────────────────────────

/** Break-glass: permit dispatch of untrusted packs WITHOUT reclassifying them. */
function breakGlassEnabled(): boolean {
  return process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED === 'true';
}

/** The tiers whose code this host will execute. */
export function tierIsTrusted(tier: PackTrustTier): boolean {
  return tier === 'steward' || tier === 'operator-trusted';
}

// ── classification ─────────────────────────────────────────────────────────

/**
 * Memoised per directory. A boot classifies the same directory from both the
 * node path and the agent path, and the digest walks the whole pack tree.
 *
 * The memo is keyed by directory and deliberately NOT invalidated on file
 * change: a pack whose bytes change under a running process is precisely the
 * case the install marker's re-verification exists to catch, and re-hashing on
 * every dispatch would put a full tree walk on the hot path. Restart is the
 * boundary, same as every other pack-loading decision in this host.
 */
const verdictCache = new Map<string, PackTrustVerdict>();

function readPackIdentity(packDir: string): { name: string; version: string | null } | null {
  try {
    const m = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof m.name !== 'string' || m.name.length === 0) return null;
    return { name: m.name, version: typeof m.version === 'string' ? m.version : null };
  } catch {
    return null;
  }
}

function finish(v: Omit<PackTrustVerdict, 'dispatchable' | 'allowedByBreakGlass'>): PackTrustVerdict {
  if (tierIsTrusted(v.tier)) return { ...v, dispatchable: true };
  // `revoked` is never break-glassable. A revocation is a security action
  // against code believed compromised; an env var must not undo it, or the
  // remediation is only as strong as the deployment config.
  if (v.tier === 'revoked') return { ...v, dispatchable: false };
  if (breakGlassEnabled()) {
    log.warn('untrusted pack permitted to dispatch by OPENWOP_PACK_TRUST_ALLOW_UNSIGNED break-glass', {
      pack: v.packName,
      version: v.version,
      reason: v.reason,
    });
    return { ...v, dispatchable: true, allowedByBreakGlass: true };
  }
  return { ...v, dispatchable: false };
}

/**
 * Classify a pack directory. `packDir` may be a symlink (every dev-mounted pack
 * is one) — we digest the content the loader would actually import.
 */
export function classifyPackDir(packDir: string, opts?: { noCache?: boolean }): PackTrustVerdict {
  if (!opts?.noCache) {
    const hit = verdictCache.get(packDir);
    if (hit) return hit;
  }
  const verdict = classifyUncached(packDir);
  if (!opts?.noCache) verdictCache.set(packDir, verdict);
  return verdict;
}

function classifyUncached(packDir: string): PackTrustVerdict {
  const identity = readPackIdentity(packDir);
  if (!identity) {
    // No readable manifest: we cannot even name this thing, let alone trust it.
    return finish({
      tier: 'untrusted',
      reason: 'manifest_unreadable',
      packName: packDir,
      version: null,
    });
  }
  const { name, version } = identity;

  // Revocation wins over every attestation, from EITHER source.
  if (revokedByEitherSource(name, version)) {
    return finish({ tier: 'revoked', reason: 'revoked_by_operator', packName: name, version });
  }

  // Install marker first: cheap (two files) and signature-backed.
  const markerPath = join(packDir, INSTALL_MARKER);
  if (existsSync(markerPath)) {
    let hashes: Record<string, string> | null = null;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        contentHashes?: Record<string, string>;
      };
      hashes = marker.contentHashes && typeof marker.contentHashes === 'object' ? marker.contentHashes : null;
    } catch {
      hashes = null;
    }
    const failure = hashes === null ? 'marker_invalid' : verifyContentHashes(packDir, hashes);
    if (failure === null) {
      return finish({ tier: 'operator-trusted', reason: 'install_marker_verified', packName: name, version });
    }
    // A tampered install is NOT rescued by a coincidental steward match. Report
    // the tamper — falling through would hide the more serious finding behind
    // the more benign one.
    return finish({
      tier: 'untrusted',
      reason: 'install_marker_tampered',
      packName: name,
      version,
      detail: failure,
    });
  }

  const manifest = stewardManifest();
  const attested = manifest?.packs?.[basenameOf(packDir)];
  if (attested && attested.digest === packContentDigest(packDir)) {
    return finish({ tier: 'steward', reason: 'steward_manifest_digest_match', packName: name, version });
  }

  return finish({ tier: 'untrusted', reason: 'no_attestation', packName: name, version });
}

/** The manifest is keyed by pack DIRECTORY name, which is how both the mount
 *  and the installer name things on disk. */
function basenameOf(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const at = trimmed.lastIndexOf('/');
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/**
 * Every verdict computed so far, for the Operations surface and readiness.
 *
 * This is a view over what has been CLASSIFIED, not over what exists on disk —
 * node packs classify lazily on first resolution. The agent path eager-loads at
 * boot, so in practice most packs are present after startup.
 */
export function classifiedPackVerdicts(): readonly PackTrustVerdict[] {
  return Array.from(verdictCache.values());
}

export interface PackTrustSummary {
  steward: number;
  operatorTrusted: number;
  untrusted: number;
  revoked: number;
  /** Untrusted packs currently executing only because of the break-glass. */
  breakGlassed: number;
  /** True when the steward manifest could not be read at all. */
  stewardManifestMissing: boolean;
}

export function packTrustSummary(): PackTrustSummary {
  const s: PackTrustSummary = {
    steward: 0,
    operatorTrusted: 0,
    untrusted: 0,
    revoked: 0,
    breakGlassed: 0,
    stewardManifestMissing: stewardManifest() === null,
  };
  for (const v of verdictCache.values()) {
    if (v.tier === 'steward') s.steward += 1;
    else if (v.tier === 'operator-trusted') s.operatorTrusted += 1;
    else if (v.tier === 'revoked') s.revoked += 1;
    else s.untrusted += 1;
    if (v.allowedByBreakGlass) s.breakGlassed += 1;
  }
  return s;
}
