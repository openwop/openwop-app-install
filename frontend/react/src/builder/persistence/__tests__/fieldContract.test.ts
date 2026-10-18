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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_CONTRACT_HEADER, BUILDER_FIELD_CONTRACT, fieldContractHeader } from '../fieldContract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../..'); // frontend/react/src
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** The BACKEND's half of the contract — the parser + guard this header talks to.
 *  Read from source (resolved from this file, never the cwd) so a rename on
 *  either side reds here instead of silently disabling the contract. */
const BACKEND_GUARD = readFileSync(
  resolve(HERE, '../../../../../../backend/typescript/src/host/preserveDroppedFields.ts'),
  'utf8',
);
function backendHeaderName(): string {
  const m = /export const FIELD_CONTRACT_HEADER = '([^']+)'/.exec(BACKEND_GUARD);
  if (!m) throw new Error('FIELD_CONTRACT_HEADER not found in preserveDroppedFields.ts');
  return m[1]!;
}
function backendPreservableFields(): string[] {
  const m = /export const PRESERVABLE_FIELDS[^=]*=\s*\[([^\]]*)\]/.exec(BACKEND_GUARD);
  if (!m) throw new Error('PRESERVABLE_FIELDS not found in preserveDroppedFields.ts');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The body of one top-level `export async function <name>(` in `src`, up to the
 *  next top-level `export`. Lets the ratchet see a LANE, not just a file. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

/** Every non-test source file under src/, as a src-relative posix path. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'test' || e.name === 'node_modules') continue;
      out.push(...sourceFiles(abs));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) {
      out.push(relative(SRC, abs).split(sep).join('/'));
    }
  }
  return out;
}

/** Lanes whose source of truth is localStorage — they must NEVER declare. */
const LOCALSTORAGE_LANES = [
  'runs/RunsIndexPage.tsx',
  'chat/hooks/chatSession/useWorkflowRunMentions.ts',
  'builder/persistence/registerClient.ts',
];

describe('field contract — the header value', () => {
  it('matches the header name the backend parses', () => {
    // A literal on each side of a wire is how a contract silently stops being
    // honoured — so this reads the backend's OWN constant rather than a copy.
    expect(FIELD_CONTRACT_HEADER).toBe(backendHeaderName());
    expect(FIELD_CONTRACT_HEADER).toBe('x-openwop-field-contract');
  });

  it('declares exactly the three fields the builder store models — a subset of the five the guard restores', () => {
    // Growing this list tells the server to STOP protecting the new field, so it
    // must be a deliberate edit — never a side effect of widening a type.
    expect([...BUILDER_FIELD_CONTRACT].sort()).toEqual(['configurableSchema', 'inputs', 'variables']);
    // The backend guard restores FIVE today (`settings` and `compensation` too).
    // A declared field the guard does not know would be a contract the server
    // cannot honour.
    expect(backendPreservableFields().sort()).toEqual(['compensation', 'configurableSchema', 'inputs', 'settings', 'variables']);
    for (const f of BUILDER_FIELD_CONTRACT) expect(backendPreservableFields()).toContain(f);
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
    // Scoped to `saveWorkflow` itself — the file also holds a localStorage lane.
    const save = fnBody(read('builder/persistence/backendStore.ts'), 'saveWorkflow');
    expect(save, 'the builder save lane stopped declaring its contract').toContain('fieldContractHeader()');
  });

  it('the one-shot localStorage migration in the SAME file does NOT declare', () => {
    // `migrateLocalToBackend` serializes from localStorage — exactly the stale
    // source this ratchet exists for — but lives beside the declaring lane, so a
    // file-level check could never see it.
    const migrate = fnBody(read('builder/persistence/backendStore.ts'), 'migrateLocalToBackend');
    expect(migrate).toContain('listSavedWorkflows()'); // positive control: it IS the localStorage lane
    expect(migrate).not.toContain('fieldContractHeader');
    expect(migrate.toLowerCase()).not.toContain(FIELD_CONTRACT_HEADER);
  });

  it('no source file outside the builder save lane references the contract at all', () => {
    // The named lanes below carry the explanation; this catches the lane nobody
    // thought to name yet.
    const declaring = sourceFiles().filter((rel) => {
      const src = read(rel);
      return src.includes('fieldContractHeader') || src.toLowerCase().includes(FIELD_CONTRACT_HEADER);
    }).sort();
    expect(declaring).toEqual(['builder/persistence/backendStore.ts', 'builder/persistence/fieldContract.ts']);
  });

  it.each(LOCALSTORAGE_LANES)('%s does NOT declare — its source may be stale', (lane) => {
    const src = read(lane);
    expect(src, `${lane} serializes from localStorage; declaring a contract there deletes the head's inputs`)
      .not.toContain('fieldContractHeader');
    expect(src.toLowerCase(), `${lane} must not hand-roll the header either`)
      .not.toContain(FIELD_CONTRACT_HEADER);
  });
});
