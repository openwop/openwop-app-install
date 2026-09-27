/**
 * The era key and the codemap — `spec/v2/core/persistence.md` §"The era key",
 * §"The reader rule", §"The writer rule" (RFC 0176 §A; v2 charter Phase 4).
 *
 * WHAT AN ERA IS. `eventLogSchemaVersion` is a per-run key naming the VOCABULARY
 * that run's event log is written in. It is fixed when the run is created and
 * fixes the log's vocabulary for the run's lifetime:
 *
 *   absent  the run predates this host's v2 cut. It reads as `2` and is NEVER
 *           backfilled — persistence.md forbids rewriting a historical row to
 *           add an explicit `2`, and forbids a reader requiring one.
 *   2       the v1 era. Rows carry v1 type names; a major-2 reader translates.
 *   3       the v2 era. Rows carry v2 type names verbatim; no translation.
 *
 * WHY THIS HOST NEEDS BOTH DIRECTIONS, WHICH THE SPEC DOES NOT STATE. The
 * corpus writes the reader rule for a host that serves major 2 ALONE: an era-2
 * log is translated v1→v2 on read, an era-3 log is read untranslated. This host
 * serves BOTH majors through the overlap (`versioning.md` §5), and §1.2 says
 * "v1 operations keep their /v1/… path keys unchanged". Those two obligations
 * meet on an era-3 run: §"The era key" makes this host stamp `3` on every run
 * it creates and §"The writer rule" makes that log v2 vocabulary, so the v1
 * representation of a run created TODAY can only stay unchanged if the v1
 * reader maps the stored v2 name back to its v1 spelling. persistence.md names
 * no such obligation. Reported as a corpus gap; implemented here as the inverse
 * of the same codemap row, which is exact — the map is a bijection (118 rows,
 * 118 distinct v2 names, verified at load).
 *
 * So: the STORE holds each run's era vocabulary, and this module converts
 * between that and the vocabulary of the contract doing the reading. The host's
 * own internal vocabulary — every one of ~290 `appendEvent` call sites, the
 * projection folds, the executor's resume, webhooks, the frontend — is v1, and
 * stays v1. Contract `1` is therefore also the default and the identity case.
 *
 * The codemap is DATA (persistence.md §"The codemap is data"): it is read from
 * the vendored `schemas/v2/event-codemap.json`, copied verbatim from the pinned
 * corpus tag by `scripts/sync-schemas.sh`. There is no private mapping here and
 * there must never be one.
 *
 * CORRECTED 2026-09-26 (ADR 0749 R2) — the sentence above is now false as
 * written, and it is kept so the narrowing is visible. `HOST_VENDOR_ROWS` below
 * IS a host-private row. What still holds, and is enforced at load: no host
 * row may name a type the corpus codemap maps, on either side, so no PROTOCOL
 * type is ever privately translated. A host row only moves one of THIS host's
 * own v1-era types, whose v1 spelling is not a valid v2 type, onto its
 * registered vendor org. It exists because such rows are already on disk in
 * era-2 logs, where a writer-side rename (the ADR 0682 route) cannot reach
 * them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { locateRepoSchemasDir } from '../host/_repoPath.js';
import { registeredOrgs } from '../host/specDeclaration.js';
import { OpenwopError } from '../types.js';
import type { RunRecord } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The v1 era. A run with no stored era reads as this and is never backfilled. */
export const ERA_V1 = 2;
/** The v2 era. `persistence.md`: a v2 host MUST stamp this on every run it creates. */
export const ERA_V2 = 3;

/**
 * The era this host stamps on every run it creates, and the ONE value discovery
 * may advertise. persistence.md §"The era key": "Discovery MUST advertise the
 * value the host writes for new runs and nothing else; a host MUST hold one
 * constant for this axis", and "collapsing to one constant is a precondition for
 * advertising, not a consequence". This constant IS that collapse: the storage
 * seat stamps it, discovery reads it, and there is no second spelling anywhere.
 */
export const EVENT_LOG_SCHEMA_VERSION = ERA_V2;

/**
 * `spec/v2/core/events.md` §"The envelope" (RFC 0171 §A; RFC 0172 §B axis 5) —
 * the PER-EVENT schema version, REQUIRED on a major-2 `RunEventDoc`.
 *
 * A different axis from the era key above, which they are easy to confuse:
 * `eventLogSchemaVersion` names the VOCABULARY a run's log is written in (2 =
 * v1 names, 3 = v2 names), and `schemaVersion` names the shape of ONE event's
 * payload. This host has never versioned a payload — every event it has written
 * is version 1 — so the value is a constant, and it is supplied at the read seat
 * rather than stored, exactly as `persistence.md` §"The era key" lets a host
 * supply an era for a run that predates the key. When a producer starts
 * versioning a payload it sets `EventRecord.schemaVersion` itself and the seat
 * leaves it alone.
 */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * `version-negotiation.md` §Engine version (axis 1): "Every persisted run
 * document MUST carry an `engineVersion: number` field set to the writer
 * engine's CURRENT_ENGINE_VERSION constant at write time." Bumped when the
 * run-doc shape changes. This host has never bumped; `1` is the honest first
 * value. Stamped into `run.metadata.engineVersion` by `insertRunWithStartContext`
 * (this host's seat for write-time stamps) and surfaced on BOTH snapshots.
 * Absent on a run ⇒ the field is OMITTED (the spec's legacy escape) -- never
 * synthesized, because a value we did not write is a false statement about
 * who wrote the row. Found by `era-key-stamped-v1` (suite rc.26+) 2026-09-04:
 * 0 references in this tree before this constant.
 */
export const CURRENT_ENGINE_VERSION = 1;

/** The protocol major a read is being served under. `1` is the default. */
export type ContractMajor = 1 | 2;

interface CodemapRow { readonly v1: string; readonly v2: string }
interface CodemapDoc { readonly rows: readonly CodemapRow[] }

interface Codemap {
  /** v1 name → v2 name (identity rows included). */
  readonly forward: ReadonlyMap<string, string>;
  /** v2 name → v1 name — the spelling an era-2 log stores. */
  readonly inverse: ReadonlyMap<string, string>;
}

let cached: Codemap | null = null;

/**
 * `schemas/v2/event-codemap.json`, vendored from the pinned corpus tag. Read
 * once, eagerly validated: a duplicate on either side would make one of the two
 * directions ambiguous, and an ambiguous inverse is precisely how a v1 wire gets
 * silently rewritten. Better to refuse at boot than to mistranslate a log.
 */
export function loadCodemap(): Codemap {
  if (cached !== null) return cached;
  const dir = locateRepoSchemasDir(__dirname, 'run-event.schema.json');
  const path = join(dir, 'v2', 'event-codemap.json');
  const doc = JSON.parse(readFileSync(path, 'utf8')) as CodemapDoc;
  const forward = new Map<string, string>();
  const inverse = new Map<string, string>();
  for (const row of doc.rows) {
    if (forward.has(row.v1)) throw new Error(`event-codemap.json names v1 type ${row.v1} twice`);
    if (inverse.has(row.v2)) {
      // A many-to-one fold would make the v1 representation of an era-3 log
      // lossy, which on this dual-stack host is a v1 wire change. The shipped
      // map has none; if one ever appears the host must be corrected, not
      // guess.
      throw new Error(
        `event-codemap.json maps more than one v1 type onto v2 type ${row.v2}; the inverse this host needs to serve the v1 wire over an era-${ERA_V2} log is not a function`,
      );
    }
    forward.set(row.v1, row.v2);
    inverse.set(row.v2, row.v1);
  }
  // Host-owned rows (see HOST_VENDOR_ROWS). They MUST NOT collide with a corpus
  // row on either side — the corpus owns every name it maps, and a host row
  // that shadowed one would silently retranslate a protocol type.
  for (const [v1, v2] of HOST_VENDOR_ROWS) {
    if (forward.has(v1) || inverse.has(v2)) {
      throw new Error(`host vendor row ${v1} ⇄ ${v2} collides with a corpus event-codemap row`);
    }
    forward.set(v1, v2);
    inverse.set(v2, v1);
  }
  cached = { forward, inverse };
  return cached;
}

/**
 * ADR 0749 R2 — host event types this host has always written in its v1
 * vocabulary whose v1 spelling is NOT a valid v2 type, mapped onto the host's
 * own registered vendor org (`openwop-app`, spec/v2/declaration.json).
 *
 * `ui.a2ui-surface` is the one today. RFC 0209 §D.14 carves `ui.*`/`media.*`
 * out of the `<org>.` rule for ENVELOPE KINDS only; as a run-event TYPE,
 * events.md §Types still requires a registered first segment, and `ui` is not
 * one. So an era-2 log holding it failed every major-2 read with
 * `500 event_type_unmapped`, and an era-3 log served an invalid type.
 *
 * Only the SPELLING of the type is translated — exactly as a corpus codemap row
 * translates it. The payload is never touched, so a surface recorded under v1 is
 * returned byte-for-byte on poll, SSE and `:fork` (RFC 0209 §C.11), and the v1
 * wire still reads `ui.a2ui-surface` from either era. If the corpus registers a
 * protocol type for recorded surfaces, retarget this row to it.
 */
const HOST_VENDOR_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['ui.a2ui-surface', 'openwop-app.a2ui-surface'],
];
const HOST_VENDOR_FORWARD: ReadonlyMap<string, string> = new Map(HOST_VENDOR_ROWS);

/** Test seam — drops the memoised map so a fixture can re-read it. */
export function resetCodemapCache(): void {
  cached = null;
}

/**
 * `spec/v2/core/events.md` §Types — the positive vendor grammar. A vendor type
 * the codemap does not name reads and writes under its own name unchanged
 * (RFC 0171 §A.2 reserved-prefix rule); `openwop.` is reserved and is NOT a
 * vendor prefix.
 */
const VENDOR_TYPE = /^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;

function isVendorType(type: string): boolean {
  if (!VENDOR_TYPE.test(type)) return false;
  const org = type.slice(0, type.indexOf('.'));
  return registeredOrgs().has(org);
}

/**
 * The era of `run` — persistence.md's absent-⇒-`2` rule, in ONE place. Every
 * caller reads the era through this, so a NULL column can never be mistaken for
 * a deliberate value anywhere else.
 */
export function eraOf(run: Pick<RunRecord, 'eventLogSchemaVersion'>): number {
  return run.eventLogSchemaVersion ?? ERA_V1;
}

/**
 * §"The writer rule" — the spelling to STORE for a `type` the host emitted (in
 * its native v1 vocabulary) into a log of era `era`.
 *
 * An append to an era-`2` run MUST use v1 vocabulary, "the name the codemap maps
 * from, not the v2 name it maps to". An append to an era-`3` run is stored in v2
 * vocabulary. This is structural rather than incidental on purpose: 27 of the 36
 * renamed types are emitted by this host, so a writer that merely passed its
 * argument through would be correct only for the identity rows and would corrupt
 * every renamed one.
 *
 * A name that cannot be expressed in the run's era is REFUSED rather than
 * written — writing it would produce a log this host's own reader fails on with
 * `event_type_unmapped`.
 */
export function toStorageVocabulary(type: string, era: number): string {
  const { forward, inverse } = loadCodemap();
  if (era >= ERA_V2) {
    // An era-3 log is v2 vocabulary. A name the codemap maps FROM is stored
    // under the name it maps TO; a name that is already the v2 spelling (every
    // identity row, and any caller that already speaks v2) is stored as it is.
    return forward.get(type) ?? type;
  }
  // An era-2 log is v1 vocabulary: "the name the codemap maps from, not the v2
  // name it maps to". A v1 name is already that name — `forward.has` is checked
  // FIRST so a name that is BOTH (every identity row) is never rewritten into
  // some other row's v1 spelling.
  if (forward.has(type)) return type;
  const v1 = inverse.get(type);
  if (v1 !== undefined) return v1;
  // Neither side names it. Two very different cases, and only one is an error:
  //
  //  - a name the codemap does not govern at all (this host's own
  //    `host.<domain>.<entity>.<verb>` events, vendor events, anything a v1 host
  //    was free to write) is stored verbatim. The v1 contract never closed the
  //    type space, and an era-2 log is a v1 log. Refusing here would break a
  //    live v1 host to satisfy a rule about v2 names.
  //  - a name that IS a registered v2 type with no v1 preimage cannot be
  //    expressed in an era-2 log at all. That is the second failure mode
  //    §"The writer rule" names, and it is refused rather than written — writing
  //    it would produce a log this host's own major-2 reader fails on with
  //    `event_type_unmapped`. The shipped codemap has a v1 preimage for every
  //    row, so this branch is unreachable today and is here to STAY unreachable:
  //    the day v2 adds a type with no v1 row, an era-2 append of it is a defect,
  //    not a silent write.
  if (V2_ONLY_TYPES.has(type)) {
    throw new OpenwopError(
      'validation_error',
      `refusing to append ${type} to an era-${era} log: it is a v2 event type with no v1 spelling in spec/v2/event-codemap.json, and persistence.md §"The writer rule" fixes the log's vocabulary at run creation`,
      400,
      { type, era },
    );
  }
  return type;
}

/**
 * Registered v2 event types with NO v1 preimage — the names an era-2 log cannot
 * express. Read from the vendored `schemas/v2/run-event.schema.json` enum minus
 * the codemap's v2 column, so it tracks the corpus rather than a hand list.
 */
let v2OnlyCache: ReadonlySet<string> | null = null;
const V2_ONLY_TYPES = {
  has(type: string): boolean {
    if (v2OnlyCache === null) v2OnlyCache = loadV2OnlyTypes();
    return v2OnlyCache.has(type);
  },
};

function loadV2OnlyTypes(): ReadonlySet<string> {
  const { inverse } = loadCodemap();
  try {
    const dir = locateRepoSchemasDir(__dirname, 'run-event.schema.json');
    const schema = JSON.parse(readFileSync(join(dir, 'v2', 'run-event.schema.json'), 'utf8')) as {
      properties?: { type?: { oneOf?: ReadonlyArray<{ enum?: readonly string[] }> } };
    };
    const declared = (schema.properties?.type?.oneOf ?? []).flatMap((b) => b.enum ?? []);
    return new Set(declared.filter((t) => !inverse.has(t)));
  } catch {
    // No v2 run-event schema vendored: every registered v2 type is a codemap
    // row, so there is nothing this set could hold that the map does not.
    return new Set<string>();
  }
}

/**
 * §"The reader rule" — the spelling to put ON THE WIRE for a stored `type` in a
 * log of era `era`, read under protocol major `contract`.
 *
 * `sequence`, `eventId`, `timestamp`, `causationId` and vendor fields are not
 * this function's business: they pass through untouched, `sequence` verbatim
 * INCLUDING `0`.
 *
 * A stored type the codemap does not name and that carries no vendor prefix
 * fails the read with `500 event_type_unmapped` (`spec/v2/errors.json`). There
 * is deliberately no tolerant branch: tolerating an unknown name would hide
 * exactly the writer-rule defect the refusal above exists to prevent. Under
 * major 1 the read is tolerant, because a v1 host was allowed to write anything
 * and the v1 contract never promised a closed enum.
 */
export function toContractVocabulary(type: string, era: number, contract: ContractMajor): string {
  const { forward, inverse } = loadCodemap();
  if (contract === 2) {
    // An era-3 log is v2 vocabulary — except rows a host wrote before one of its
    // own types gained a vendor spelling (HOST_VENDOR_ROWS): those are forwarded
    // too, so no major-2 reader is ever handed the invalid spelling.
    if (era >= ERA_V2) return HOST_VENDOR_FORWARD.get(type) ?? type;
    const mapped = forward.get(type);
    if (mapped !== undefined) return mapped;
    if (isVendorType(type)) return type;
    throw new OpenwopError(
      'event_type_unmapped',
      `event type ${type} is not named by spec/v2/event-codemap.json and carries no vendor prefix — this era-${era} log cannot be translated`,
      500,
      { type },
    );
  }
  // Major 1. An era-2 log is already v1 vocabulary and is returned byte-for-byte
  // as it always was. An era-3 log is stored in v2 vocabulary, so the v1
  // spelling is restored — see the header for why this direction exists at all.
  if (era < ERA_V2) return type;
  return inverse.get(type) ?? type;
}

/**
 * Fan-out projection (webhooks; ADR 0647 correction, 2026-09-10). An
 * in-process event is in the host's v1 dialect regardless of the run's era.
 * A major-2 SUBSCRIBER must receive the codemap's v2 spelling — the same
 * translation `toContractVocabulary` does for a major-2 READ — but a fan-out
 * is not a read: an unmapped, unprefixed host type is delivered under its
 * only spelling rather than refused, because dropping a delivery is a worse
 * outcome for a subscriber than an unrenamed type (the read-side refusal is
 * tracked as `v2-unmapped-type-refused`; this path is deliberately tolerant).
 */
export function wireEventType(type: string, contract: ContractMajor): string {
  if (contract !== 2) return type;
  return loadCodemap().forward.get(type) ?? type;
}

/**
 * Every spelling a subscription filter may legitimately carry for one
 * in-process event type: the v1 spelling, its v2 rename, and — for a caller
 * that handed us a v2 spelling — the v1 inverse. Subscription matching must
 * accept all of them: a major-2 subscriber registers `agent.tool-called`,
 * the executor emits `agent.toolCalled`, and an exact-match filter would
 * never fire (defect found by the 2026-09-10 v2-readiness measurement).
 */
export function eventTypeSpellings(type: string): ReadonlySet<string> {
  const { forward, inverse } = loadCodemap();
  const out = new Set<string>([type]);
  const f = forward.get(type); if (f !== undefined) out.add(f);
  const i = inverse.get(type); if (i !== undefined) out.add(i);
  return out;
}
