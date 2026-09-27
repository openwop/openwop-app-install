/**
 * ADR 0617 D4 (the ADR 0584 follow-on) — the host-event CATALOG PARITY gate.
 *
 * `frontend/react/src/settings/hostEventCatalog.ts` `KNOWN_HOST_EVENT_TYPES`
 * feeds the `<datalist>` on the Event Bindings page — the ONLY operator-facing
 * discovery surface for what can be bound. Its own docblock admitted ~15
 * emitters were missing and that the parity gate was "recorded as follow-on
 * work, not built". An event that is emitted but undiscoverable makes every
 * binding recipe written against it fiction (the `rendering ≠ working` lesson).
 *
 * WHAT IS SCANNED (backend/typescript/src, every `.ts` that calls
 * `emitHostEvent(` / `deliverHostExtEvent(`, COMMENTS STRIPPED — the
 * `ratchet-gates-count-comments` lesson):
 *   - every `'host.<…>'` string LITERAL (≥ 2 segments after `host`) — a type
 *     that is fully known at the emit site or via an in-file constant;
 *   - every TEMPLATE prefix `` `host.<x>.${ `` — a COMPUTED site whose suffix is
 *     assembled at the call site (`crm/emit.ts` `host.crm.${entity}.${verb}`,
 *     territories, sales-commissions, webinars, …). A literal-only grep would
 *     silently exclude these (review SHOULD-4), so they are recorded as
 *     prefixes and judged by prefix coverage.
 *
 * WHAT IS ASSERTED, and the anti-vacuity floors that keep a broken scan from
 * passing green (`ratchets-police-spelling-not-invariant`):
 *   1. the scan found a corpus (files, emitter files, literals, computed sites);
 *   2. ADR 0617's four `host.users.user.*` types are BOTH emitted AND catalogued;
 *   3. every fully-known emitted type is in the catalog EXCEPT those in the
 *      committed SHRINK-ONLY baseline (`test/fixtures/host-event-catalog-baseline.json`)
 *      — a NEW miss is red, and a baseline row for a type that is no longer
 *      missing is red (stale baseline);
 *   4. every computed prefix is covered by ≥ 1 catalog entry EXCEPT the
 *      baselined uncovered prefixes (same shrink-only + stale rules), and the
 *      computed-site COUNT is pinned so a new computed emit site is a reviewed
 *      diff, never a silent addition;
 *   5. ADR 0627 D2 (`CRMWF-3`) — the ONE computed prefix a prefix-check cannot
 *      see through, `host.crm.`, is pinned BOTH ways against the backend's
 *      closed-world `CRM_EVENT_TYPES` (derived from `CRM_EVENT_VERBS`, the type
 *      `crmMutated` is compiled against): catalog ∩ `host.crm.*` == that set;
 *   6. ADR 0643 D3 (`KBWF-5`) — the same both-directions pin for `host.kb.`
 *      against `KB_EVENT_TYPES` (`features/kb/emit.ts`), at an exact count of 6.
 *      `host.kb.document.updated` used to sit in the shrink-only baseline as an
 *      emitted-but-uncatalogued type; D3 catalogued it (the row is REMOVED from the
 *      baseline, never re-baselined) and the pin keeps the six rows and the six
 *      verbs from drifting apart in either direction.
 *
 * Cross-tree read from disk, the `agent-prompt-tool-ids.test.ts` shape: the
 * frontend file is data here, not an import.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** ADR 0627 D2 — the closed-world `host.crm.*` type count (10 entities:
 *  contact 7 + company 6 + deal 7 + task 5 + activity 2 + segment 3 +
 *  pipeline 3 + fielddef 2 + booking-link 1 + sign-request 5). */
const CRM_EVENT_TYPE_COUNT = 41;
import { CRM_EVENT_TYPES } from '../src/features/crm/emit.js';
/** ADR 0643 D3 — the closed-world `host.kb.*` type count (2 entities:
 *  document 3 — ingested/updated/deleted — + reindex 3 — started/completed/failed). */
const KB_EVENT_TYPE_COUNT = 6;
import { KB_EVENT_TYPES } from '../src/features/kb/emit.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '../src');
const CATALOG = join(here, '../../../frontend/react/src/settings/hostEventCatalog.ts');
const BASELINE = join(here, 'fixtures/host-event-catalog-baseline.json');

const USERS_EVENTS = [
  'host.users.user.provisioned',
  'host.users.user.deactivated',
  'host.users.user.reactivated',
  'host.users.user.erased',
];

interface Baseline {
  /** Fully-known emitted types NOT yet in the catalog (shrink-only). */
  missingTypes: string[];
  /** Computed `host.<x>.` prefixes with NO catalog entry under them (shrink-only). */
  uncoveredComputedPrefixes: string[];
  /** Number of distinct computed prefixes found (pinned; a change is a reviewed diff). */
  computedSiteCount: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Drop block comments and `//` line comments (not inside a string/URL). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const LITERAL = /'(host\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)'/g;
const TEMPLATE_PREFIX = /`(host\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.)\$\{/g;

function scan(): { files: number; emitterFiles: string[]; literal: Map<string, string>; computed: Map<string, string> } {
  const files = walk(SRC_DIR);
  const emitterFiles: string[] = [];
  const literal = new Map<string, string>();
  const computed = new Map<string, string>();
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    if (!/emitHostEvent\(|deliverHostExtEvent\(/.test(raw)) continue;
    emitterFiles.push(f);
    const code = stripComments(raw);
    for (const m of code.matchAll(LITERAL)) if (!literal.has(m[1]!)) literal.set(m[1]!, f);
    for (const m of code.matchAll(TEMPLATE_PREFIX)) if (!computed.has(m[1]!)) computed.set(m[1]!, f);
  }
  return { files: files.length, emitterFiles, literal, computed };
}

function catalog(): Set<string> {
  const src = readFileSync(CATALOG, 'utf8');
  const arr = /KNOWN_HOST_EVENT_TYPES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  expect(arr, 'KNOWN_HOST_EVENT_TYPES literal not found in hostEventCatalog.ts — this gate is inert').toBeTruthy();
  return new Set([...stripComments(arr![1]!).matchAll(/'(host\.[^']+)'/g)].map((m) => m[1]!));
}

function baseline(): Baseline {
  expect(existsSync(BASELINE), `baseline fixture missing: ${BASELINE}`).toBe(true);
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

describe('host-event catalog parity (ADR 0617 D4)', () => {
  const s = scan();
  const known = catalog();
  const base = baseline();
  const rel = (f: string) => f.slice(SRC_DIR.length + 1);

  it('anti-vacuity: the scan found a real corpus and the catalog is non-empty', () => {
    expect(s.files).toBeGreaterThan(500);
    expect(s.emitterFiles.length).toBeGreaterThanOrEqual(15);
    expect(s.literal.size).toBeGreaterThanOrEqual(25);
    expect(s.computed.size).toBeGreaterThanOrEqual(5);
    expect(known.size).toBeGreaterThanOrEqual(30);
    // The dispatcher's OWN docblock names `host.crm.deal.stage-changed` in a
    // comment (and the file defines `emitHostEvent(`, so it IS scanned): comment
    // stripping must attribute NO literal to that file.
    expect(s.emitterFiles.some((f) => f.endsWith('hostEventDispatcher.ts'))).toBe(true);
    expect([...s.literal.values()].filter((f) => f.endsWith('hostEventDispatcher.ts'))).toEqual([]);
  });

  it("ADR 0617's four host.users.user.* types are emitted from features/users/emit.ts AND catalogued", () => {
    for (const t of USERS_EVENTS) {
      expect(s.literal.get(t), `${t} is not emitted anywhere`).toMatch(/features\/users\/emit\.ts$/);
      expect(known.has(t), `${t} is missing from KNOWN_HOST_EVENT_TYPES`).toBe(true);
    }
  });

  it('every fully-known emitted type is catalogued, except the shrink-only baseline', () => {
    const misses = [...s.literal.keys()].filter((t) => !known.has(t)).sort();
    const baselined = new Set(base.missingTypes);
    const unexpected = misses.filter((t) => !baselined.has(t));
    expect(
      unexpected,
      `these emitted host-event types are NOT in KNOWN_HOST_EVENT_TYPES (add them to the catalog — never to the baseline):\n${unexpected.map((t) => `  ${t}  <- ${rel(s.literal.get(t)!)}`).join('\n')}`,
    ).toEqual([]);
    const stale = base.missingTypes.filter((t) => !misses.includes(t)).sort();
    expect(
      stale,
      `stale baseline — these types are catalogued (or no longer emitted); remove them from host-event-catalog-baseline.json:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every computed `host.<x>.` prefix has ≥1 catalog entry, except the shrink-only baseline; the site count is pinned', () => {
    const uncovered = [...s.computed.keys()].filter((p) => ![...known].some((k) => k.startsWith(p))).sort();
    const baselined = new Set(base.uncoveredComputedPrefixes);
    const unexpected = uncovered.filter((p) => !baselined.has(p));
    expect(
      unexpected,
      `these computed host-event prefixes have NO catalog entry (expand the suffix set into the catalog):\n${unexpected.map((p) => `  ${p}  <- ${rel(s.computed.get(p)!)}`).join('\n')}`,
    ).toEqual([]);
    const stale = base.uncoveredComputedPrefixes.filter((p) => !uncovered.includes(p)).sort();
    expect(stale, `stale baseline — these prefixes are now covered; remove them:\n${stale.join('\n')}`).toEqual([]);
    expect(
      s.computed.size,
      `computed-site count moved (${s.computed.size} vs baseline ${base.computedSiteCount}) — a new template-built emit site must be reviewed: ${[...s.computed.keys()].join(', ')}`,
    ).toBe(base.computedSiteCount);
  });

  it('ADR 0627 D2 — the catalog\'s host.crm.* rows equal the backend\'s closed-world CRM_EVENT_TYPES, both directions', () => {
    // Anti-vacuity: the backend set is derived from the verb table and is
    // pinned EXACTLY (review S6 — a `>= 39` floor lets a verb vanish or a
    // duplicate appear unnoticed). Adding a verb to `CRM_EVENT_VERBS` moves this
    // number on purpose: bump the constant in the same change as the catalog row.
    expect(CRM_EVENT_TYPES.length).toBe(CRM_EVENT_TYPE_COUNT);
    expect(new Set(CRM_EVENT_TYPES).size).toBe(CRM_EVENT_TYPES.length);
    const catalogued = [...known].filter((k) => k.startsWith('host.crm.')).sort();
    const emitted = [...CRM_EVENT_TYPES].sort();
    const notCatalogued = emitted.filter((t) => !known.has(t));
    const notEmittable = catalogued.filter((t) => !(CRM_EVENT_TYPES as readonly string[]).includes(t));
    expect(notCatalogued, `backend can emit these host.crm.* types but the bindings catalog does not list them (add the rows):\n${notCatalogued.join('\n')}`).toEqual([]);
    expect(notEmittable, `catalogued host.crm.* rows the backend cannot emit (a binding on them can never fire — remove the row or add the verb to CRM_EVENT_VERBS):\n${notEmittable.join('\n')}`).toEqual([]);
    expect(catalogued).toEqual(emitted);
  });

  it('ADR 0643 D3 — the catalog\'s host.kb.* rows equal the backend\'s closed-world KB_EVENT_TYPES, both directions', () => {
    // Pinned EXACTLY for the reason the CRM leg is (review S6): a floor lets a verb
    // vanish or a duplicate appear unnoticed. Adding a verb to `KB_EVENT_VERBS`
    // moves this number on purpose — bump it in the same change as the catalog row.
    expect(KB_EVENT_TYPES.length).toBe(KB_EVENT_TYPE_COUNT);
    expect(new Set(KB_EVENT_TYPES).size).toBe(KB_EVENT_TYPES.length);
    const catalogued = [...known].filter((k) => k.startsWith('host.kb.')).sort();
    const emitted = [...KB_EVENT_TYPES].sort();
    const notCatalogued = emitted.filter((t) => !known.has(t));
    const notEmittable = catalogued.filter((t) => !(KB_EVENT_TYPES as readonly string[]).includes(t));
    expect(notCatalogued, `backend can emit these host.kb.* types but the bindings catalog does not list them (add the rows):\n${notCatalogued.join('\n')}`).toEqual([]);
    expect(notEmittable, `catalogued host.kb.* rows the backend cannot emit (a binding on them can never fire — remove the row or add the verb to KB_EVENT_VERBS):\n${notEmittable.join('\n')}`).toEqual([]);
    expect(catalogued).toEqual(emitted);
    // The baseline must NOT still carry the pre-D3 miss: draining it is the point.
    expect(base.missingTypes).not.toContain('host.kb.document.updated');
  });

  it('a catalogued type is a real claim: every non-computed catalog entry is emitted somewhere', () => {
    // A catalog row for a type nothing emits is a promise the bindings UI makes
    // that no run can keep. Entries under a computed prefix are covered by the
    // prefix check above; the rest must appear as a literal at an emit site.
    const computedPrefixes = [...s.computed.keys()];
    const orphans = [...known].filter((k) => !s.literal.has(k) && !computedPrefixes.some((p) => k.startsWith(p))).sort();
    expect(orphans, `catalogued but never emitted:\n${orphans.join('\n')}`).toEqual([]);
  });
});
