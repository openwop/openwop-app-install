/**
 * WHD-7 — this host's hand-written v2 projection is held to the corpus's.
 *
 * WHY A PARITY TEST AND NOT AN IMPORT. The TODO said "adopt
 * `stripSupported()` / `carriesUnspliceablePayload()` from
 * `@openwop/openwop-conformance/lib/v2-projection`, replacing the hand-written
 * v2 projection in `routes/discovery.ts`". Two things about that sentence did
 * not survive being measured against the installed 2.32.0 package:
 *
 *   1. The path does not exist. The helper ships as SOURCE only —
 *      `src/lib/v2-projection.ts`. `dist/lib/` holds 13 compiled modules and
 *      this is not one of them, and the package has no `exports` map, so the
 *      one importable spelling is `…/src/lib/v2-projection.js`, which resolves
 *      under vitest (the same spelling `bound-id.js` and `profiles.js` are
 *      imported by elsewhere in this directory) and under nothing else.
 *   2. Even a compiled copy would be unreachable from `src/`. The conformance
 *      package is a devDependency and the runtime image is `npm ci --omit=dev`
 *      (Dockerfile:85). An import from production source typechecks, passes
 *      every test here, and fails to resolve at boot — ADR 0550 P2 is the last
 *      time precisely that shipped.
 *
 * So the adoption a devDependency permits is this file: `discovery.ts` keeps a
 * local mirror, and the mirror plus every family it feeds are asserted against
 * the corpus function over this host's REAL documents. Four hand-written
 * projections went wrong in one week (`selfHosted` `string[]`→`boolean`,
 * `aiProviders.input`, `.policies`, and the v1-only
 * `workflowChainPacks.deferredParameters`). Writing this found the FIFTH:
 * `workflowChainPacks.subChains` was the literal `{}` — unconditional where the
 * v1 owner withdraws it under `OPENWOP_CHAIN_SUBCHAINS=0`, and missing the
 * `maxDepth` the v2 sub-object declares. Both legs are pinned below.
 *
 * WHAT IT DOES NOT DO. `stripSupported()` strips `supported`; it cannot know
 * that a facet is v1-only, and says so ("it deliberately does NOT invent
 * shape"). The `deferredParameters` class is therefore caught here by reading
 * the closed v2 record's key set, not by the helper. `adr0670-v2-advert-
 * validates` holds the full-schema validation; this file is about AGREEMENT
 * between two majors and two implementations, which that one cannot see.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripSupported as corpusStripSupported,
  carriesUnspliceablePayload,
} from '@openwop/openwop-conformance/src/lib/v2-projection.js';
import { buildAdvertisement, buildV2Advertisement, stripSupported as hostStripSupported } from '../src/routes/discovery.js';
import { MAX_SUB_CHAIN_DEPTH } from '../src/host/workflowChainPackLoader.js';
import { loadConfigFromEnv } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The four seats every v2 record carries that are NOT facets (`capabilities.md` §3). */
const RECORD_ENVELOPE = new Set(['status', 'since', 'until', 'witness']);

/**
 * Shared facets whose v2 value DELIBERATELY differs from the projected v1 value.
 * Each is a real shape change recorded in `discovery.ts`, not a tolerance: the
 * staleness leg below reds the moment an entry stops differing, so this list
 * cannot quietly outlive its reasons.
 */
const DELIBERATE_SHAPE_CHANGES: Readonly<Record<string, string>> = {
  'aiProviders.authModes': 'v1 is a per-provider MAP, v2 a flat mode VOCABULARY; the map rides the `openwop-app.ai-providers` extension',
  'aiProviders.selfHosted': 'v1 is the LIST of self-hosted provider ids, v2 a BOOLEAN; the ids ride `providers`',
};

/**
 * v1 facets the v2 record DECLARES a seat for and this host does not fill.
 * Under-advertising, which `discovery.ts` itself calls "not the safe direction"
 * — but each needs a decision about its v2 shape, which is not this file's to
 * make. Pinned as a SHRINK-ONLY ledger so the set cannot grow unnoticed (a new
 * v1 facet with a v2 home reds here) and an entry that gets projected must be
 * deleted in the same change.
 */
const KNOWN_UNPROJECTED: ReadonlySet<string> = new Set([
  'aiProviders.byok',
  'aiProviders.policies',
  'aiProviders.imageGeneration',
  'aiProviders.videoGeneration',
  'aiProviders.speechSynthesis',
  'aiProviders.realtimeVoice',
  'aiProviders.maxInlineMediaBytes',
  'envelopes.reliability',
]);

function readSchema(...segments: string[]): Rec {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, 'schemas', ...segments), 'utf8'));
  if (!isRec(parsed)) throw new Error(`${segments.join('/')} is not a JSON object`);
  return parsed;
}

function schemaProperties(schema: Rec): Rec {
  const props = schema['properties'];
  return isRec(props) ? props : {};
}

function countSupportedSeats(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countSupportedSeats(v), 0);
  if (!isRec(value)) return 0;
  return Object.entries(value).reduce((n, [k, v]) => n + (k === 'supported' ? 1 : 0) + countSupportedSeats(v), 0);
}

/** The v1 document carries each family twice — at the root and mirrored under `capabilities`. Either is the owner's output. */
function v1FamilyRecord(v1: Rec, family: string): Rec | undefined {
  const atRoot = v1[family];
  if (isRec(atRoot)) return atRoot;
  const caps = v1['capabilities'];
  const mirrored = isRec(caps) ? caps[family] : undefined;
  return isRec(mirrored) ? mirrored : undefined;
}

/** A v2 FAMILY record is an object carrying the record envelope — which excludes `implementation`, `extensions` and the metadata keys. */
function v2Families(v2: Rec): [string, Rec][] {
  const out: [string, Rec][] = [];
  for (const [k, v] of Object.entries(v2)) {
    if (isRec(v) && typeof v['status'] === 'string' && typeof v['witness'] === 'string') out.push([k, v]);
  }
  return out;
}

function buildBoth(): { v1: Rec; v2: Rec } {
  const config = loadConfigFromEnv();
  return { v1: buildAdvertisement(config), v2: buildV2Advertisement(config) };
}

const ENV_KEYS = ['OPENWOP_CHAIN_SUBCHAINS', 'OPENWOP_TEST_TRIGGER_COMPACTION'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  // `buildAdvertisement` reads the storage tier (`workspaceAdvertisable`), so an
  // unset DSN throws before a single facet is compared.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('WHD-7 — the corpus helper is really the thing being compared against', () => {
  it('imports the corpus function, and it does what its docblock says — at every depth, through arrays, out of required[]', () => {
    // A parity test against a no-op is green forever. This pins the ORACLE
    // first, on a literal whose answer is known without running anything.
    const input = {
      supported: true,
      facet: { supported: true, kept: 1 },
      list: [{ supported: false, id: 'a' }, 'scalar'],
      required: ['supported', 'kept'],
      inner: { required: ['supported'] },
    };
    expect(corpusStripSupported(input)).toEqual({
      facet: { kept: 1 },
      list: [{ id: 'a' }, 'scalar'],
      required: ['kept'],
      inner: {},
    });
  });

  it("this host's v1 document is a real workload for it — well over a hundred `supported` seats, none after", () => {
    const { v1 } = buildBoth();
    // ADR 0670 measured 168. The floor is a vacuity guard, not a census: what
    // matters is that the comparison below is over a document that HAS seats.
    expect(countSupportedSeats(v1)).toBeGreaterThan(100);
    expect(countSupportedSeats(corpusStripSupported(v1))).toBe(0);
  });
});

describe("WHD-7 — discovery.ts's local stripSupported() is a mirror of the corpus function", () => {
  it('agrees on the whole v1 document this host actually serves', () => {
    const { v1 } = buildBoth();
    expect(hostStripSupported(v1)).toEqual(corpusStripSupported(v1));
  });

  it('agrees on the inputs the v1 document does not happen to contain — arrays of records and required[]', () => {
    // The mirror used to recurse into objects only. No advert value carries a
    // `supported` inside an array TODAY, which is exactly why the gap was
    // invisible: agreement on the inputs you have is not agreement.
    const cases: Rec[] = [
      { lanes: [{ supported: true, lane: 'oidc' }, { lane: 'saml', nested: [{ supported: false }] }] },
      { required: ['supported'] },
      { required: ['supported', 'status'], properties: { supported: { type: 'boolean' }, status: {} } },
      { a: null, b: 0, c: '', d: [null, [{ supported: true, e: 1 }]] },
    ];
    for (const c of cases) expect(hostStripSupported(c), JSON.stringify(c)).toEqual(corpusStripSupported(c));
  });
});

describe('WHD-7 — every family this host advertises at BOTH majors agrees with the corpus projection of its v1 record', () => {
  it('the v2 document is a fixed point of the projection — projecting it again changes nothing', () => {
    // The `supported: true` class. `adr0670` walks for the key; this asks the
    // corpus function the same question, so a change to what the corpus strips
    // (it already reaches into `required[]`) arrives here without an edit.
    const { v2 } = buildBoth();
    expect(corpusStripSupported(v2)).toEqual(v2);
  });

  it('shared facets are EQUAL to the projected v1 facet, except the recorded shape changes', () => {
    const { v1, v2 } = buildBoth();
    const compared: string[] = [];
    const familiesCompared = new Set<string>();
    const drift: string[] = [];
    const differing = new Set<string>();
    for (const [family, record] of v2Families(v2)) {
      const v1Record = v1FamilyRecord(v1, family);
      if (v1Record === undefined) continue; // a v2-born family (`runList`, `packs`…) has nothing to agree with
      const projected = corpusStripSupported(v1Record);
      for (const [facet, v2Value] of Object.entries(record)) {
        if (RECORD_ENVELOPE.has(facet) || !(facet in projected)) continue;
        const id = `${family}.${facet}`;
        compared.push(id);
        familiesCompared.add(family);
        if (JSON.stringify(v2Value) === JSON.stringify(projected[facet])) continue;
        differing.add(id);
        if (!(id in DELIBERATE_SHAPE_CHANGES)) {
          drift.push(`${id}: v2 advertises ${JSON.stringify(v2Value)}, the corpus projection of the v1 record is ${JSON.stringify(projected[facet])}`);
        }
      }
    }
    expect(drift, `hand-written v2 facets that DISAGREE with their v1 owner — derive them, or record the shape change with its reason:\n${drift.join('\n')}`).toEqual([]);

    // Non-vacuity, pinned to literals: an empty comparison passes the leg above.
    // MEASURED on 3da7df376+: 29 shared facets across these 11 families.
    expect(compared.length, `only ${compared.length} shared facets were compared: ${compared.join(', ')}`).toBeGreaterThanOrEqual(29);
    expect([...familiesCompared]).toEqual(expect.arrayContaining([
      'limits', 'webhooks', 'prompts', 'secrets', 'modelCapabilities', 'aiProviders',
      'memory', 'envelopes', 'replay', 'feedback', 'workflowChainPacks',
    ]));

    // Staleness: an allowance that no longer differs is a licence nobody holds.
    const stale = Object.keys(DELIBERATE_SHAPE_CHANGES).filter((id) => compared.includes(id) && !differing.has(id));
    expect(stale, `these now AGREE with v1 — delete them from DELIBERATE_SHAPE_CHANGES: ${stale.join(', ')}`).toEqual([]);
  });

  it('a nested v1 facet arrives at major 2 projected, not copied — memory.compaction', () => {
    // The default document has no v1 facet that is itself a `{supported, …}`
    // record with payload AND has a v2 home, except this one, which is
    // env-gated off. Turn it on so the nested arm is exercised by a real owner.
    process.env.OPENWOP_TEST_TRIGGER_COMPACTION = 'true';
    const { v1, v2 } = buildBoth();
    const v1Memory = v1FamilyRecord(v1, 'memory');
    expect(isRec(v1Memory) && isRec(v1Memory['compaction']) && v1Memory['compaction']['supported'], 'the v1 owner must carry the nested seat, or this leg proves nothing').toBe(true);
    const v2Memory = v2['memory'];
    expect(isRec(v2Memory) ? v2Memory['compaction'] : undefined).toEqual({ trigger: 'both' });
  });

  it('carries no facet the closed v2 record does not declare — the `deferredParameters` class', () => {
    const { v1, v2 } = buildBoth();
    const v2Schema = schemaProperties(readSchema('v2', 'capabilities.schema.json'));
    const leaked: string[] = [];
    let checked = 0;
    for (const [family, record] of v2Families(v2)) {
      const familySchema = v2Schema[family];
      const declared = isRec(familySchema) ? schemaProperties(familySchema) : {};
      // A family whose record moved behind a `$ref` would make `declared` empty
      // and every facet "leaked" — loud, which is the right way round.
      expect(Object.keys(declared), `${family}: the v2 schema declares no inline properties`).toEqual(expect.arrayContaining(['status', 'witness']));
      const v1Record = v1FamilyRecord(v1, family);
      for (const facet of Object.keys(record)) {
        checked++;
        if (facet in declared) continue;
        const origin = facet === 'supported'
          ? 'v2 retired the flag (RFC 0192): presence of the record is the claim — route the v1 record through stripSupported()'
          : v1Record !== undefined && facet in v1Record
            ? 'it IS on the v1 record, so this is a v1 facet copied across — no strip removes those, only a named pick does'
            : 'the v2 record declares no such facet, and the v1 record does not carry it either';
        leaked.push(`${family}.${facet} — ${origin}`);
      }
    }
    expect(leaked, leaked.join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });

  it('under-projection is a shrink-only ledger — a v1 facet with a declared v2 seat that major 2 does not fill', () => {
    const { v1, v2 } = buildBoth();
    const v2Schema = schemaProperties(readSchema('v2', 'capabilities.schema.json'));
    const found: string[] = [];
    const nowProjected: string[] = [];
    for (const [family, record] of v2Families(v2)) {
      const v1Record = v1FamilyRecord(v1, family);
      const familySchema = v2Schema[family];
      if (v1Record === undefined || !isRec(familySchema)) continue;
      const declared = schemaProperties(familySchema);
      for (const facet of Object.keys(corpusStripSupported(v1Record))) {
        if (!(facet in declared)) continue;
        const id = `${family}.${facet}`;
        if (facet in record) { if (KNOWN_UNPROJECTED.has(id)) nowProjected.push(id); } else found.push(id);
      }
    }
    const unexpected = found.filter((id) => !KNOWN_UNPROJECTED.has(id));
    expect(unexpected, `v1 advertises these, the v2 record has a seat for them, and major 2 says nothing — project them (through stripSupported) or, if the v2 shape genuinely needs a decision, add them to KNOWN_UNPROJECTED with that decision's owner: ${unexpected.join(', ')}`).toEqual([]);
    expect(nowProjected, `these are projected now — delete them from KNOWN_UNPROJECTED: ${nowProjected.join(', ')}`).toEqual([]);
    // The ledger is only evidence if the probe can see its entries at all.
    expect(found.length, 'the probe found NONE of the known entries — it is not reading what it thinks it is').toBeGreaterThan(0);
  });
});

describe('WHD-7 — workflowChainPacks.subChains, the fifth hand-written projection', () => {
  it('is the v1 owner\'s record minus `supported` — maxDepth included', () => {
    const { v1, v2 } = buildBoth();
    const v1Record = v1FamilyRecord(v1, 'workflowChainPacks');
    expect(isRec(v1Record) ? v1Record['subChains'] : undefined).toEqual({ supported: true, maxDepth: MAX_SUB_CHAIN_DEPTH });
    const v2Record = v2['workflowChainPacks'];
    expect(isRec(v2Record) ? v2Record['subChains'] : undefined).toEqual({ maxDepth: MAX_SUB_CHAIN_DEPTH });
  });

  it('is WITHDRAWN at major 2 when the owner withdraws it — advertising a facet from-chain refuses is a false claim', () => {
    process.env.OPENWOP_CHAIN_SUBCHAINS = '0';
    const { v1, v2 } = buildBoth();
    const v1Record = v1FamilyRecord(v1, 'workflowChainPacks');
    expect(isRec(v1Record) && 'subChains' in v1Record, 'the v1 owner must withdraw it, or this leg proves nothing').toBe(false);
    const v2Record = v2['workflowChainPacks'];
    expect(isRec(v2Record), 'the family itself stays — only the facet goes').toBe(true);
    expect(isRec(v2Record) && 'subChains' in v2Record).toBe(false);
  });
});

describe('WHD-7 — carriesUnspliceablePayload(): no advertised family is a bare record over a lost payload (RFC 0193)', () => {
  it('the probe reproduces known figures from the vendored v1 schema before it is trusted with unknown ones', () => {
    const v1Schema = schemaProperties(readSchema('capabilities.schema.json'));
    // `supportedEnvelopes` is the corpus docblock's own example: an ARRAY at v1,
    // published by a production host as `{status:"stable"}` — a catalog with no
    // catalog. `limits` is an object with properties, so it splices.
    expect(carriesUnspliceablePayload(v1Schema['supportedEnvelopes'])).toBe(true);
    expect(carriesUnspliceablePayload(v1Schema['limits'])).toBe(false);
  });

  it('every family advertised at major 2 either splices, or names a seat for what it carried', () => {
    const { v2 } = buildBoth();
    const v1Schema = schemaProperties(readSchema('capabilities.schema.json'));
    const bare: string[] = [];
    let judged = 0;
    for (const [family, record] of v2Families(v2)) {
      const v1Property = v1Schema[family];
      if (v1Property === undefined) continue; // v2-born: nothing was carried, so nothing can have been lost
      judged++;
      if (!carriesUnspliceablePayload(v1Property)) continue;
      const facets = Object.keys(record).filter((k) => !RECORD_ENVELOPE.has(k));
      if (facets.length === 0) bare.push(family);
    }
    expect(bare, `advertised as a bare {status, since, witness} record although the v1 value WAS the payload — only a person can name the seat (RFC 0193 §B): ${bare.join(', ')}`).toEqual([]);
    expect(judged).toBeGreaterThanOrEqual(14);
  });
});
