/**
 * ADR 0524 Phase E0 — `parseFieldContract`, the header parser.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTE TESTS. The route tests prove
 * the wiring and the guard's behaviour, but they could not discriminate the
 * parser's closed-world rule: `models(f)` tests for an exact field name, so an
 * unrecognised token is inert whether it is stored or dropped. A sabotage probe
 * that opened the parser to arbitrary tokens turned NOTHING red — the route
 * assertion I had written for it was vacuous.
 *
 * The property that IS discriminating is forward-compatibility, and it is only
 * visible at this level: an old client sending a name the server does not yet
 * honour must NOT end up having declared it once the server adds it. So the
 * parse result is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { parseFieldContract, FIELD_CONTRACT_HEADER } from '../src/host/preserveDroppedFields.js';

describe('parseFieldContract', () => {
  it('parses the fields the builder declares', () => {
    const got = parseFieldContract('inputs,variables,configurableSchema');
    expect([...(got ?? [])].sort()).toEqual(['configurableSchema', 'inputs', 'variables']);
  });

  it('tolerates whitespace and ordering', () => {
    expect([...(parseFieldContract(' variables , inputs ') ?? [])].sort()).toEqual(['inputs', 'variables']);
  });

  it('THE FORWARD-COMPAT PROPERTY: an unknown token is dropped, not stored', () => {
    // If a future field joins `PreservableField`, an old client that had been
    // sending that name speculatively must not retroactively count as having
    // declared it — that would silently switch off a guard for a client that
    // never implemented the contract.
    expect(parseFieldContract('nodes,edges,metadata'), 'unknown tokens were carried').toBeUndefined();
    expect([...(parseFieldContract('inputs,nodes') ?? [])], 'a known token must survive beside an unknown one').toEqual(['inputs']);
  });

  it('a missing or blank header means the client said NOTHING', () => {
    // The safe default: `undefined` keeps the heuristic, and the clients that
    // cannot send this header are the entire population the guard exists for.
    expect(parseFieldContract(undefined)).toBeUndefined();
    expect(parseFieldContract('')).toBeUndefined();
    expect(parseFieldContract('   ')).toBeUndefined();
    expect(parseFieldContract(',,')).toBeUndefined();
  });

  it('ignores a non-string header value rather than throwing', () => {
    // The value arrives off the wire; a scan that dies on a malformed header
    // takes the whole save with it.
    expect(parseFieldContract(42)).toBeUndefined();
    expect(parseFieldContract({})).toBeUndefined();
    expect(parseFieldContract(null)).toBeUndefined();
  });

  it('joins a REPEATED header — express gives an array', () => {
    expect([...(parseFieldContract(['inputs', 'variables']) ?? [])].sort()).toEqual(['inputs', 'variables']);
  });

  it('the header name matches the one the SPA sends', () => {
    // Two literals on either side of a wire is how a contract silently stops
    // being honoured. The frontend copy lives in
    // `builder/persistence/fieldContract.ts` and is pinned by its own test.
    expect(FIELD_CONTRACT_HEADER).toBe('x-openwop-field-contract');
  });
});
