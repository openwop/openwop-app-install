/**
 * `spec/v2/core/identity.md` §5 "Identifier grammars"
 * (`schemas/v2/ids.schema.json`, RFC 0170 §D.1) — the v2 id grammars and the
 * ONE projection between this host's stored run id and the tenant-bound form
 * the v2 wire carries.
 *
 * THE DECISION, STATED ONCE (ADR 0629): this host does NOT re-mint run ids.
 * `runDispatch.ts` keeps minting a bare UUID and every row, index, foreign key
 * and `/v1/…` URL keeps the id it has. The tenant-bound `<tenantId>/<opaque>`
 * form is a WIRE PROJECTION applied at the major-2 boundary in both directions:
 *
 *   outbound  `<opaque>`            → `<tenant>/<opaque>`   (protocolVersion.ts)
 *   inbound   `<tenant>/<opaque>`   → `<opaque>`            (middleware/v2Identity.ts)
 *
 * Why not mint the new form: a `/` inside a run id is a path separator in every
 * `/v1/runs/{runId}` route this host serves, a primary key in three tables, and
 * the value the v1 wire has returned from `POST /v1/runs` since 1.0. Minting it
 * would change the v1 representation of a run id — a breaking change to a
 * contract `versioning.md` §1.2 says stays unchanged through the overlap — for
 * a v2 grammar that a read projection satisfies exactly. NO HISTORICAL ROW IS
 * REWRITTEN and no backfill runs: the projection is total over the ids this
 * host mints (a v4 UUID is 36 characters of `[0-9a-f-]`, inside the opaque
 * grammar) and reversible, so the id the suite is handed is the id it can hand
 * back.
 *
 * The tenant segment carries the invariant: `identity.md` §5 requires a host to
 * reject a tenant-bound id whose tenant segment is not the caller's with
 * `403 id_tenant_mismatch`, and the inbound half is where that check lives.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from './_repoPath.js';
import { looksProjected, unprojectBoundId } from './boundIdProjection.js';

/** `ids.schema.json#/$defs/opaque` — a host-minted segment: no `@`, no `/`, no whitespace. */
export const V2_OPAQUE_ID = /^[A-Za-z0-9._~-]{16,128}$/;
/**
 * `ids.schema.json#/$defs/tenantId` — and the tenant segment of every bound-id
 * kind, which RFC 0184 (suite 2.2.0) widened to admit the `anon:` prefix.
 * ADR 0760 (revisiting ADR 0704): this host binds anonymous runs, so the guard
 * is the corpus segment exactly — `anon-tenant-bound-id-tripwire` derives it
 * from the vendored schema and reds on any drift.
 */
export const V2_TENANT_ID = /^(anon:)?[A-Za-z0-9._~-]{1,128}$/;
/** `ids.schema.json#/$defs/runId` — the tenant-bound composite. */
export const V2_TENANT_BOUND_ID = /^(anon:)?[A-Za-z0-9._~-]{1,128}\/[A-Za-z0-9._~-]{16,128}$/;
/**
 * `spec/v2/core/idempotency.md` §"Layer 1" (RFC 0170 §D.3) — the key grammar.
 * 22 characters is 128 bits in base64url; a UUIDv4 in canonical form is 36.
 */
export const V2_IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{22,128}$/;

/**
 * The v2 wire spelling of a stored run id. Returns the id UNCHANGED when the
 * projection cannot be applied honestly — when it already carries a tenant
 * segment, or when either half is outside its grammar (this host mints a few
 * host-internal pseudo-run ids such as `hostext:sync:<uuid>` that the v2
 * grammar cannot express; they are not reachable on the v2 path space, and
 * inventing an encoding for them here would make the projection irreversible).
 */
export const toWireBoundId = toWireRunId;
export const fromWireBoundId = fromWireRunId;
/**
 * ADR 0814 — the WIRE tenantId: a deterministic, injective, reversible map from
 * this host's internal tenant key to a grammar-clean value.
 *
 * The keys this host mints are not all inside the corpus grammar:
 * - personal: `user:<sha256[:32]>`
 * - shared workspace: `ws:<uuid>`
 * - test-login fixtures: `org:<slug>`
 * - anonymous: `anon:<sid>`
 *
 * ADR 0726 made them wire-legal with RFC 0184's `~` byte-escape (`user~3A…`),
 * and that MINTED `~` into every tenant-bound id and tenantId body field.
 * `identity.md` §5: "a host MUST NOT mint a tenant-bound id containing `~`"
 * (`~` is the PATH projection, applied once where an id leaves). The corpus
 * steward confirmed (2026-10-04) that the wire tenantId need not equal the stored
 * key: it is host-minted, and §5 constrains only its grammar and handling.
 *
 * The map is IDEMPOTENT. A value already clean passes through unchanged, so
 * re-projecting a wire value (`projectV2RunIds` rewrites `tenant`/`tenantId`
 * keys at any depth) cannot double-encode it. Injectivity therefore rests on one
 * invariant enforced where keys are minted or configured
 * (`wireTenantViolation`): no internal key starts with a reserved prefix
 * (`u-`/`w-`/`o-`/`x-`), and none maps past 128 characters.
 */
const WIRE_CLEAN = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_WIRE_PREFIX = /^[uwox]-/;
const KEY_KINDS: ReadonlyArray<readonly [internal: string, wire: string]> = [
  ['user:', 'u-'],
  ['ws:', 'w-'],
  ['org:', 'o-'],
];

export function toWireTenant(tenant: string): string {
  // ADR 0760 — `anon:<sid>` is inside the corpus grammar literally (RFC 0184
  // admits the prefix). Its sid is base64url (`cookieSession.ts`), so it is
  // clean. Only a sid outside the class would fall through to the rows below.
  if (tenant.startsWith('anon:') && V2_TENANT_ID.test(tenant) && !tenant.includes('~')) return tenant;
  if (WIRE_CLEAN.test(tenant)) return tenant;
  for (const [internal, wire] of KEY_KINDS) {
    if (tenant.startsWith(internal)) {
      const mapped = wire + tenant.slice(internal.length);
      if (WIRE_CLEAN.test(mapped)) return mapped;
    }
  }
  const hex = `x-${Buffer.from(tenant, 'utf8').toString('hex')}`;
  // Over 128 characters is unreachable for a key that passed `wireTenantViolation`.
  // Returned unchanged, it fails the grammar in `toWireRunId`, which leaves the
  // id unbound rather than inventing a spelling.
  return WIRE_CLEAN.test(hex) ? hex : tenant;
}

/**
 * Inverse of `toWireTenant`, plus the spellings this host already minted
 * (`identity.md` §5: "ids already minted MUST still resolve"):
 * - **ADR 0726's escape** (`user~3A<hex>`) unescapes STRAIGHT to the internal
 *   key, with no prefix dispatch afterwards, so `u~2Dabc` can never become
 *   `user:abc`;
 * - **a new-form value** (`u-`/`w-`/`o-`/`x-`) is decoded only when it is the
 *   CANONICAL spelling of what it decodes to, so one tenant has one new-form
 *   spelling (an uppercase `X-` or `x-<hex(user:h)>` is not an alias);
 * - **anything else**, including the raw internal key (`user:<hex>`, which the
 *   SPA binds with), passes through verbatim, as it did under ADR 0726.
 */
export function fromWireTenant(segment: string): string {
  if (looksProjected(segment)) {
    try { return unprojectBoundId(segment); } catch { return segment; }
  }
  if (!RESERVED_WIRE_PREFIX.test(segment)) return segment;
  let decoded: string | null = null;
  for (const [internal, wire] of KEY_KINDS) {
    if (segment.startsWith(wire)) { decoded = internal + segment.slice(wire.length); break; }
  }
  if (decoded === null && /^x-(?:[0-9a-f]{2})+$/.test(segment)) {
    decoded = Buffer.from(segment.slice(2), 'hex').toString('utf8');
  }
  return decoded !== null && toWireTenant(decoded) === segment ? decoded : segment;
}

/**
 * Why `key` cannot be an internal tenant key, or `null`. Checked where an
 * operator CONFIGURES a tenant (`OPENWOP_API_KEYS`). The keys this host mints
 * itself (`user:<hash>`, `ws:<uuid>`, `anon:<sid>`) satisfy it by construction,
 * and `adr0814-wire-tenant.test.ts` pins that.
 */
export function wireTenantViolation(key: string): string | null {
  if (key === '*') return null;
  if (RESERVED_WIRE_PREFIX.test(key)) {
    return `tenant '${key}' starts with a prefix reserved for the wire tenantId (u-/w-/o-/x-, ADR 0814)`;
  }
  const wire = toWireTenant(key);
  if (!V2_TENANT_ID.test(wire) || (wire.includes('~'))) {
    return `tenant '${key}' has no grammar-clean wire tenantId (over 128 characters once mapped, ADR 0814)`;
  }
  return null;
}
export function toWireRunId(runId: string, tenant: string): string {
  if (runId.includes('/')) return runId;
  if (!V2_OPAQUE_ID.test(runId)) return runId;
  const wireTenant = toWireTenant(tenant);
  if (!V2_TENANT_ID.test(wireTenant)) return runId;
  return `${wireTenant}/${runId}`;
}

/**
 * The stored spelling of a run id presented on the v2 wire, and the
 * `id_tenant_mismatch` check.
 *
 * A bare id (no tenant segment) is accepted verbatim: this host's own frontend
 * and its `/v1` clients address runs that way, the two majors share one handler,
 * and refusing here would be a refusal the v1 wire never had. A tenant-bound id
 * whose tenant segment is not the caller's is refused by `onMismatch`.
 */
export function fromWireRunId(
  wire: string,
  tenant: string,
): { readonly ok: true; readonly runId: string } | { readonly ok: false; readonly segment: string } {
  const slash = wire.indexOf('/');
  if (slash < 0) return { ok: true, runId: wire };
  // ── THE GRAMMAR IS ENFORCED HERE, NOT DOWNSTREAM ──────────────────────────
  //
  // `identity.md` §5 and `ids.schema.json` both spell a tenant-bound id as
  // EXACTLY `<tenant>/<opaque>` — one separator, both halves in their grammar.
  // This function used to split on the first `/` and hand back whatever
  // followed, which accepted two shapes the grammar forbids:
  //
  //     "<tenant>/a/b"   -> runId "a/b"          (separator survives)
  //     "/etc/passwd"    -> returned VERBATIM    (the old `slash <= 0` branch)
  //
  // Neither is exploitable on this host today: run ids reach storage as bound
  // SQL parameters, and the one object-key site (`runRetentionSweeper`) keys on
  // a STORED id, which is always a minted UUID. But that is a fact about our
  // storage engine, not a property of this guard — a peer host on a
  // segment-structured store had the same permissive split turn into a
  // cross-tenant read, because an id carrying `/` re-pointed the reference at a
  // different document and the authorization check gated on a field that
  // document did not have. Not-exploitable-because-of-something-else is a
  // coincidence, not a control, and v2 is the major that makes `/` a legitimate
  // character in this identifier.
  //
  // So the rule is enforced where it is stated. `toWireRunId` already validates
  // both halves before projecting; a projection that checks the grammar going
  // out and not coming back is not a grammar.
  const segment = wire.slice(0, slash);
  const rest = wire.slice(slash + 1);
  // ADR 0726 — the grammar binds the OPAQUE half; the tenant half is compared
  // after decoding its wire projection (`user~3Ax` → `user:x`). A raw `user:x`
  // spelling (what an SDK that binds with the host-ext `.active` value sends)
  // is accepted through the overlap the way the bare form is (`identity.md` §5).
  if (!V2_OPAQUE_ID.test(rest)) {
    // Reported as a mismatch rather than a distinct code on purpose: the
    // refusal MUST NOT disclose whether the run exists, and a caller that can
    // tell "malformed" from "not yours" learns which tenants are real.
    return { ok: false, segment };
  }
  if (fromWireTenant(segment) !== tenant) return { ok: false, segment };
  return { ok: true, runId: rest };
}

/**
 * `identity.md` §5 — the OUTBOUND half, over a whole response body.
 *
 * Keys, not values: only a field the v2 schemas declare as a `runId` kind is
 * rewritten (`runId` on the snapshot, the create/fork response, the poll
 * envelope and every event inside it; `parentRunId` on `run.cancelled`,
 * `events.md`). A value that already carries a tenant segment, or that is
 * outside the host-minted opaque grammar, is left exactly alone
 * (`toWireRunId`).
 *
 * TWO CALLERS, DELIBERATELY. `middleware/protocolVersion.ts` wraps `res.json`,
 * which is how every major-2 response but one leaves this host; `GET
 * /v1/runs/{runId}` sends through `host/restTransport.ts`
 * (`sendNegotiatedRunJson`) because it content-negotiates an encoding, and that
 * path calls `res.send`, not `res.json`. The projection lives HERE so both
 * senders share one implementation rather than one of them silently missing the
 * most important body on the surface.
 */
/**
 * Every key the v2 schemas declare as a `runId`, DERIVED from the vendored
 * schemas rather than hand-listed.
 *
 * WHY DERIVED. This was `new Set(['runId', 'parentRunId'])` — two of the NINE
 * keys the corpus types as `runId`. `sourceRunId` on the fork 201 was among the
 * seven missing, so a fork response handed back a raw opaque id where the wire
 * requires the tenant-bound form; `v2-run-fork-refusals` caught it the moment
 * `replay` was advertised, and nothing local could see it because every in-repo
 * test asserted our own shape.
 *
 * A hand-list is the defect as a design: it is correct only until the corpus
 * adds a tenth key, and its failure mode is silent — an unprojected id looks
 * like a valid id. Reading the schemas makes the set true by construction, the
 * same move as `V2_REGISTERED_CODES` (which derives the error-code registry
 * from `error-envelope.schema.json`).
 */
function deriveKeysBoundTo(refRe: RegExp, floor: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const root = joinPath(dir, 'v2');
    const walk = (node: unknown, parentKey: string | undefined): void => {
      if (Array.isArray(node)) { for (const n of node) walk(n, parentKey); return; }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const ref = obj['$ref'];
      // ADR 0723 — ALL FIVE tenant-bound kinds (`identity.md` §5), not `runId`
      // alone. Measured at corpus tip: `interruptId`, `subscriptionId` (+
      // `triggerSubscriptionId`), `deliveryId`, `effectId` are each `$ref`'d to
      // their kind and were never projected — the suffix here matched one kind
      // and the other four went out bare on every major-2 channel. A parsed walk
      // finds 14 bound keys and no key bound to two kinds, so ONE set is right.
      if (typeof ref === 'string' && parentKey && refRe.test(ref)) keys.add(parentKey);
      for (const [k, v] of Object.entries(obj)) {
        // `properties`/`items`/`$defs` are containers, not field names — keep
        // the enclosing key so `{ sourceRunIds: { items: { $ref: runId } } }`
        // attributes to `sourceRunIds` rather than to `items`.
        walk(v, ['properties', 'items', '$defs', 'allOf', 'anyOf', 'oneOf'].includes(k) ? parentKey : k);
      }
    };
    for (const f of readdirSync(root)) {
      if (!f.endsWith('.schema.json')) continue;
      try { walk(JSON.parse(readFileSync(joinPath(root, f), 'utf8')), undefined); } catch { /* skip unreadable */ }
    }
  } catch { /* fall through to the floor below */ }
  // FLOOR, not a fallback. A derivation that finds nothing would silently
  // disable the projection and every v2 response would ship raw ids — the exact
  // defect this replaces, at full blast. Union with the keys we know are typed
  // as runId so a broken read degrades to the old behaviour instead of to none.
  for (const k of floor) keys.add(k);
  return keys;
}
function deriveRunIdKeys(): ReadonlySet<string> {
  return deriveKeysBoundTo(BOUND_KIND_REF, ['runId', 'parentRunId', 'sourceRunId', 'interruptId', 'subscriptionId', 'deliveryId', 'effectId']);
}

/** `ids.schema.json#/$defs/<kind>` for the five tenant-bound kinds (`identity.md` §5). */
const BOUND_KIND_REF = /ids\.schema\.json#\/\$defs\/(runId|interruptId|subscriptionId|deliveryId|effectId)$/;
/** Every response key the v2 schemas type as a tenant-bound id — all five kinds (ADR 0723). */
export const V2_BOUND_ID_KEYS: ReadonlySet<string> = deriveRunIdKeys();
const V2_RUN_ID_KEYS = V2_BOUND_ID_KEYS;
/** Every response key the v2 schemas type as a plain `tenantId` (`owner.tenant`, `subject.tenant`, `tenantId`) — projected like the segment of a bound id (ADR 0726). */
export const V2_TENANT_FIELD_KEYS: ReadonlySet<string> = deriveKeysBoundTo(/ids\.schema\.json#\/\$defs\/tenantId$/, ['tenant', 'tenantId']);
/** Depth bound: a run's `variables` / `metadata` bag is caller-supplied and unbounded. */
const V2_PROJECTION_MAX_DEPTH = 12;

export function projectV2RunIds(value: unknown, tenant: string, depth = 0): unknown {
  if (depth > V2_PROJECTION_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => projectV2RunIds(v, tenant, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && V2_RUN_ID_KEYS.has(k)) {
      out[k] = toWireRunId(v, tenant);
    } else if (Array.isArray(v) && V2_RUN_ID_KEYS.has(k)) {
      // `contributingRunIds` / `sourceRunIds` hold run ids as an ARRAY. The
      // scalar-only guard above skipped them silently — a plural key would have
      // stayed raw even after being added to the set, which is the same defect
      // one type over.
      out[k] = v.map((e) => (typeof e === 'string' ? toWireRunId(e, tenant) : projectV2RunIds(e, tenant, depth + 1)));
    } else if (typeof v === 'string' && V2_TENANT_FIELD_KEYS.has(k)) {
      out[k] = toWireTenant(v);
    } else {
      // `eventsUrl` / `statusUrl` are NOT rewritten here: `runWireUrls` mints
      // them final (ADR 0812 P4 slice 2b), and the codec is not idempotent, so a
      // second projection would corrupt them. The leg that rewrote pre-slice
      // `/v1/runs/<bare id>` ledger replays was deleted in ADR 0812 P4 slice 4.
      out[k] = projectV2RunIds(v, tenant, depth + 1);
    }
  }
  return out;
}
