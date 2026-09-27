/**
 * The ONE reader of the vendored `schemas/v2/declaration.json`.
 *
 * RFC 0169 §B — "the one declaration file". It is the corpus's sole registrar
 * for vendor orgs (RFC 0180 §A), the authority for peer-dependency family keys,
 * and the source of the reserved-org list and the extensions key pattern.
 *
 * **Why this module exists (ADR 0687 § Finding 2).** Before it, three call sites
 * had three different relationships to that one file: `packManifestV2Gate`
 * loaded it for `families[].key`, `storage/eventEra` was about to load it again
 * for `extensions`, and `host/discoveryExtensions` did not load it at all — it
 * hand-copied `reservedOrgs` and `extensionsKeyPattern` as literals.
 *
 * The hand copy had **already drifted**, and nothing could see it: the literal
 * read `{openwop, vendor}` while the pinned file carries
 * `["openwop","vendor","effect-seams","events"]`, so `registerV2Extension`
 * would have accepted `effect-seams.*` and `events.*` — two orgs the corpus
 * reserves. A mirror of a pinned artifact is a second source of truth with no
 * failure mode; it just disagrees quietly at the next pin bump.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from './_repoPath.js';

interface DeclarationDoc {
  extensions?: Record<string, unknown>;
  reservedOrgs?: unknown;
  extensionsKeyPattern?: unknown;
  families?: Array<{ key?: unknown }>;
}

let cached: DeclarationDoc | null = null;

/** The raw document, read once. */
export function declaration(): DeclarationDoc {
  if (cached !== null) return cached;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json');
  cached = JSON.parse(readFileSync(join(dir, 'v2', 'declaration.json'), 'utf8')) as DeclarationDoc;
  return cached;
}

/**
 * Orgs registered under `extensions` (RFC 0180 §A).
 *
 * Exported as a pure function of the doc so the refusal below has a witness
 * that does not need a doctored file on disk.
 */
export function orgsFromDeclaration(doc: DeclarationDoc): ReadonlySet<string> {
  const orgs = Object.keys(doc.extensions ?? {});
  if (orgs.length === 0) {
    // Fail LOUD, for the reason `declaredPeerDependencyKeys` already wrote down
    // about this same file: an empty set is not "no org is registered", it is
    // "the registry is unreadable", and letting it read as the former refuses
    // EVERY vendor type at contract 2 — silently, and as a side effect of a
    // corpus pin rather than of any change in this repo. That is the failure
    // ADR 0687's Sabotage B produces deliberately.
    //
    // An empty `extensions` is never legitimate: the corpus keeps `example`
    // registered precisely so the positive half of the vendor rule is drivable.
    throw new Error(
      'spec/v2/declaration.json carried no extensions[] orgs — the vendor-org registry is unreadable',
    );
  }
  // `example` stays IN, despite `reserved: true` / "never assignable to a real
  // vendor". Filtering reserved orgs looks principled and reds the lane: the
  // corpus's own control leg seeds `example.thing-happened` and requires it to
  // pass through. Reserved means no real vendor may be ASSIGNED it, not that it
  // is unregistered.
  return new Set(orgs);
}

/** Orgs no adopter may claim (`reservedOrgs`). */
export function reservedOrgs(): ReadonlySet<string> {
  const raw = declaration().reservedOrgs;
  const orgs = Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
  if (orgs.length === 0) {
    // Same shape as above, opposite direction: an empty reserved list reads as
    // "nothing is reserved" and would let an adopter register `openwop.*`.
    throw new Error('spec/v2/declaration.json carried no reservedOrgs — the reserved-org list is unreadable');
  }
  return new Set(orgs);
}

let registered: ReadonlySet<string> | null = null;
/** Cached `orgsFromDeclaration(declaration())` — the era-2 reader calls this per event. */
export function registeredOrgs(): ReadonlySet<string> {
  if (registered === null) registered = orgsFromDeclaration(declaration());
  return registered;
}
