/**
 * SemVer §11 precedence comparison — the ONE implementation every pack loader
 * shares.
 *
 * Extracted from `features/connections/connectionPackLoader.ts` (whose private
 * copy this replaces) when `host/workflowChainPackLoader.ts` needed the same
 * ordering to resolve a duplicate `chainId` across pack roots. A third private
 * copy is exactly how the two loaders would drift on prerelease handling — the
 * subtlety that makes this worth sharing is that a PRE-RELEASE is LOWER than its
 * release (`1.0.0-alpha.1 < 1.0.0`), so a prerelease pack must never silently
 * supersede a release of the same core.
 *
 * NOTE: `bootstrap/mountLocalPacks.ts` keeps a deliberately weaker core-only
 * compare — it decides whether to re-point a symlink, not which pack a host
 * runs, and it is documented there as best-effort.
 */

/** Split a version into `[core, prerelease]`, dropping build metadata.
 *  Splits on the FIRST hyphen only — a prerelease tag may itself contain
 *  hyphens (`1.0.0-x-y` → pre `x-y`); `String.split('-', 2)` would truncate. */
function splitPre(s: string): [string, string] {
  const v = s.split('+')[0];
  const i = v.indexOf('-');
  return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
}

/** SemVer §11 precedence: >0 if `a > b`, <0 if `a < b`, 0 if equal. */
export function semverCompare(a: string, b: string): number {
  const [coreA, preA] = splitPre(a);
  const [coreB, preB] = splitPre(b);
  const na = coreA.split('.').map((n) => parseInt(n, 10) || 0);
  const nb = coreB.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) > (nb[i] ?? 0) ? 1 : -1;
  }
  // Equal core. No-prerelease outranks a prerelease.
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  // Both prerelease — compare dot identifiers (numeric < alphanumeric; SemVer §11.4).
  const ia = preA.split('.');
  const ib = preB.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1; // shorter prerelease set is lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { const d = parseInt(x, 10) - parseInt(y, 10); if (d !== 0) return d > 0 ? 1 : -1; }
    else if (xn) return -1; // numeric identifiers have lower precedence than alphanumeric
    else if (yn) return 1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** SemVer §11 precedence: `a >= b`. */
export function semverGte(a: string, b: string): boolean {
  return semverCompare(a, b) >= 0;
}
