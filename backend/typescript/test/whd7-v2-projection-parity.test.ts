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
 *
 * ADR 0812 P4 — THE V1 ORACLE IS GONE. `buildAdvertisement` is deleted, so the
 * legs that compared each v2 facet with the corpus projection of its v1 owner
 * (shared-facet equality, the v1 `supported`-seat census, the under-projection
 * ledger) have nothing left to compare against and were removed. What survives
 * is everything that needs no v1 document: the corpus oracle on literals, the
 * local mirror's agreement with it (on the v2 document and on literal inputs),
 * the v2 fixed point, the closed-record key set, the subChains owner, and the
 * unspliceable-payload judgement (which reads the vendored v1 SCHEMA, not the
 * builder). The two ledgers those removed legs held are recorded in ADR 0858
 * as of ADR 0812 P4, so the open decisions are not lost with their detector:
 *
 *   Deliberate shape changes (v2 differs from projected v1 on purpose):
 *     - aiProviders.authModes — v1 a per-provider MAP, v2 a flat mode
 *       VOCABULARY; the map rides the `openwop-app.ai-providers` extension.
 *     - aiProviders.selfHosted — v1 the LIST of self-hosted provider ids, v2 a
 *       BOOLEAN; the ids ride `providers`.
 *   Known under-projection (v1 facets with a declared v2 seat major 2 does not
 *   fill; each needs a v2-shape decision):
 *     aiProviders.byok, aiProviders.policies, aiProviders.imageGeneration,
 *     aiProviders.videoGeneration, aiProviders.speechSynthesis,
 *     aiProviders.realtimeVoice, aiProviders.maxInlineMediaBytes,
 *     envelopes.reliability.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripSupported as corpusStripSupported,
  carriesUnspliceablePayload,
} from '@openwop/openwop-conformance/src/lib/v2-projection.js';
import { buildV2Advertisement, stripSupported as hostStripSupported } from '../src/routes/discovery.js';
import { MAX_SUB_CHAIN_DEPTH } from '../src/host/workflowChainPackLoader.js';
import { loadConfigFromEnv } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The four seats every v2 record carries that are NOT facets (`capabilities.md` §3). */
const RECORD_ENVELOPE = new Set(['status', 'since', 'until', 'witness']);

function readSchema(...segments: string[]): Rec {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, 'schemas', ...segments), 'utf8'));
  if (!isRec(parsed)) throw new Error(`${segments.join('/')} is not a JSON object`);
  return parsed;
}

function schemaProperties(schema: Rec): Rec {
  const props = schema['properties'];
  return isRec(props) ? props : {};
}

/** A v2 FAMILY record is an object carrying the record envelope — which excludes `implementation`, `extensions` and the metadata keys. */
function v2Families(v2: Rec): [string, Rec][] {
  const out: [string, Rec][] = [];
  for (const [k, v] of Object.entries(v2)) {
    if (isRec(v) && typeof v['status'] === 'string' && typeof v['witness'] === 'string') out.push([k, v]);
  }
  return out;
}

function buildV2(): Rec {
  return buildV2Advertisement(loadConfigFromEnv());
}

const ENV_KEYS = ['OPENWOP_CHAIN_SUBCHAINS', 'OPENWOP_TEST_TRIGGER_COMPACTION'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  // The storage-family records read the configured tier.
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
});

describe("WHD-7 — discovery.ts's local stripSupported() is a mirror of the corpus function", () => {
  it('agrees on the whole v2 document this host actually serves', () => {
    const v2 = buildV2();
    expect(hostStripSupported(v2)).toEqual(corpusStripSupported(v2));
  });

  it('agrees on the inputs the served document does not happen to contain — arrays of records and required[]', () => {
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

describe('WHD-7 — the v2 document under the corpus projection', () => {
  it('the v2 document is a fixed point of the projection — projecting it again changes nothing', () => {
    // The `supported: true` class. `adr0670` walks for the key; this asks the
    // corpus function the same question, so a change to what the corpus strips
    // (it already reaches into `required[]`) arrives here without an edit.
    const v2 = buildV2();
    expect(corpusStripSupported(v2)).toEqual(v2);
  });

  it('memory.compaction follows its owner at major 2 — projected when on, absent when off', () => {
    // The nested `{supported, …}` arm, exercised by a real owner. Before ADR 0812
    // P4 this compared with the v1 record; the v2 halves are what remain.
    process.env.OPENWOP_TEST_TRIGGER_COMPACTION = 'true';
    const on = buildV2()['memory'];
    expect(isRec(on) ? on['compaction'] : undefined).toEqual({ trigger: 'both' });
    delete process.env.OPENWOP_TEST_TRIGGER_COMPACTION;
    const off = buildV2()['memory'];
    expect(isRec(off), 'the family itself stays — only the facet goes').toBe(true);
    expect(isRec(off) && 'compaction' in off).toBe(false);
  });

  it('carries no facet the closed v2 record does not declare — the `deferredParameters` class', () => {
    const v2 = buildV2();
    const v2Schema = schemaProperties(readSchema('v2', 'capabilities.schema.json'));
    const leaked: string[] = [];
    let checked = 0;
    for (const [family, record] of v2Families(v2)) {
      const familySchema = v2Schema[family];
      const declared = isRec(familySchema) ? schemaProperties(familySchema) : {};
      // A family whose record moved behind a `$ref` would make `declared` empty
      // and every facet "leaked" — loud, which is the right way round.
      expect(Object.keys(declared), `${family}: the v2 schema declares no inline properties`).toEqual(expect.arrayContaining(['status', 'witness']));
      for (const facet of Object.keys(record)) {
        checked++;
        if (facet in declared) continue;
        const origin = facet === 'supported'
          ? 'v2 retired the flag (RFC 0192): presence of the record is the claim — route the owner through stripSupported()'
          : 'the closed v2 record declares no such facet — pick the declared facets by name, never spread an owner';
        leaked.push(`${family}.${facet} — ${origin}`);
      }
    }
    expect(leaked, leaked.join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });
});

describe('WHD-7 — workflowChainPacks.subChains, the fifth hand-written projection', () => {
  it('is the owner\'s record minus `supported` — maxDepth included', () => {
    const v2 = buildV2();
    const v2Record = v2['workflowChainPacks'];
    expect(isRec(v2Record) ? v2Record['subChains'] : undefined).toEqual({ maxDepth: MAX_SUB_CHAIN_DEPTH });
  });

  it('is WITHDRAWN at major 2 when the owner withdraws it — advertising a facet from-chain refuses is a false claim', () => {
    process.env.OPENWOP_CHAIN_SUBCHAINS = '0';
    const v2 = buildV2();
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
    const v2 = buildV2();
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
