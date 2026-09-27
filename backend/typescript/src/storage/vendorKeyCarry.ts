/**
 * ADR 0725 D3 — RFC 0185 §C "carry it or fail" for keys this host writes that
 * the corpus def does not declare.
 *
 * On the major-2 read, every key a CLOSED+HATCHED def leaves undeclared is
 * moved — never dropped — into ONE boxed property, `vendor.openwop-app`, that
 * matches the def's `^(openwop-|x-|vendor\.)` hatch. The box is built only
 * from undeclared keys, so it cannot collide with a seated name, and a second
 * pass finds nothing left to move (the box itself is hatch-matching) — the
 * apply-once property `projectV2Payload` needs because it runs at
 * `listEvents` AND the webhook fan-out.
 *
 * Nested closed+hatched sub-objects are carried the same way (`run.failed.error`
 * is `_errorObject`: closed, hatched, and this host enriches it with
 * `category` / `action` / `userMessage`). A def or sub-def WITHOUT a hatch is
 * left untouched: there is nowhere legal to carry to, the residue is a defect
 * fixed at the writer, and the audit ratchet (not a runtime 500) is its gate.
 *
 * Schema-driven from the vendored `run-event-payloads.schema.json`, the same
 * read `envelopeIdProjection.ts` takes — a hand-list here would be the defect
 * as a design (ADR 0723's lesson).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../host/_repoPath.js';

/** This host's boxed-carry property. Matches the corpus hatch `^(openwop-|x-|vendor\.)`. */
export const VENDOR_CARRY_KEY = 'vendor.openwop-app';

type Schema = Record<string, unknown>;
interface Plan { declared: ReadonlySet<string>; hatched: boolean; nested: ReadonlyMap<string, Plan> }

let plans: Map<string, Plan | null> | null = null;
let defsDoc: Record<string, Schema> | null = null;

function loadDefs(): Record<string, Schema> {
  if (defsDoc !== null) return defsDoc;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json');
  const doc = JSON.parse(readFileSync(join(dir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as { $defs?: Record<string, Schema> };
  defsDoc = doc.$defs ?? {};
  return defsDoc;
}

/** Resolve a local `#/$defs/x` chain; an external `$ref` (another schema file) resolves to null — we do not carry into shapes we do not own the read of. */
function resolve(s: Schema | undefined, defs: Record<string, Schema>, depth = 0): Schema | null {
  if (s === undefined || depth > 8) return null;
  const ref = s['$ref'];
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/$defs/')) return null;
    return resolve(defs[ref.slice('#/$defs/'.length)], defs, depth + 1);
  }
  return s;
}

function planFor(s: Schema | undefined, defs: Record<string, Schema>, depth = 0): Plan | null {
  const d = resolve(s, defs, depth);
  if (d === null || depth > 6) return null;
  const props = (d['properties'] ?? {}) as Record<string, Schema>;
  if (d['additionalProperties'] !== false) return null; // open: nothing to carry
  const pp = d['patternProperties'];
  const hatched = pp !== null && typeof pp === 'object' && Object.keys(pp as object).some((k) => /vendor/.test(k));
  const nested = new Map<string, Plan>();
  for (const [k, sub] of Object.entries(props)) {
    const p = planFor(sub, defs, depth + 1);
    if (p !== null && (p.hatched || p.nested.size > 0)) nested.set(k, p);
  }
  return { declared: new Set(Object.keys(props)), hatched, nested };
}

/** The carry plan for an event type, or null when its def is open / external / unhatched-and-flat. */
export function carryPlanFor(type: string): Plan | null {
  if (plans === null) plans = new Map();
  const hit = plans.get(type);
  if (hit !== undefined) return hit;
  const defs = loadDefs();
  const index = (defs['_typeIndex'] as { properties?: Record<string, Schema> } | undefined)?.properties ?? {};
  const plan = planFor(index[type], defs);
  const out = plan !== null && (plan.hatched || plan.nested.size > 0) ? plan : null;
  plans.set(type, out);
  return out;
}

function carry(value: unknown, plan: Plan): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const p = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const box: Record<string, unknown> = {};
  let touched = false;
  for (const [k, v] of Object.entries(p)) {
    const sub = plan.nested.get(k);
    if (sub !== undefined) {
      const nv = carry(v, sub);
      if (nv !== v) touched = true;
      out[k] = nv;
      continue;
    }
    if (plan.declared.has(k) || /^(openwop-|x-|vendor\.)/.test(k)) { out[k] = v; continue; }
    if (plan.hatched) { box[k] = v; touched = true; } else out[k] = v; // unhatched: leave for the ratchet
  }
  if (Object.keys(box).length > 0) {
    const existing = out[VENDOR_CARRY_KEY];
    out[VENDOR_CARRY_KEY] = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), ...box }
      : box;
  }
  return touched ? out : value;
}

/** Move every undeclared key of a closed+hatched def (and its closed+hatched sub-objects) into `vendor.openwop-app`. Same reference back when idle. */
export function carryVendorKeys(type: string, payload: unknown): unknown {
  const plan = carryPlanFor(type);
  if (plan === null) return payload;
  return carry(payload, plan);
}

