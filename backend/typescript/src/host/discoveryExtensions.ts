/**
 * v2 discovery EXTENSION records (RFC 0169 §A.4; `spec/v2/declaration.json`
 * `extensionsKeyPattern` + `reservedOrgs`). A feature that owns a vendor surface
 * registers `<org>.<name>` → a record FUNCTION; `buildV2Advertisement` merges the
 * live records under `extensions` at request time, so a record can reflect the
 * current toggle/entitlement state instead of a boot-time snapshot. The key
 * pattern and the reserved orgs are enforced here so a typo or a reserved org can
 * never reach the wire. Host-agnostic: nothing here knows any adopter's domain.
 */

import { reservedOrgs } from './specDeclaration.js';

/** `spec/v2/declaration.json#extensionsKeyPattern` (pinned corpus). */
export const V2_EXTENSION_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/**
 * `spec/v2/declaration.json#reservedOrgs`, READ from the file rather than
 * mirrored into a literal.
 *
 * It used to be `new Set(['openwop', 'vendor'])` and it had DRIFTED: the pinned
 * file carries `["openwop","vendor","effect-seams","events"]`, so this accepted
 * `effect-seams.*` and `events.*` — two orgs the corpus reserves — and nothing
 * could see it, because a literal mirror has no failure mode. It just disagrees
 * quietly at the next pin bump. See `host/specDeclaration.ts` (ADR 0687).
 */
export function v2ReservedOrgs(): ReadonlySet<string> { return reservedOrgs(); }

export type V2ExtensionRecord = () => Record<string, unknown>;
const records = new Map<string, V2ExtensionRecord>();

export function registerV2Extension(key: string, record: V2ExtensionRecord): void {
  if (!V2_EXTENSION_KEY.test(key)) throw new Error(`registerV2Extension: "${key}" does not match the v2 extensions key pattern <org>.<name> (lowercase, hyphenated).`);
  const org = key.slice(0, key.indexOf('.'));
  if (v2ReservedOrgs().has(org)) throw new Error(`registerV2Extension: org "${org}" is reserved (spec/v2/declaration.json reservedOrgs) — use your own organization.`);
  if (typeof record !== 'function') throw new Error('registerV2Extension: the record must be a function so it reflects live state.');
  records.set(key, record);
}
/** Live records, evaluated now. A record that throws is OMITTED (never a half-advertised claim) and reported via the returned `failed` list. */
export function v2Extensions(): { extensions: Record<string, Record<string, unknown>>; failed: string[] } {
  const extensions: Record<string, Record<string, unknown>> = {}; const failed: string[] = [];
  for (const [key, fn] of records) { try { extensions[key] = fn(); } catch { failed.push(key); } }
  return { extensions, failed };
}
export function listV2ExtensionKeys(): string[] { return [...records.keys()].sort(); }
export function __resetV2Extensions(): void { records.clear(); }
