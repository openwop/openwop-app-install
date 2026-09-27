/**
 * The ONE composed projection of a persisted payload onto the major-2 wire
 * (ADR 0722). Every major-2 egress channel calls this and nothing else:
 *
 *   - `eventEraAdapter.listEvents`  (poll, SSE, fork prefix, debug bundle)
 *   - `routes/webhooks.ts`          (the fan-out)
 *
 * **Why it exists.** Until ADR 0722 the poll/SSE read composed two projections
 * inline (`projectEnvelopeIds` then `projectV2OwnerEcho`) while the webhook
 * fan-out projected only the event TYPE and forwarded the raw in-process
 * payload — so a major-2 webhook subscriber received the v1 owner block
 * (`principal`, `principalKind`), no `nodeId`/`runId` where the def requires
 * them, and every write-seam violation the payload audit reports. Two egress
 * channels, one projected: MEASURED as 156 `/owner must NOT have additional
 * properties` on `run.started`, invisible to seven webhook scenarios none of
 * which validate payload shape.
 *
 * Order is stated, not incidental: ids → aliases → owner echo. The owner echo
 * runs last because it REBUILDS `owner` from the v1 block and must see the
 * final object.
 *
 * **§A.5 (RFC 0184) apply-once applies here by analogy**: this must run exactly
 * once, where the payload leaves the host. A caller that has already read
 * through `listEvents` at contract 2 MUST NOT call it again — the alias step is
 * a rename, and renaming twice is a no-op only by luck.
 */
import { projectV2OwnerEcho } from '../host/runOwner.js';
import { EVENT_SCHEMA_VERSION } from './eventEra.js';
import { projectEnvelopeIds } from './envelopeIdProjection.js';
import { carryVendorKeys } from './vendorKeyCarry.js';
import { projectInterruptKind } from './interruptKindProjection.js';
// A static import, NOT a sibling `readFileSync`: the backend ships as an esbuild
// bundle (`scripts/build.mjs`, `bundle: true`), which inlines imported JSON and
// copies nothing else. The first draft read the file beside `import.meta.url`
// and would have ENOENT'd on the first major-2 read in production — the same
// class as the `seed-data/workforces.json` import precedent, which is why that
// one is an import too.
import aliasesDoc from './payloadKeyAliases.json';

type AliasTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

let aliases: AliasTable | null = null;
/** `payloadKeyAliases.json`, parsed once. Exported so the audit and a test read the SAME table. */
export function payloadKeyAliases(): AliasTable {
  if (aliases !== null) return aliases;
  const out: Record<string, Record<string, string>> = {};
  for (const [type, map] of Object.entries(aliasesDoc as Record<string, unknown>)) {
    if (type.startsWith('_') || map === null || typeof map !== 'object') continue;
    out[type] = map as Record<string, string>;
  }
  aliases = out;
  return aliases;
}

/** Rename write-side keys to their seated names. Unchanged reference when nothing applies. */
export function applyPayloadKeyAliases(type: string, payload: unknown): unknown {
  const map = payloadKeyAliases()[type];
  if (map === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const to = map[k];
    // A producer that already writes the seated name wins; the alias never
    // overwrites a present target — the same rule `projectEnvelopeIds` keeps.
    if (to !== undefined && !(to in p)) { out[to] = v; touched = true; } else out[k] = v;
  }
  return touched ? out : payload;
}

/**
 * ADR 0722 (Phase E follow-up) — `schemaVersion` is REQUIRED on a major-2
 * `RunEventDoc` (`run-event.schema.json`, `additionalProperties: false`), and it
 * is not a stored column: this host has never versioned a payload, so every
 * event it has written is version 1 and the value is supplied at the boundary.
 *
 * It was supplied at the READ seat only (`eventEraAdapter.listEvents`), so every
 * major-2 WEBHOOK delivery shipped an event missing a required envelope field —
 * the same class as the Phase A finding, one layer deeper: that fix projected
 * the fan-out's PAYLOAD and left its ENVELOPE alone. Caught by the corrected
 * `v2-webhook-delivery-shape` scenario (corpus 2.3.2), which is the first reader
 * the delivery body has ever had. ONE owner, called by both channels.
 */
export function stampV2SchemaVersion<T extends object>(event: T): T & { schemaVersion: number } {
  const sv = (event as { schemaVersion?: unknown }).schemaVersion;
  return { ...event, schemaVersion: typeof sv === 'number' ? sv : EVENT_SCHEMA_VERSION };
}

export function projectV2Payload(
  type: string,
  payload: unknown,
  envelope: { runId: string; nodeId?: string },
  runTenant?: string,
): unknown {
  const withIds = projectEnvelopeIds(type, payload, envelope);
  const aliased = applyPayloadKeyAliases(type, withIds);
  const echoed = type === 'run.started' ? projectV2OwnerEcho(aliased, runTenant) : aliased;
  // ADR 0725 — host-only interrupt kinds onto the corpus enum (a seat rename or
  // `custom` + the host spelling carried). Before the box so the carry merges.
  const kinded = projectInterruptKind(type, echoed);
  // ADR 0725 D3 — LAST: seats first (ids, aliases, owner echo), then whatever a
  // closed+hatched def still leaves undeclared is carried under
  // `vendor.openwop-app` (RFC 0185 §C). Idempotent, so the fan-out's second
  // pass is a no-op.
  return carryVendorKeys(type, kinded);
}
