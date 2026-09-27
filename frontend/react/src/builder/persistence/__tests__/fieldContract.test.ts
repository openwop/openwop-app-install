/**
 * ADR 0524 Phase E0 — WHICH lanes may declare a field contract.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, stated plainly because it is genuinely
 * counter-intuitive: every save lane in this bundle shares one corrected
 * `serializeWorkflow`, so it looks obviously right to send the field-contract
 * header from all of them. **It is not.**
 *
 * The contract describes the SOURCE OF TRUTH, not the serializer. The runs
 * index and the chat `@workflow` mention serialize from **localStorage**, and a
 * `SavedWorkflow` written by a pre-ADR-0523 bundle carries no node `inputs` at
 * all. A correct serializer faithfully emits the nothing that is there. So a
 * declaration from those lanes would tell the server "this omission is a
 * deletion" about data that is merely STALE — and the server would delete the
 * head's inputs. That is verbatim the harm ADR 0524 exists to prevent,
 * re-introduced through the mechanism built to make it unnecessary.
 *
 * A reviewer adding the header to a third lane "for consistency" is the whole
 * risk, so this is a RATCHET over the source files, not a unit test of a pure
 * function — the mistake is a call site, and only a call-site check can see it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_CONTRACT_HEADER, BUILDER_FIELD_CONTRACT, fieldContractHeader } from '../fieldContract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../..'); // frontend/react/src
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** Lanes whose source of truth is localStorage — they must NEVER declare. */
const LOCALSTORAGE_LANES = [
  'runs/RunsIndexPage.tsx',
  'chat/hooks/chatSession/useWorkflowRunMentions.ts',
  'builder/persistence/registerClient.ts',
];

describe('field contract — the header value', () => {
  it('matches the header name the backend parses', () => {
    // A literal on each side of a wire is how a contract silently stops being
    // honoured. The backend copy is pinned in `field-contract-parse.test.ts`.
    expect(FIELD_CONTRACT_HEADER).toBe('x-openwop-field-contract');
  });

  it('declares exactly the three fields the guard can restore', () => {
    // Growing this list tells the server to STOP protecting the new field, so it
    // must be a deliberate edit — never a side effect of widening a type.
    expect([...BUILDER_FIELD_CONTRACT].sort()).toEqual(['configurableSchema', 'inputs', 'variables']);
  });

  it('emits a comma-separated header the parser accepts', () => {
    expect(fieldContractHeader()).toEqual({
      'x-openwop-field-contract': 'inputs,variables,configurableSchema',
    });
  });
});

describe('field contract — WHICH lanes declare it (the ratchet)', () => {
  it('the builder save lane DOES declare', () => {
    // Fixture guard: if this ever stops matching, the ratchet below is checking
    // for the absence of something nothing produces, and would pass forever.
    const src = read('builder/persistence/backendStore.ts');
    expect(src, 'the builder save lane stopped declaring its contract').toContain('fieldContractHeader()');
  });

  it.each(LOCALSTORAGE_LANES)('%s does NOT declare — its source may be stale', (lane) => {
    const src = read(lane);
    expect(src, `${lane} serializes from localStorage; declaring a contract there deletes the head's inputs`)
      .not.toContain('fieldContractHeader');
    expect(src.toLowerCase(), `${lane} must not hand-roll the header either`)
      .not.toContain(FIELD_CONTRACT_HEADER);
  });
});
