/**
 * ADR 0604 review H1 — the ratchet over RUN-CREATION SITES THAT COPY ANOTHER
 * RUN'S METADATA.
 *
 * WHY THIS POPULATION, AND NOT THE ONE THE ADR ORIGINALLY WALKED. ADR 0604 §D1
 * closed "a born-OFF run acquires compaction on `:fork`" and said the
 * enumeration was done "by call graph". It was — over the READERS of
 * `run.metadata.compaction`. The property that actually needed enumerating is
 * the WRITE side: which run creators hand `insertRunWithStartContext` a
 * metadata blob COPIED from an existing run, rather than a fresh one. Every
 * such site must pass `derivedFromRun: true`, because the no-overwrite merge in
 * `stampRunStartContext` only protects a key that EXISTS — on a copied blob an
 * ABSENT key is inherited state, not a hole to fill.
 *
 * `derivedFromRun` had exactly ONE call site repo-wide when §D1 shipped
 * (`routes/runs.ts` `:fork`). The redrive route
 * (`POST /v1/host/openwop-app/runs/redrive`) was the second copier and had
 * none, so it HALF-inherited: a present decision survived, an absent one was
 * re-resolved against the live toggle. Proved by execution, not by reading.
 *
 * ── THE INSTRUMENT, AND WHAT EACH LEG CAN AND CANNOT SEE ──
 *
 *  1. EXHAUSTIVE CLASSIFICATION (primary). The population is every non-test
 *     `src/**` file that inserts a run — `insertRunWithStartContext(` (the
 *     ADR 0099 seam) OR a bare `.insertRun(` (the two lanes that deliberately
 *     bypass it). A new run creator fails this file until somebody answers
 *     "where does this run's metadata come from?".
 *  2. `loadsExistingRun` is DERIVED FROM THE SOURCE, never declared. A file
 *     that both loads a run and creates one is where this defect can live, so a
 *     `FRESH` row in such a file must carry a real explanation of why the
 *     loaded run's metadata does not flow into the new one. That is the leg
 *     aimed at the judgment, not at the paperwork: the redrive route would have
 *     been forced to write that sentence and could not have.
 *  3. A COPY FINGERPRINT (secondary, and honestly a heuristic). It matches a
 *     spread of `source*`/`parent*`/`prev*`/`orig*` `.metadata`. It CANNOT see
 *     a copy laundered through a local with none of those names, and it is a
 *     spelling, so it is the third leg and never the only one. Its job is to
 *     catch a row that says FRESH while the file plainly copies — i.e. to make
 *     leg 1 harder to get wrong, not to replace it.
 *
 * The BEHAVIOURAL witness for both live copiers is
 * `test/tool-output-compaction-fork-real-path.test.ts` (real routes, real rows).
 * This file is the population; that file is the proof.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './helpers/stripComments.js';

const SRC = join(process.cwd(), 'src');

type MetadataSource =
  /** The new run's metadata is composed here (literal / client-supplied / host stamps). */
  | 'FRESH'
  /** The new run's metadata is a copy of an EXISTING run's ⇒ MUST pass `derivedFromRun: true`. */
  | 'COPIED_FROM_RUN'
  /** The seam itself — it receives a blob, it does not decide where one came from. */
  | 'SEAM';

/** file → where the inserted run's metadata comes from. A row is REQUIRED. */
const CLASSIFIED: Record<string, { source: MetadataSource; why: string }> = {
  'host/runInsert.ts': {
    source: 'SEAM',
    why: 'Defines insertRunWithStartContext and forwards `derivedFromRun` to stampRunStartContext. It is the consumer of this decision, never the maker.',
  },

  'routes/effectTransportRetrySeam.ts': {
    source: 'FRESH',
    why:
      'The RFC 0173 §D.2 G4 transport-retry seam composes the whole record itself — ' +
      'metadata is the literal `{ seededBy, seam }`. There is no source run: the seam ' +
      'mints a run so the effect it drives has somewhere to be recorded, and nothing ' +
      'is inherited, so there is no provenance to carry.',
  },
  'routes/effectSeamFireSeam.ts': {
    source: 'FRESH',
    why:
      'The RFC 0173 §C.2 fire seam composes the whole record itself — metadata is ' +
      'the literal `{ seededBy, seam }`. There is no source run: the point of the ' +
      'seam is to create a run that drives ONE declared manifest row into the ' +
      'Layer-2 ledger, so a scenario can fork it and read the projection. It loads ' +
      'no run, so the derived leg below does not apply. The run IS created in the ' +
      'CALLER\'s tenant rather than a fixture tenant — the scenario reads ' +
      '`GET /runs/{runId}/effects` back as the same caller, and a foreign-tenant ' +
      'run answers 403 id_tenant_mismatch.',
  },

  'routes/durabilitySeam.ts': {
    source: 'FRESH',
    why:
      'The RFC 0158 durability seam (ADR 0739) accepts a BRAND-NEW run through ' +
      '`buildRunRecord` — the same constructor `POST /runs` uses — with the literal ' +
      'metadata `{ seededBy, durabilityExercise }` plus the host-authoritative ' +
      'actingUserId/owner stamps taken from the caller. It loads no source run: ' +
      'the exercise is what happens to newly ACCEPTED work across a process death ' +
      '(or a double delivery), so there is no frozen decision to inherit and the ' +
      'derived leg below does not apply. Created in the CALLER\'s tenant so the ' +
      'suite can follow the run id it was handed across the restart.',
  },

  'routes/eventLogSeedSeam.ts': {
    source: 'FRESH',
    why:
      'The RFC 0176 era-2 seed seam composes the whole record itself — metadata is the literal ' +
      '`{ seededBy, era }` and there is no source run to copy from, because the point of the seam ' +
      'is to plant a fixture no existing run could produce. It loads no run, so the derived leg ' +
      'below does not apply. It DOES set `eventLogSchemaVersion: 2` explicitly, which is the one ' +
      'field it must not leave to the adapter default (that default is era 3).',
  },

  // ── The two real copiers ──────────────────────────────────────────────
  'routes/runs.ts': {
    source: 'COPIED_FROM_RUN',
    why:
      '`POST /v1/runs/{id}:fork` spreads `sourceRun` and rebuilds metadata from `sourceRun.metadata` ' +
      '(re-deriving only actingUserId + the recorded authority block). ADR 0604 §D1. NOTE: the plain ' +
      '`POST /v1/runs` creator in the same file is FRESH — client metadata through buildRunRecord.',
  },
  'routes/workflowDebug.ts': {
    source: 'COPIED_FROM_RUN',
    why:
      'The bulk redrive copies `source.metadata`, deleting caller provenance and keeping execution ' +
      'parameters. ADR 0604 review H1 — this is the site the §D1 enumeration missed. (The debug-run ' +
      'creator in the same file is FRESH: `metadata: { launch: "draft" }` plus host stamps.)',
  },

  // ── Fresh creators that ALSO load a run (leg 2: each must say why) ─────
  'executor/subWorkflowDispatcher.ts': {
    source: 'FRESH',
    why:
      'The child run is built with `metadata: {}`. The parent is reached only for the ancestor-cycle ' +
      'walk and the variable-bag snapshot (`snapshotRunVariables`), which projects INPUTS via ' +
      'inputMapping — never the parent metadata blob. A child is a new unit of work, not a copy.',
  },
  'host/canvasSurface.ts': {
    source: 'FRESH',
    why:
      'The canvas child run is built with `metadata: { causationCanvasId }` only. `storage.getRun` is ' +
      'used solely to walk parentRunId for the depth/cycle guard; the ancestor rows are read for their ' +
      'workflowId and discarded. (The `c.metadata` spreads in this file are CANVAS records, not runs.)',
  },
  'host/mcpSemantics.ts': {
    source: 'FRESH',
    why:
      'Every MCP-originated run composes its own metadata literal (launchResolved / source / ' +
      'trustBoundary: "untrusted", RFC 0020 §D). Its run reads serve the MCP resource/status surface, ' +
      'never run creation — an inbound MCP call is a new untrusted origin, so inheriting anything ' +
      'from an existing run would launder that trust boundary.',
  },
  'host/workflowEvalRunner.ts': {
    source: 'FRESH',
    why:
      'Each eval case builds `metadata: { launch: "draft" }` plus the host-side `launchResolved` / ' +
      '`eval` stamps. It reads runs back only to settle the case verdict, after creation.',
  },
  'features/crm/routes.ts': {
    source: 'FRESH',
    why:
      'The triage run composes `metadata: { crm, featureVariant }` from the CONTACT row and the toggle ' +
      'assignment. The run reads in this file serve the CRM run-status views, not run creation.',
  },
  'routes/artifactTypeSeam.ts': {
    source: 'FRESH',
    why:
      'The RFC 0142 leg-B witness calls `buildRunRecord` with no metadata at all, then polls ' +
      '`getRun` for terminality. The poll is strictly AFTER the insert.',
  },
  'routes/compensationSeam.ts': {
    source: 'FRESH',
    why:
      'Both creators (the seam workflow and its §21 replay) use `metadata: {}`. The replay links to its ' +
      'source through `parentRunId` + `forkMode: "replay"` and `replayInvocationsFromRunId` — the ' +
      'EVENT stream, not the metadata blob. Nothing is copied.',
  },
  'routes/triggerBridge.ts': {
    source: 'FRESH',
    why:
      'The trigger-delivered run composes launchResolved + triggerData + `trustBoundary: "untrusted"` ' +
      'from the DELIVERY, not from a run. Its run reads back the row for the driver response.',
  },

  // ── Fresh creators that never load a run ──────────────────────────────
  'host/runStarter.ts': {
    source: 'FRESH',
    why: 'The shared starter composes `stripReservedRunMetadata(input.metadata)` + launchResolved from its CALLER, never from a run row.',
  },
  'host/triggerIngestionService.ts': {
    source: 'FRESH',
    why: 'Ingestion builds the run metadata from the inbound delivery envelope.',
  },
  'host/workforceService.ts': {
    source: 'FRESH',
    why: 'Demo-seed history rows are SYNTHESISED by generateWorkforceHistory from a deterministic seed; there is no source run to copy.',
  },
  'host/workforceEval.ts': {
    source: 'FRESH',
    why: 'Bare `storage.insertRun` for a synthesised eval row; its metadata is composed in place.',
  },
  'host/anonymousActor.ts': {
    source: 'FRESH',
    why:
      'Bare `storage.insertRun` (ADR 0604 TOCC-1, recorded not fixed) with `metadata: { principalKind, ' +
      'anonPrincipal }`. Deliberately bypasses the seam, so it has no decision to inherit OR to freeze.',
  },
  'routes/anonSurfaceSeam.ts': {
    source: 'FRESH',
    why: 'The anon-surface seam composes its own run metadata; bare insertRun for the same reason as anonymousActor.',
  },
  'host/kanbanTriggerDelivery.ts': {
    source: 'FRESH',
    why: 'The shared card-trigger delivery adapter composes `launchResolved` plus the board/card transition attribution from the triggering card and resolved board/roster. It reads no source run and never copies another run metadata blob; moving this responsibility out of routes/kanban.ts preserves the one trigger bridge without changing its fresh-origin provenance.',
  },
  'features/workflow-author/routes.ts': {
    source: 'FRESH',
    why: 'The AI-authoring draft run is created from the draft request through buildRunRecord.',
  },
  'features/creative-briefs/routes.ts': {
    source: 'FRESH',
    why: 'The brief-render run is created from the brief request through buildRunRecord.',
  },
  'routes/testSeam.ts': {
    source: 'FRESH',
    why: 'The conformance test seam inserts purpose-built rows whose metadata is written literally in place.',
  },
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
  });
}

/**
 * CODE ONLY. Every assertion below greps for a CALL, and the H1 fix ships a
 * 20-line comment that names `derivedFromRun: true` in prose — so an
 * un-stripped read would let the docblock satisfy the gate after the argument
 * was deleted. MEASURED: the first draft of this file was green under exactly
 * that sabotage.
 */
const src = (f: string): string => stripComments(readFileSync(join(SRC, f), 'utf8'));

/** Every non-test file that INSERTS a run — through the seam or around it. */
const creators = walk(SRC)
  .filter((f) => !f.includes('__tests__'))
  .filter((f) => {
    const s = readFileSync(f, 'utf8');
    return /insertRunWithStartContext\s*\(/.test(s) || /\.insertRun\s*\(/.test(s);
  })
  .map((f) => f.slice(SRC.length + 1))
  .filter((f) => !f.startsWith('storage/'));

/** Leg 2 — derived from the source, never declared: does this file also LOAD a run? */
const loadsExistingRun = (f: string): boolean => /loadOwnedRun\s*\(|\.getRun\s*\(|\bgetRun\s*\(/.test(src(f));

/** Leg 3 — the heuristic copy fingerprint (see the header for its blind spot). */
const COPY_FINGERPRINT = /\.\.\.\s*\(*\s*(?:source|src|parent|prior|previous|prev|original|orig)\w*\.metadata\b/i;

describe('ADR 0604 H1 — every run-creation site declares where its metadata came from', () => {
  it('found the creators at all (anti-vacuity)', () => {
    // A renamed seam or a broken walk returns [] and makes every loop below
    // vacuously green — the exact shape of gate this repo has been burned by.
    expect(creators).toContain('routes/runs.ts');
    expect(creators).toContain('routes/workflowDebug.ts');
    expect(creators).toContain('host/anonymousActor.ts'); // a bare-insertRun lane
    expect(creators.length).toBeGreaterThanOrEqual(20);
  });

  it('NO unclassified creator — a new run-creation path must fail here', () => {
    const unclassified = creators.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      'a new run-creation site appeared. Add a row to CLASSIFIED answering "where does this run\'s ' +
        'metadata come from?": FRESH (composed here) or COPIED_FROM_RUN (a copy of an existing run\'s ' +
        'blob — then it MUST pass `derivedFromRun: true`, or an absent frozen decision is silently ' +
        're-resolved against live config).',
    ).toEqual([]);
  });

  it('the classification is not stale — every row still inserts a run', () => {
    for (const f of Object.keys(CLASSIFIED)) {
      expect(creators, `${f} is classified but no longer creates a run — remove the row`).toContain(f);
    }
  });

  it('every COPIED_FROM_RUN site passes derivedFromRun: true', () => {
    const copiers = Object.entries(CLASSIFIED).filter(([, v]) => v.source === 'COPIED_FROM_RUN');
    expect(copiers.length, 'the loop below is vacuous with no copier rows').toBeGreaterThanOrEqual(2);
    for (const [f] of copiers) {
      expect(
        src(f),
        `${f} copies another run's metadata but never passes derivedFromRun: true — an ABSENT frozen ` +
          'decision will be re-resolved against live config, which is the ADR 0604 §D1 defect.',
      ).toMatch(/derivedFromRun:\s*true/);
    }
  });

  it('no FRESH site passes derivedFromRun (the flag and the row cannot disagree)', () => {
    for (const [f, v] of Object.entries(CLASSIFIED)) {
      if (v.source !== 'FRESH') continue;
      expect(src(f), `${f} is classified FRESH but passes derivedFromRun — one of the two is wrong`)
        .not.toMatch(/derivedFromRun:\s*true/);
    }
  });

  it('a FRESH site that ALSO loads a run must explain why the loaded metadata does not flow in', () => {
    // The derived leg. This is where the defect can actually live, and the row
    // is only worth having if it forces the judgment rather than the paperwork.
    const risky = creators.filter((f) => CLASSIFIED[f]?.source === 'FRESH' && loadsExistingRun(f));
    expect(risky.length, 'derivation broke: no FRESH creator reads a run, which cannot be true').toBeGreaterThanOrEqual(6);
    for (const f of risky) {
      expect(
        CLASSIFIED[f]!.why.length,
        `${f} both loads an existing run and creates one, and is classified FRESH. Its \`why\` must say ` +
          'what the loaded run is read FOR and why its metadata does not reach the new run.',
      ).toBeGreaterThan(120);
    }
  });

  it('leg 3 — no FRESH site carries the copy fingerprint', () => {
    const flagged = creators.filter((f) => CLASSIFIED[f]?.source === 'FRESH' && COPY_FINGERPRINT.test(src(f)));
    expect(
      flagged,
      'this file spreads a source/parent run\'s `.metadata` but is classified FRESH. Either the row is ' +
        'wrong (make it COPIED_FROM_RUN and pass derivedFromRun) or the spread is not a run copy — say ' +
        'which in the `why`.',
    ).toEqual([]);
  });

  it('leg 3 is not vacuous — the fingerprint DOES fire on the known copiers', () => {
    // A fingerprint that matches nothing would make the assertion above pass
    // forever. Prove it can see the two sites we already know about.
    for (const f of ['routes/runs.ts', 'routes/workflowDebug.ts']) {
      expect(COPY_FINGERPRINT.test(src(f)), `the copy fingerprint no longer matches ${f}`).toBe(true);
    }
  });
});
