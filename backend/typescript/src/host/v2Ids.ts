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
import { looksProjected, projectBoundId, unprojectBoundId } from './boundIdProjection.js';

/** `ids.schema.json#/$defs/opaque` — a host-minted segment: no `@`, no `/`, no whitespace. */
export const V2_OPAQUE_ID = /^[A-Za-z0-9._~-]{16,128}$/;
/** `ids.schema.json#/$defs/tenantId`. */
export const V2_TENANT_ID = /^[A-Za-z0-9._~-]{1,128}$/;
/** `ids.schema.json#/$defs/runId` — the tenant-bound composite. */
export const V2_TENANT_BOUND_ID = /^[A-Za-z0-9._~-]{1,128}\/[A-Za-z0-9._~-]{16,128}$/;
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
 * ADR 0726 — this host's tenant ids are NOT all inside the corpus grammar:
 * every personal workspace is `user:<sha256[:32]>` (`middleware/auth.ts`), and
 * `identity.md` §5 admits no `:`. The first version of `toWireRunId` returned
 * the id BARE for such a tenant — a silent fail-open that put every bound kind
 * on the major-2 wire unbound for every signed-in user's default workspace
 * (measured 2026-09-17: 50 of 128 wire violations). The wire form of the tenant
 * SEGMENT is now the RFC 0184 byte-escape of the storage form (`user~3A…`),
 * which IS inside the grammar (`~` is admitted), injective, and reversible;
 * `fromWireTenant` decodes it. Host-internal: §5 says `tenantId` is host-minted
 * and opaque, so the wire spelling being a projection of the storage spelling
 * is within the host's remit and claims nothing on the wire.
 */
export function toWireTenant(tenant: string): string {
  // ADR 0704 — an `anon:` tenant is deliberately NOT bound (its runs stay bare
  // on the wire; `anon-tenant-bound-id-tripwire` pins that decision). Leaving it
  // unprojected keeps `toWireRunId`'s grammar gate refusing it exactly as before.
  if (tenant.startsWith('anon:')) return tenant;
  return V2_TENANT_ID.test(tenant) ? tenant : projectBoundId(tenant);
}
/** Inverse of `toWireTenant`; a raw (unprojected) spelling passes through. */
export function fromWireTenant(segment: string): string {
  if (!looksProjected(segment)) return segment;
  try { return unprojectBoundId(segment); } catch { return segment; }
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
/** Absolute URLs the create + fork responses hand back (`runs.md` §Create). */
const V2_RUN_URL_KEYS: ReadonlySet<string> = new Set(['eventsUrl', 'statusUrl']);
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
    } else if (typeof v === 'string' && V2_RUN_URL_KEYS.has(k)) {
      // The v2 key of an operation is its v1 key without the `/v1` prefix
      // (`versioning.md` §5), and the id inside the URL is the wire id.
      // RFC 0184 §A.1 — the EMIT side. This spelled `encodeURIComponent`, i.e.
      // `%2F`, which is the form that stranded every client following one of
      // these links at our own front door on 2026-09-05 (see
      // `host/boundIdProjection.ts`). A link is the spelling a host hands every
      // client, so leaving it percent-encoded re-creates the outage for
      // everyone downstream even once the accept side understands `~`.
      //
      // APPLY EXACTLY ONCE. `id` here is the segment from the *v1* URL — an
      // unbound, percent-encoded id — so it is percent-decoded, bound, and then
      // projected: one projection, on a value that has never been projected.
      // The codec is deliberately not idempotent (escaping its own marker is
      // what makes it injective), so a second application would silently yield
      // a different id.
      out[k] = v.replace(/\/v1\/runs\/([^/?#]+)/, (_whole, id: string) =>
        `/runs/${projectBoundId(toWireRunId(decodeURIComponent(id), tenant))}`,
      );
    } else {
      out[k] = projectV2RunIds(v, tenant, depth + 1);
    }
  }
  return out;
}
