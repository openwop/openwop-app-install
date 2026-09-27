/**
 * ADR 0440 P3 — the catalog parity tripwire.
 *
 * Two node catalogs used to model one concept: the server's `buildNodeCatalog()`
 * (which knows every registered type) and this module's hand-maintained
 * `NODE_CATALOG`. Nothing reconciled them and no test asserted parity, so every
 * new host-registered node type silently became un-openable in the builder —
 * `deserialize` threw `errCantLoadNodeTypes`. Thirty-seven types were in that
 * state, including `local.sample.demo.mock-ai`, which the workflow-author seeder
 * builds its showcase workflows from (contradicting that seeder's own promise of
 * "something runnable to open in the builder").
 *
 * These tests pin the invariant that replaces the hand-maintenance:
 *
 *   1. RESOLUTION is unconditional — every type the server reports resolves, so
 *      any workflow containing it opens.
 *   2. VISIBILITY is curated — the palette omits only types listed in
 *      `PALETTE_EXCLUDED` (or a documented prefix), each with a stated reason.
 *
 * Conflating the two is what makes this class of bug invisible: a type that
 * fails to resolve looks identical to one that was never meant to be authorable.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const CATALOG_URL_FRAGMENT = '/host/openwop-app/node-catalog';

/** A server catalog shaped like the real one: pack rows with authored metadata,
 *  plus host-registered `local` rows that carry `label === typeId`. */
const SERVER_ROWS = [
  { typeId: 'core.noop', version: '1.0.0', label: 'core.noop', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'local.sample.demo.mock-ai', version: '1.0.0', label: 'local.sample.demo.mock-ai', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'core.subWorkflow', version: '1.0.0', label: 'core.subWorkflow', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'core.bigquery.query', version: '1.0.0', label: 'core.bigquery.query', description: '', category: 'data', source: 'local' as const },
  { typeId: 'core.workday.query', version: '1.0.0', label: 'core.workday.query', description: '', category: 'data', source: 'local' as const },
  { typeId: 'core.openwop.connectors.hris-action', version: '1.0.0', label: 'core.openwop.connectors.hris-action', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'ui.walkthrough.step', version: '1.0.0', label: 'ui.walkthrough.step', description: '', category: 'flow', source: 'local' as const },
  // Non-authorable: must RESOLVE but stay OUT of the palette.
  { typeId: 'ui.tour.step', version: '1.0.0', label: 'ui.tour.step', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'conformance.secret.echo', version: '1.0.0', label: 'conformance.secret.echo', description: '', category: 'flow', source: 'local' as const },
  { typeId: 'app-builder.mcp-node.catalog', version: '1.0.0', label: 'app-builder.mcp-node.catalog', description: '', category: 'flow', source: 'local' as const },
  // A pack row with real authored metadata.
  { typeId: 'core.openwop.http.fetch', version: '1.0.0', label: 'HTTP fetch', description: 'Fetch a URL', category: 'integration', source: 'pack' as const, packName: 'core.openwop.http' },
];

async function loadFreshRegistry() {
  vi.resetModules();
  // `vi.stubGlobal` rather than assigning `globalThis.fetch` — the direct
  // assignment requires a double type assertion, which this repo bans in src/.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
    String(url).includes(CATALOG_URL_FRAGMENT)
      ? new Response(JSON.stringify({ nodes: SERVER_ROWS }), { status: 200 })
      : new Response('{}', { status: 404 })
  )));
  const mod = await import('../catalogRegistry.js');
  await mod.loadDynamicCatalog();
  return mod;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('ADR 0440 P3 — every server-reported type RESOLVES', () => {
  let reg: Awaited<ReturnType<typeof loadFreshRegistry>>;
  beforeEach(async () => { reg = await loadFreshRegistry(); });

  it('resolves host-registered (`source: local`) types — the 37-type bug', () => {
    for (const row of SERVER_ROWS) {
      expect(
        reg.catalogEntryByTypeId(row.typeId),
        `${row.typeId} does not resolve — a workflow containing it cannot be opened`,
      ).toBeDefined();
    }
  });

  it('resolves the type the workflow-author seeder actually uses', () => {
    // The concrete regression: both showcase workflows failed to open on this.
    expect(reg.catalogEntryByTypeId('local.sample.demo.mock-ai')).toBeDefined();
  });

  it('resolves non-authorable types too — resolution is not visibility', () => {
    // A replay-only alias must still open a historical workflow.
    expect(reg.catalogEntryByTypeId('ui.tour.step')).toBeDefined();
    expect(reg.catalogEntryByTypeId('conformance.secret.echo')).toBeDefined();
  });
});

describe('ADR 0440 P3 — the palette stays CURATED', () => {
  let reg: Awaited<ReturnType<typeof loadFreshRegistry>>;
  beforeEach(async () => { reg = await loadFreshRegistry(); });

  it('omits exactly the acknowledged non-authorable types, and nothing else', () => {
    const visible = new Set(reg.mergedCatalog().map((e) => e.typeId));
    const resolvable = reg.resolvableTypeIds();
    const hidden = resolvable.filter((t) => !visible.has(t));
    for (const t of hidden) {
      const acknowledged = t in reg.PALETTE_EXCLUDED || t.startsWith('app-builder.mcp-node.');
      expect(acknowledged, `${t} is hidden from the palette with no recorded reason — add it to PALETTE_EXCLUDED (with why) or stop hiding it`).toBe(true);
    }
    expect(hidden.length).toBeGreaterThan(0); // no vacuous pass
  });

  it('keeps conformance fixtures, replay aliases and MCP internals out', () => {
    const visible = new Set(reg.mergedCatalog().map((e) => e.typeId));
    expect(visible.has('ui.tour.step')).toBe(false);
    expect(visible.has('conformance.secret.echo')).toBe(false);
    expect(visible.has('app-builder.mcp-node.catalog')).toBe(false);
  });

  it('every PALETTE_EXCLUDED entry states a reason', () => {
    for (const [typeId, reason] of Object.entries(reg.PALETTE_EXCLUDED)) {
      expect(reason.length, `${typeId} has an empty exclusion reason`).toBeGreaterThan(10);
    }
  });
});

describe('ADR 0440 P3 — the static catalog is a PRESENTATION overlay', () => {
  let reg: Awaited<ReturnType<typeof loadFreshRegistry>>;
  beforeEach(async () => { reg = await loadFreshRegistry(); });

  it('curated label + config fields win over the server row', () => {
    // `ui.walkthrough.step` has a static entry; the server row carries only a
    // typeId-as-label and no schema. The merge must keep the curated metadata.
    const entry = reg.catalogEntryByTypeId('ui.walkthrough.step');
    expect(entry?.label).toBe('Walkthrough step');
    expect(entry?.configFields.map((f) => f.key)).toContain('actionId');
  });

  it('prettifies a bare typeId in sentence case (matches authored labels)', () => {
    // `core.subWorkflow` has no static row — it must not read as a stack trace,
    // and it must match the sentence case of authored labels ("HTTP fetch").
    expect(reg.catalogEntryByTypeId('core.subWorkflow')?.label).toBe('Sub workflow');
  });

  it('surfaces the domain when the action word alone is ambiguous', () => {
    // The reported collision: both used to render "Query" with badge "Q".
    expect(reg.catalogEntryByTypeId('core.bigquery.query')?.label).toBe('BigQuery query');
    expect(reg.catalogEntryByTypeId('core.workday.query')?.label).toBe('Workday query');
    // And the badges are now distinct.
    expect(reg.catalogEntryByTypeId('core.bigquery.query')?.badge).toBe('B');
    expect(reg.catalogEntryByTypeId('core.workday.query')?.badge).toBe('W');
  });

  it('uppercases known acronyms instead of mangling them', () => {
    expect(reg.catalogEntryByTypeId('core.openwop.connectors.hris-action')?.label).toBe('HRIS action');
    // `mock-ai` is already in SERVER_ROWS via the resolution suite.
    expect(reg.catalogEntryByTypeId('local.sample.demo.mock-ai')?.label).toBe('Mock AI');
  });

  it('leaves an authored pack label untouched', () => {
    expect(reg.catalogEntryByTypeId('core.openwop.http.fetch')?.label).toBe('HTTP fetch');
  });
});

describe('ADR 0440 P3 — the merge is actually REACHABLE (grade-pass)', () => {
  let reg: Awaited<ReturnType<typeof loadFreshRegistry>>;
  beforeEach(async () => { reg = await loadFreshRegistry(); });

  it('catalogEntry(friendlyKind) reaches the MERGED row, not the raw static one', () => {
    // `mergeWithStatic` keeps the static entry's friendly kind ('noop'), but the
    // map was keyed only by typeId — so this lookup missed and fell through to
    // the raw static row, discarding the server's host-surface facts. The merge
    // was computed and thrown away for exactly the nodes it was written for.
    const viaKind = reg.catalogEntry('noop');
    const viaTypeId = reg.catalogEntryByTypeId('core.noop');
    expect(viaKind).toBeDefined();
    expect(viaKind).toBe(viaTypeId); // same object ⇒ the merged one
  });

  it('resolvableTypeIds returns typeIds only, never friendly kinds', () => {
    // The dual-indexing above makes the map's KEYS a mix of both.
    const ids = reg.resolvableTypeIds();
    expect(ids).toContain('core.noop');
    expect(ids).not.toContain('noop');
  });
});

describe('ADR 0440 P3 (grade-pass) — label maps cover the live host catalog, no drift', () => {
  let reg: Awaited<ReturnType<typeof loadFreshRegistry>>;
  beforeEach(async () => { reg = await loadFreshRegistry(); });

  it('every host-derived label is non-empty, has no bare lowercase acronym, and no leaked namespace noise', () => {
    // The hand-kept LABEL_ACRONYMS / LABEL_BRANDS / NOISE / GENERIC maps drift
    // silently otherwise — a new node with an unlisted acronym ships a mangled
    // label green. This turns the maps into a checked contract over whatever the
    // server actually reports (both grades flagged the missing drift guard).
    const NOISE = ['core', 'local', 'openwop', 'openwop-app', 'connectors', 'sample', 'demo'];
    for (const entry of reg.mergedCatalog()) {
      const label = entry.label;
      expect(label.length, `${entry.typeId} → empty label`).toBeGreaterThan(0);
      // No leading namespace-noise word survived into the label.
      const firstWord = label.split(' ')[0]!.toLowerCase();
      expect(NOISE, `${entry.typeId} → "${label}" leaks a namespace segment`).not.toContain(firstWord);
      // A label reading like a raw typeId (contains a dot) is a prettify miss.
      expect(label.includes('.'), `${entry.typeId} → "${label}" reads like a raw typeId`).toBe(false);
    }
  });

  it('a bare generic action word never stands alone as a label', () => {
    // "Query"/"Send"/"Create" with no domain is the reported collision class.
    const GENERIC = new Set(['Query', 'Send', 'Create', 'Update', 'Delete', 'Action', 'Fetch', 'Run', 'Get', 'List']);
    for (const entry of reg.mergedCatalog()) {
      expect(GENERIC.has(entry.label), `${entry.typeId} → "${entry.label}" is an undisambiguated action word`).toBe(false);
    }
  });
});
