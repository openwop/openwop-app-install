/**
 * The node-field contract has THREE writers. They must agree.
 *
 * This is the root cause of NOTIF-UX-3, stated as an invariant. The host's node
 * contract is declared independently in three places:
 *
 *   PRODUCER   `host/workflowChainPackLoader.ts`  — what `expandChain` emits
 *   INGEST     `host/workflowDefinitionValidation.ts` — what a POST is allowed to persist
 *   ROUND-TRIP `frontend/react/src/builder/schema/serialize.ts` — what the builder saves back
 *
 * The producer and the ingest agreed on five fields. The builder emitted four —
 * it silently dropped `inputs` on every save, deleting authored values on 114 of
 * 169 shipped chains (187 nodes: every email recipient, every notify headline).
 * Nothing compared the three lists, so the drift was invisible for as long as it
 * existed.
 *
 * A prose docblock saying "keep these in sync" is what we had. This is the
 * mechanical version.
 *
 * WHAT THIS CANNOT SEE, stated so nobody over-trusts it. It reads SOURCE TEXT, so
 * it detects a field being DELETED from a writer (probed) but NOT a field left in
 * place and disabled at runtime — flipping `...(n.inputs ? …)` to
 * `...(false && n.inputs ? …)` keeps it green (also probed). It also covers only
 * the three DECLARED contracts; field-by-field reconstructions inside function
 * bodies are invisible to it, and there are at least five of those
 * (`updateNode`, `backendStore.loadWorkflow`, `builderStore.loadFromSaved`,
 * `snapshot`, `persist`) — every one of which had dropped a field before this
 * ADR.
 *
 * H37 found two MORE, which is what "invisible to it" costs in practice:
 * `builderStore.cloneNodes` / `pasteNodes` (and the clipboard entry type
 * `nodeClipboard.copySelection` builds) enumerated the same six fields and so
 * had been dropping `outputRole` on every duplicate and paste since RFC 0065
 * landed. All three now spread the source node instead of listing its fields,
 * and the guard is BEHAVIOURAL — source text cannot see this class:
 * `frontend/react/src/builder/store/__tests__/builderStore.nodeFieldFidelity.test.ts`.
 *
 * A fourth node-shape writer, `routes/workflowChainExpandSeam.ts:89-93`,
 * maps onto the RFC 0013 wire shape and drops `inputs`; it is a different shape
 * (`id`, not `nodeId`) and a conformance surface, so it is tracked rather than
 * folded in here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(process.cwd(), '..', '..');

/** Strip line and block comments so a COMMENTED-OUT field cannot be counted as
 *  present. A review probe proved the earlier version green after replacing
 *  `inputs?: …` with `// inputs field removed` — this repo's own
 *  `ratchet-gates-count-comments` lesson, recurring inside the ratchet. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Field names declared inside a source slice.
 *
 * Deliberately GENERIC — it matches any identifier in the two shapes these
 * literals use (`field: …` and `...(x.field …)`), rather than a closed list of
 * the five fields we already know about. A closed alternation cannot detect the
 * next instance of this defect class: a review probe added `name` to the
 * validator's return literal and every assertion stayed green, because `name`
 * was not in the alternation. The pinned contract below is now the ONLY
 * allowlist.
 */
function fieldsIn(source: string, startMarker: string, endMarker: string): Set<string> {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`);
  const slice = stripComments(source.slice(start, end));
  const out = new Set<string>();
  // `field: value` / `field?: type` — an object-literal or interface member.
  for (const m of slice.matchAll(/^\s*(\w+)\??\s*:/gm)) out.add(m[1]!);
  // `field,` — ES shorthand property. The emit site writes `nodeId,`, so a
  // colon-only matcher silently under-reports what a writer actually produces.
  for (const m of slice.matchAll(/^\s*(\w+),\s*$/gm)) out.add(m[1]!);
  // `...(<any condition> ? { field: … } : {})` — capture the EMITTED key, not
  // the condition's. `...(n.id === primaryNodeId ? { outputRole: … })` emits
  // `outputRole`; reading the condition would report `id`, a field nothing emits.
  for (const m of slice.matchAll(/\.\.\.\([\s\S]{0,120}?\{\s*(\w+)\s*:/g)) out.add(m[1]!);
  // `...(x ? { field } : {})` — the SHORTHAND form of the line above. Found
  // 2026-08-16 while adopting RFC 0157: #3274 added `compensation` to the
  // validator as `...(compensation ? { compensation } : {})`, and because the
  // colon-only matcher above cannot see a shorthand key, this ratchet reported
  // the validator as accepting five fields when it accepted six. The builder
  // therefore "matched" a contract it was actually missing a field from, and the
  // gate stayed green over a real drop — the precise failure mode this file
  // exists to make impossible, recurring inside the file itself for the fourth
  // time (cf. the commented-out-field, closed-alternation, and hard-coded-echo
  // corrections above).
  for (const m of slice.matchAll(/\.\.\.\([\s\S]{0,120}?\{\s*(\w+)\s*\}/g)) out.add(m[1]!);
  return out;
}

const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

describe('the collab room carries every def-level field SavedWorkflow models', () => {
  // Allowlist #7 and #8, found by /architect and /code-review during ADR 0524.
  // The FIELD LIST was written for ADR 0364 when `SavedWorkflow` had no
  // `variables`; ADR 0523 added them and nothing compared the lists. Widening the
  // list alone then turned out to be INERT, because the adapter's writer and
  // reader are two further hand-maintained lists. Three lists, one contract —
  // this file's own root cause, twice more.
  //
  // §Correction: the first version of this block parsed EVERY quoted identifier
  // in the shape file, so deleting `'variables'` from `WORKFLOW_COLLAB_FIELDS`
  // while leaving the `{ key: 'variables' }` collections entry kept it GREEN
  // (sabotage-proven by the review). It now parses the named list only, and
  // compares against `SavedWorkflow` rather than a hard-coded echo.
  const savedWorkflowFields = fieldsIn(
    read('frontend/react/src/builder/schema/workflow.ts'),
    'export interface SavedWorkflow',
    '\n}',
  );
  const namedList = (source: string, name: string): Set<string> => {
    const src = stripComments(source);
    const i = src.indexOf(name);
    if (i < 0) throw new Error(`list not found: ${name}`);
    const open = src.indexOf('[', i);
    const close = src.indexOf(']', open);
    if (open < 0 || close < 0) throw new Error(`list not bracketed: ${name}`);
    return new Set([...src.slice(open, close).matchAll(/'(\w+)'/g)].map((m) => m[1]!));
  };
  const shapeSrc = read('frontend/react/src/builder/collab/workflowCollabShape.ts');
  const collabFields = namedList(shapeSrc, 'WORKFLOW_COLLAB_FIELDS');
  /** `{ key: 'x', idKey: … }` entries in WORKFLOW_COLLAB_SHAPE.collections. */
  const declaredCollections = new Set(
    [...stripComments(shapeSrc).matchAll(/\{\s*key:\s*'(\w+)'\s*,\s*idKey:/g)].map((m) => m[1]!),
  );
  // The adapter's two ends — the writer's slice literal and the reader's
  // `doc['x']` reads. Inert field lists are what made #7 a no-op.
  const adapterSrc = stripComments(read('frontend/react/src/builder/collab/workflowCollabAdapter.ts'));
  const adapterWrites = new Set([...adapterSrc.matchAll(/^\s*(\w+):\s*s\.\w+,/gm)].map((m) => m[1]!));
  const adapterReads = new Set([...adapterSrc.matchAll(/doc\['(\w+)'\]/g)].map((m) => m[1]!));

  it('fixture guard: all four lists parsed', () => {
    expect(savedWorkflowFields.size, 'parsed no SavedWorkflow fields').toBeGreaterThan(6);
    expect(collabFields.size, 'parsed no WORKFLOW_COLLAB_FIELDS entries').toBeGreaterThan(4);
    expect(adapterWrites.size, 'parsed no adapter writes').toBeGreaterThan(4);
    expect(adapterReads.size, 'parsed no adapter reads').toBeGreaterThan(2);
    expect(declaredCollections.size, 'parsed no collections — the shape literal changed').toBeGreaterThan(2);
  });

  it('an ARRAY field is a collection, never a last-writer-wins scalar', () => {
    // The harm a hard-coded exemption list hid: demoting an array to a root
    // scalar makes two peers editing different entries lose one, silently.
    for (const f of ['nodes', 'edges', 'variables']) {
      expect(
        declaredCollections.has(f),
        `\`${f}\` is array-valued but not declared a collection — it would ride as a whole-object scalar and one peer's edits would be erased`,
      ).toBe(true);
    }
  });

  /** SavedWorkflow fields deliberately NOT room-carried: identity + timestamps
   *  are REST-owned (a peer must not rewrite the document's identity), and
   *  `metadata`/`lifecycle` are re-applied from the head by the derive. */
  const REST_OWNED = new Set(['id', 'version', 'createdAt', 'updatedAt', 'metadata', 'lifecycle']);

  it('every non-REST-owned SavedWorkflow field is in WORKFLOW_COLLAB_FIELDS', () => {
    const missing = [...savedWorkflowFields].filter((f) => !REST_OWNED.has(f) && !collabFields.has(f)).sort();
    expect(
      missing,
      'a SavedWorkflow field is not room-carried — a peer edit cannot reach another peer, and the last write erases it. Add it here or to REST_OWNED with a reason.',
    ).toEqual([]);
  });

  it('the adapter WRITES every field the list declares', () => {
    // The miss that shipped in this very delta: the list said `variables`, the
    // writer never passed it, and `workflowCollabSlice` skips `undefined`.
    const notWritten = [...collabFields].filter((f) => !adapterWrites.has(f)).sort();
    expect(notWritten, 'WORKFLOW_COLLAB_FIELDS declares a field the adapter never sends — the entry is inert').toEqual([]);
  });

  it('the adapter READS BACK every scalar it writes', () => {
    // Collections ride the binding, not a root scalar read — so they are exempt
    // from the read-back check. §Correction (grade-code): this set used to be a
    // hard-coded `['nodes','edges']`, which meant DELETING
    // `{ key: 'variables', idKey: 'name' }` from the shape passed 10/10 — and
    // that deletion demotes `variables` from a per-variable CRDT collection to a
    // whole-object last-writer-wins scalar, the exact "two peers edit different
    // variables, one silently loses" harm the entry exists to prevent. Third
    // version of this ratchet, third hard-coded echo. It now reads the shape.
    const collections = declaredCollections;
    const notRead = [...collabFields].filter((f) => !collections.has(f) && !adapterReads.has(f)).sort();
    expect(notRead, 'the adapter sends a field it never reads back — a peer edit arrives and is discarded').toEqual([]);
  });
});

describe('the three node-field writers declare the same contract', () => {
  const ingest = fieldsIn(
    read('backend/typescript/src/host/workflowDefinitionValidation.ts'),
    'return {\n      nodeId: node.nodeId,',
    '};',
  );
  // The EMIT SITE, not the interface. A grade probe deleted the emit while
  // leaving `BackendNode.inputs` declared — that re-introduces the entire ADR
  // 0518 bug, and the earlier version of this ratchet stayed green, because a
  // type declaration is a promise and this file is supposed to check delivery.
  const roundTrip = fieldsIn(
    read('frontend/react/src/builder/schema/serialize.ts'),
    'const nodeId = safeUniqueNodeId',
    '  });',
  );
  // The READ half. Neither side of the builder's two-function round trip was
  // covered before; a field the writer emits but the reader drops is silently
  // lost on the NEXT save.
  const roundTripRead = fieldsIn(
    read('frontend/react/src/builder/schema/deserialize.ts'),
    'nodes.push({',
    '});',
  );
  // The PRODUCER. An earlier version of this file claimed to parse "all three"
  // writers while reading two — the review caught the doc overstating its own
  // ratchet, which is the false-promise family this repo keeps hitting.
  const producer = fieldsIn(
    read('backend/typescript/src/host/workflowChainPackLoader.ts'),
    'const nodes = chain.dag.nodes.map',
    '}));',
  );

  it('fixture guard: both slices actually parsed some fields', () => {
    // A marker rename would silently yield two empty sets, which compare EQUAL —
    // the gate would then pass while checking nothing. This is the failure mode
    // that let the original tripwire scan 1407 files and examine zero nodes.
    expect(ingest.size, 'parsed no fields out of the validator — the marker moved').toBeGreaterThanOrEqual(4);
    expect(roundTrip.size, 'parsed no fields out of BackendNode — the marker moved').toBeGreaterThanOrEqual(4);
    expect(producer.size, 'parsed no fields out of expandChain — the marker moved').toBeGreaterThanOrEqual(4);
    expect(roundTripRead.size, 'parsed no fields out of deserialize — the marker moved').toBeGreaterThanOrEqual(3);
  });

  it('the builder READS back every field it emits', () => {
    // `id`/`kind`/`name`/`position` are builder-local; compare only the wire
    // fields the emit site produces.
    const wireFields = new Set(['config', 'inputs', 'outputRole', 'compensation', 'irreversibleEffect']);
    const emitted = [...roundTrip].filter((f) => wireFields.has(f)).sort();
    const read = [...roundTripRead].filter((f) => wireFields.has(f)).sort();
    expect(read, 'the builder emits a field its own reader drops — lost on the next save').toEqual(emitted);
  });

  it('the producer emits exactly what the validator accepts', () => {
    // If expandChain emitted a field the validator drops, every chain-instantiated
    // workflow would lose it on the very first POST.
    expect([...producer].sort()).toEqual([...ingest].sort());
  });

  it('the builder emits every field the host validator accepts', () => {
    const missing = [...ingest].filter((f) => !roundTrip.has(f)).sort();
    expect(
      missing,
      'the builder round-trip DROPS a field the host accepts and persists — every save deletes it.\n'
      + 'Add it to BuilderNode + deserialize + serialize (see NOTIF-UX-3), or narrow the validator.',
    ).toEqual([]);
  });

  it('the builder emits nothing the host validator would discard', () => {
    // The other direction is a FALSE PROMISE: the builder would advertise
    // preservation the server does not honour, since the validator rebuilds each
    // node from its own whitelist and drops the rest.
    const extra = [...roundTrip].filter((f) => !ingest.has(f)).sort();
    expect(
      extra,
      'the builder emits a field the validator discards — a preservation guarantee that is not real',
    ).toEqual([]);
  });

  it('records the contract explicitly, so a shared narrowing is still visible', () => {
    // Set equality alone would stay green if BOTH sides dropped a field on the
    // same day. Pin the contract itself.
    // `compensation` (#3274, RFC 0151 §B) and `irreversibleEffect` (RFC 0151 §B
    // UQ4, reachable from a chain via RFC 0157) joined the contract on
    // 2026-08-16. `compensation` had in fact been accepted since #3274 — it was
    // invisible to this parser until the shorthand matcher above was added, so
    // this pin was silently one field short of the truth.
    expect([...ingest].sort()).toEqual([
      'compensation', 'config', 'inputs', 'irreversibleEffect', 'nodeId', 'outputRole', 'typeId',
    ]);
  });
});
