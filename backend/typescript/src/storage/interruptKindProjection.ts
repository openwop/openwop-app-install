/**
 * ADR 0725 — this host's interrupt KINDS onto the corpus enum, on the major-2 read.
 *
 * `InterruptRecord.kind` (`types.ts`) admits `refinement | cancellation |
 * conversation | timer | tour-step | walkthrough-step`; the corpus `kind` enum
 * (`suspend-request.schema.json`, mirrored on `nodeSuspended` /
 * `interruptResolved` / `approval*`) is `approval | clarification |
 * external-event | custom | conversation.start | conversation.exchange |
 * conversation.close | low-confidence`. Measured 2026-09-17: 17 enum violations
 * across `node.suspended` + `interrupt.resolved`, every one a host-only kind.
 *
 * Mapping (read-only; storage keeps the host spelling, v1 readers see it):
 *  - `conversation` → `conversation.start` — the multi-turn node suspends ONCE,
 *    at the start of the exchange (`bootstrap/nodes.ts` `kind: 'conversation'`,
 *    data `{conversationId, turnIndex: 0}`), which is exactly that seat.
 *  - any other value outside the enum → `custom`, with the host spelling
 *    CARRIED under `vendor.openwop-app.kind` (RFC 0185 §C — never dropped) so a
 *    consumer that knows this host can still branch on it; the SPA restores it
 *    at its one seam (`client/v2Wire.ts`).
 * The enum is READ from the vendored schema, not hand-listed, so a corpus
 * widening (a `walkthrough` seat, say) retires the mapping by itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../host/_repoPath.js';
import { VENDOR_CARRY_KEY } from './vendorKeyCarry.js';

const KIND_ALIASES: Readonly<Record<string, string>> = { conversation: 'conversation.start' };
let corpusKinds: ReadonlySet<string> | null = null;

/** The corpus interrupt-kind enum, from `suspend-request.schema.json`. Fails LOUD on an empty read: a mapping over an empty enum would send every kind to `custom`. */
export function corpusInterruptKinds(): ReadonlySet<string> {
  if (corpusKinds !== null) return corpusKinds;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json');
  const doc = JSON.parse(readFileSync(join(dir, 'v2', 'suspend-request.schema.json'), 'utf8')) as { properties?: { kind?: { enum?: unknown } } };
  const e = doc.properties?.kind?.enum;
  if (!Array.isArray(e) || e.length === 0 || !e.every((k) => typeof k === 'string')) {
    throw new Error('suspend-request.schema.json carries no `kind` enum — the interrupt-kind projection has nothing to map onto');
  }
  corpusKinds = new Set(e as string[]);
  return corpusKinds;
}

/**
 * Types whose payload carries the interrupt `kind` — DERIVED: every `_typeIndex`
 * entry whose resolved def declares a `kind` whose enum is the suspend-request
 * enum (`nodeSuspended`, `interruptResolved`, `approvalGranted/Overridden`, and
 * the `suspend-request` $ref family). A hand-list here would be the ADR 0723
 * defect as a design; a corpus def that gains the enum joins the set by itself.
 */
let kindTypes: ReadonlySet<string> | null = null;
function kindCarryingTypes(): ReadonlySet<string> {
  if (kindTypes !== null) return kindTypes;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json');
  const doc = JSON.parse(readFileSync(join(dir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as { $defs?: Record<string, Record<string, unknown>> };
  const defs = doc.$defs ?? {};
  const index = (defs['_typeIndex'] as { properties?: Record<string, { $ref?: string }> } | undefined)?.properties ?? {};
  const want = [...corpusInterruptKinds()].sort().join('|');
  const out = new Set<string>();
  for (const [type, entry] of Object.entries(index)) {
    let d: Record<string, unknown> | undefined = typeof entry?.$ref === 'string' ? defs[entry.$ref.replace(/^#\/\$defs\//, '')] : undefined;
    for (let hops = 0; d !== undefined && typeof d['$ref'] === 'string' && hops < 8; hops += 1) {
      const ref = d['$ref'] as string;
      // The suspend-request family is an EXTERNAL $ref: its `kind` IS the enum by construction.
      if (!ref.startsWith('#/$defs/')) { out.add(type); d = undefined; break; }
      d = defs[ref.slice('#/$defs/'.length)];
    }
    const kind = (d?.['properties'] as Record<string, { enum?: unknown }> | undefined)?.['kind'];
    if (Array.isArray(kind?.enum) && [...(kind.enum as string[])].sort().join('|') === want) out.add(type);
  }
  if (out.size === 0) throw new Error('run-event-payloads.schema.json names no type carrying the interrupt kind enum — the projection has nothing to map');
  kindTypes = out;
  return kindTypes;
}

export function projectInterruptKind(type: string, payload: unknown): unknown {
  if (!kindCarryingTypes().has(type) || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const kind = p['kind'];
  if (typeof kind !== 'string') return payload;
  const kinds = corpusInterruptKinds();
  if (kinds.has(kind)) return payload;
  const alias = KIND_ALIASES[kind];
  if (alias !== undefined && kinds.has(alias)) return { ...p, kind: alias };
  const box = p[VENDOR_CARRY_KEY];
  const carried = box !== null && typeof box === 'object' && !Array.isArray(box) ? (box as Record<string, unknown>) : {};
  return { ...p, kind: 'custom', [VENDOR_CARRY_KEY]: { ...carried, kind } };
}

export { kindCarryingTypes };
