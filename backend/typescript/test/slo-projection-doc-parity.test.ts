/**
 * ADR 0556 P2 — `docs/SLO.md` and `SLO_CATALOG` are the same objectives.
 *
 * The pair exists because they answer different questions: the document
 * explains WHY each objective is worded the way it is — and that prose is the
 * most valuable thing this ADR produced, which is exactly why the file is
 * hand-written and not generated — while the table in code is what a machine
 * can evaluate. Two copies of the same facts is the shape this repo has been
 * burned by before (`promptCatalogParity.test.ts`, the "8 stale opt-out
 * entries" that dissolved on a spot-check).
 *
 * So the test is a BIJECTION, not a subset in either direction:
 *
 *   • a row published in the doc with no evaluator is an objective the panel
 *     silently does not watch, which is worse than not publishing it;
 *   • an evaluator with no published row is a threshold nobody agreed to, and
 *     it will page someone;
 *   • a threshold that matches neither is the drift that makes a green panel a
 *     lie, and it is invisible to every other test in this suite.
 *
 * EVERY PARSE HERE GUARDS ITSELF — the ADR 0556 P1 lesson, learned when the
 * cardinality lint reported 18 of 19 metrics and exited 0. A text parser that
 * silently matches nothing passes vacuously, so each parsed set is asserted
 * against an EXACT expected size before anything is compared against it. "Found
 * something" is not the bar; "found all 31" is.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SLO_CATALOG,
  RUNBOOK_DOC,
  githubAnchor,
  projectRows,
  alertsForRow,
  type LabelMatch,
  type MetricSeries,
  type SloObjective,
  type SloRow,
  type SloSpec,
} from '../src/observability/sloProjection.js';
import { METRIC_CATALOG } from '../src/observability/metrics.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLO_DOC = join(REPO_ROOT, 'docs', 'SLO.md');
const RUNBOOK = join(REPO_ROOT, RUNBOOK_DOC);

/** The published objective count. Written out rather than derived from the
 *  catalog, so a row deleted from BOTH sides still goes red and has to be a
 *  deliberate decision. */
const PUBLISHED_OBJECTIVES = 32;

const sloDocText = readFileSync(SLO_DOC, 'utf8');

interface DocRow { id: string; sli: string; objective: string; metric: string }

/**
 * Parse the objective TABLES of `docs/SLO.md`.
 *
 * Keyed on the exact header `| # | SLI | Objective | Metric |` rather than on
 * "any four-column table": the document also carries an alert table and a
 * not-projectable table, and a looser parser would ingest those rows as
 * objectives and then fail comparing them to nothing.
 */
function parseSloDoc(): DocRow[] {
  const rows: DocRow[] = [];
  let inTable = false;
  for (const line of sloDocText.split('\n')) {
    const cells = line.trim().startsWith('|')
      ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      : null;
    if (!cells) { inTable = false; continue; }
    if (cells.length === 4 && cells[0] === '#' && cells[1] === 'SLI') { inTable = true; continue; }
    if (!inTable) continue;
    if (/^-+$/.test(cells[0]!.replace(/[:\s]/g, '') || '-')) continue;
    if (cells.length !== 4) { inTable = false; continue; }
    if (!/^[A-Z]\d+$/.test(cells[0]!)) { inTable = false; continue; }
    rows.push({ id: cells[0]!, sli: cells[1]!, objective: cells[2]!, metric: cells[3]! });
  }
  return rows;
}

/** The `### Not projectable in the Operations panel` table: id → reason. */
function parseNotProjectable(): Map<string, string> {
  const out = new Map<string, string>();
  const section = sloDocText.split('### Not projectable in the Operations panel')[1] ?? '';
  const stop = section.indexOf('\n### ');
  for (const line of (stop === -1 ? section : section.slice(0, stop)).split('\n')) {
    const m = /^\|\s*([A-Z]\d+)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** The first `openwop.*` name in a Metric cell — several cells qualify it with
 *  `{label}` or name a second series for context. */
function metricNameOf(cell: string): string | null {
  return /`(openwop\.[a-z0-9._]+)/.exec(cell)?.[1] ?? null;
}

/**
 * Read a published objective into the numeric target the catalog holds.
 *
 * Returns `null` for a form this parser does not understand, which the test
 * treats as a FAILURE rather than a skip — an unparsed objective is precisely
 * the row whose drift would go unnoticed.
 */
function parseObjective(cell: string): { target: number; comparison: 'at_least' | 'at_most' } | null {
  const text = cell.replace(/\*\*/g, '').trim();
  if (/^0$/.test(text)) return { target: 0, comparison: 'at_most' };
  const m = /^([≥≤])\s*([\d.]+)\s*(%|s|h|days?|min)?/.exec(text);
  if (!m) return null;
  const comparison = m[1] === '≥' ? 'at_least' : 'at_most';
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  switch (m[3]) {
    case '%': return { target: n / 100, comparison };
    case 's': return { target: n, comparison };
    case 'h': return { target: n * 3_600, comparison };
    case 'day': case 'days': return { target: n * 86_400, comparison };
    default: return { target: n, comparison };
  }
}

/**
 * The percentile a `pNN` SLI states, or 1 when it states none.
 *
 * The `else 1` arm is F1's, and it is a DECISION rather than a fallback: "age
 * at read ≤ 7 days" with no percentile means EVERY read, so the share must be
 * 1. Encoded here so the doc's prose and the catalog's number are pinned to
 * each other — if someone adds a `p95` to F1's SLI text, this test goes red
 * until the objective follows.
 */
function percentileOf(sli: string): number {
  const m = /\bp(\d{2})\b/.exec(sli);
  return m ? Number(m[1]) / 100 : 1;
}

const docRows = parseSloDoc();
const docNotProjectable = parseNotProjectable();

describe('ADR 0556 P2 — docs/SLO.md and SLO_CATALOG are in bijection', () => {
  it('parsed EXACTLY the published objectives (the parse guard)', () => {
    // Not ">= something". A regex change that stops matching leaves every
    // comparison below vacuously true, which is the failure this program has
    // now hit in three separate shapes.
    expect(docRows.length).toBe(PUBLISHED_OBJECTIVES);
    expect(SLO_CATALOG.length).toBe(PUBLISHED_OBJECTIVES);
  });

  it('publishes exactly the objectives the projection evaluates', () => {
    expect([...docRows.map((r) => r.id)].sort()).toEqual([...SLO_CATALOG.map((s) => s.id)].sort());
  });

  it('computes each objective from the metric the document names', () => {
    for (const doc of docRows) {
      const spec = SLO_CATALOG.find((s) => s.id === doc.id)!;
      const published = metricNameOf(doc.metric);
      expect(published, `SLO ${doc.id}: no openwop metric in "${doc.metric}"`).not.toBeNull();
      expect(spec.metric, `SLO ${doc.id} metric`).toBe(published);
    }
  });

  it('holds each evaluator\'s threshold to the published target', () => {
    for (const doc of docRows) {
      const spec = SLO_CATALOG.find((s) => s.id === doc.id)!;
      const parsed = parseObjective(doc.objective);
      expect(parsed, `SLO ${doc.id}: could not read objective "${doc.objective}"`).not.toBeNull();
      const { target, comparison } = publishedShapeOf(spec.objective);
      expect(target, `SLO ${doc.id} target`).toBeCloseTo(parsed!.target, 9);
      expect(comparison, `SLO ${doc.id} comparison`).toBe(parsed!.comparison);
    }
  });

  it('holds each percentile row\'s share to the pNN in the published SLI', () => {
    for (const doc of docRows) {
      const spec = SLO_CATALOG.find((s) => s.id === doc.id)!;
      if (spec.objective.kind !== 'threshold_share') continue;
      expect(spec.objective.value, `SLO ${doc.id} percentile vs "${doc.sli}"`)
        .toBeCloseTo(percentileOf(doc.sli), 9);
    }
  });
});

/**
 * What the DOC publishes for an objective, which for a `threshold_share` row is
 * the duration bound (`≤ 1.0 s`) and not the share — the share lives in the SLI
 * text as `pNN` and is pinned separately above.
 */
function publishedShapeOf(o: SloObjective): { target: number; comparison: 'at_least' | 'at_most' } {
  switch (o.kind) {
    case 'ratio_min': return { target: o.value, comparison: 'at_least' };
    case 'ratio_max': return { target: o.value, comparison: 'at_most' };
    case 'threshold_share': return { target: o.threshold, comparison: 'at_most' };
    case 'zero': return { target: 0, comparison: 'at_most' };
    case 'outbox_max': return { target: o.value, comparison: 'at_most' };
  }
}

describe('ADR 0556 P2 — the not-projectable rows are pinned in both places', () => {
  it('parsed the not-projectable table at all', () => {
    expect(docNotProjectable.size).toBe(2);
  });

  it('documents exactly the rows the projection refuses to answer', () => {
    // A row silently BECOMING projectable is the drift this catches: the code
    // would start emitting a number while the doc still says it cannot.
    expect([...docNotProjectable.keys()].sort())
      .toEqual(SLO_CATALOG.filter((s) => s.notProjectable).map((s) => s.id).sort());
  });

  it('gives the same REASON in the doc as the projection returns', () => {
    // Not string equality — the code's reason is longer and carries the fix.
    // The doc's sentence must be the opening of it, so an operator reading
    // either surface gets the same explanation and neither can drift alone.
    for (const [id, docReason] of docNotProjectable) {
      const spec = SLO_CATALOG.find((s) => s.id === id)!;
      const normalise = (t: string) => t.toLowerCase().replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
      expect(normalise(spec.notProjectable!), `SLO ${id} reason`).toContain(normalise(docReason));
    }
  });
});

describe('ADR 0556 P2 — every alert points at a runbook section that exists', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8');
  const headings = runbook.split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim());

  /**
   * Drive EVERY projectable row into a BREACH through the real evaluator, and
   * collect the alert ids the projection actually emits.
   *
   * Walking the catalog would prove nothing about the projection: a
   * `projectSlos` that emitted zero alerts would pass a catalog-only check
   * trivially. So each row is given a snapshot built from ITS OWN filters and
   * ITS metric's real declared buckets, then projected alone — which is also
   * why this is per-row rather than one shared fixture. A single attribute bag
   * cannot satisfy 29 different label predicates, and the first version of this
   * test proved it by leaving eight rows at `empty` while still looking green
   * enough to skim.
   */
  function attributesSatisfying(spec: SloSpec): Record<string, string> {
    const attrs: Record<string, string> = {};
    const apply = (m: LabelMatch | undefined): void => {
      for (const [k, rule] of Object.entries(m ?? {})) {
        if ('in' in rule && rule.in[0] !== undefined) attrs[k] = rule.in[0];
      }
    };
    const o = spec.objective;
    if (o.kind === 'zero' || o.kind === 'threshold_share') apply(o.filter);
    if (o.kind === 'ratio_min' || o.kind === 'ratio_max') {
      // Denominator first so the numerator's narrower constraints win — a point
      // has to satisfy BOTH sides for the ratio to be forced.
      apply(o.denominator?.match);
      apply(o.numerator.match);
    }
    return attrs;
  }

  function bucketsOf(metric: string): readonly number[] {
    return METRIC_CATALOG.find((m) => m.name === metric)?.buckets ?? [1];
  }

  /** One spec, rigged to breach, projected through the shipped code path. */
  function breachOne(spec: SloSpec): SloRow {
    const attrs = attributesSatisfying(spec);
    const o = spec.objective;
    const series: MetricSeries[] = [];
    let rigged: SloSpec = spec;

    if (o.kind === 'threshold_share') {
      // Do NOT move the target — put every observation ABOVE the threshold, so
      // the row breaches on the DATA and the exact-share arithmetic is what is
      // being exercised.
      const boundaries = bucketsOf(spec.metric);
      const counts = new Array<number>(boundaries.length + 1).fill(0);
      counts[counts.length - 1] = 10;
      series.push({ name: spec.metric, kind: 'histogram',
        points: [{ attributes: attrs, histogram: { boundaries, counts, count: 10, sum: 10, max: 10 } }] });
    } else if (o.kind === 'zero') {
      series.push({ name: spec.metric, kind: 'counter', points: [{ attributes: attrs, value: 3 }] });
    } else if (o.kind === 'ratio_min' || o.kind === 'ratio_max') {
      // An unreachable target, plus a point that satisfies the denominator so
      // the row is not `empty` — 0/0 must stay distinguishable from a breach.
      rigged = { ...spec, objective: { ...o, value: o.kind === 'ratio_min' ? 2 : -1 } };
      series.push({ name: spec.metric, kind: 'counter', points: [{ attributes: attrs, value: 5 }] });
      const denomMetric = o.denominator?.metric;
      if (denomMetric) series.push({ name: denomMetric, kind: 'counter', points: [{ attributes: attrs, value: 5 }] });
    } else {
      rigged = { ...spec, objective: { ...o, value: -1 } };
    }

    return projectRows([rigged], {
      snapshot: series,
      lastEmission: new Map(),
      startedAtMs: 0,
      outbox: { pending: 99, dead: 99, oldestAgeS: 9999 },
      seriesLimit: 20_000,
      nowMs: 1_000_000,
    })[0]!;
  }

  const projectable = SLO_CATALOG.filter((s) => !s.notProjectable);

  it('read a runbook with sections in it (the parse guard)', () => {
    // An empty heading list would make every loop below pass by never running
    // an assertion that could fail.
    expect(headings.length).toBeGreaterThanOrEqual(20);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('can actually drive EVERY projectable row to a breach (the guard on the guard)', () => {
    // If any row silently sat at `empty` here, the anchor check below would be
    // checking nothing for it — a partially vacuous test, which is the shape
    // that hides best.
    const notBreaching = projectable.filter((s) => breachOne(s).state !== 'breaching').map((s) => s.id);
    expect(notBreaching).toEqual([]);
    expect(projectable.length).toBe(PUBLISHED_OBJECTIVES - 2);
  });

  it('resolves every EMITTED alert\'s runbook link to a heading in that file', () => {
    const anchors = new Set(headings.map(githubAnchor));
    const emitted: string[] = [];
    for (const spec of projectable) {
      const row = breachOne(spec);
      const alerts = alertsForRow(row);
      expect(alerts.length, `SLO ${spec.id} breached but emitted no alert`).toBe(1);
      const anchor = alerts[0]!.runbook.split('#')[1]!;
      expect(anchors, `SLO ${spec.id} → ${alerts[0]!.runbook}`).toContain(anchor);
      emitted.push(spec.id);
    }
    // The emitted set IS the projectable set — no row quietly absent.
    expect(emitted.sort()).toEqual(projectable.map((s) => s.id).sort());
  });

  it('has a section for the not-projectable rows too, so a reader is not left hanging', () => {
    // They never alert, but an operator WILL click them from the panel.
    for (const spec of SLO_CATALOG.filter((s) => s.notProjectable)) {
      expect(headings).toContain(spec.runbookHeading);
    }
  });

  it('is linked from docs/SLO.md, so the runbook is reachable without the panel', () => {
    expect(sloDocText).toContain('runbooks/slo-alerts.md');
  });
});

describe('ADR 0556 P2 — in-doc cross-references resolve', () => {
  it('names no objective id that does not exist', () => {
    // A row-set bijection would NOT have caught the live instance of this:
    // `docs/SLO.md` said "the rate limiter's own health is A6 below" and there
    // is no A4, A5 or A6. A dangling pointer sends an operator hunting for a
    // row that never existed, at exactly the moment they are deciding whether
    // something is an incident.
    const ids = new Set(SLO_CATALOG.map((s) => s.id));
    const groups = new Set([...ids].map((id) => id[0]!));
    const referenced = new Set<string>();
    for (const line of sloDocText.split('\n')) {
      const t = line.trim();
      // Table rows ARE the definitions, not references to them.
      if (t.startsWith('|')) continue;
      // Blockquotes are CORRECTION NOTES, which legitimately name ids in order
      // to say they do not exist — this file's own A6 correction is the live
      // example, and counting it would make the fix trip the test that caught
      // the bug. Meta-commentary about a reference is not a reference.
      if (t.startsWith('>')) continue;
      for (const m of line.matchAll(/\b([A-Z]\d)\b/g)) {
        if (groups.has(m[1]![0]!)) referenced.add(m[1]!);
      }
    }
    expect(referenced.size).toBeGreaterThan(5);
    const dangling = [...referenced].filter((r) => !ids.has(r)).sort();
    expect(dangling).toEqual([]);
  });
});
