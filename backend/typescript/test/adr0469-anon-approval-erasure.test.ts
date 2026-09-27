/**
 * `PROBE-0469-1`, migrated from prose to an executable assertion.
 *
 * The probe asked: after a DSAR erasure, does any `anon-surface-write` approval
 * still carry that subject's captured PII? It lived as SQL in
 * `docs/steward/DATA-ASSESSMENT.md`, where **nothing ran it** — and it was filed
 * as a Blocker precisely because its predicate could not match: `kind` is a VALUE
 * field, and it had been written as a `k` key predicate, so it returned 0
 * unconditionally and declared 0 healthy.
 *
 * A probe with a KNOWN ANSWER is a test. This is that test, in the package that
 * already owns integrity checking (`delete-cascade-guards`, `content-delete-
 * cascades`, `adr0464-host-subject-erasure`), where CI executes it.
 *
 * THE PRECONDITION IS THE POINT. Asserting only "the PII is gone" would pass if
 * the row were never built correctly — the redactor would match nothing, zero
 * rows would change, and the absence would be true because the PII never
 * existed. That is the SAME failure the original probe had. So each case asserts
 * the PII is PRESENT first; a wrong row shape fails loudly there instead of
 * passing silently here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createAnonSurfaceWriteApproval,
  getApproval,
  eraseApprovalSubject,
} from '../src/host/approvalService.js';

const T = 'erasure-tenant';
const SUBJECT = 'anon:visitor-1';
const PII = { name: 'Ada Lovelace', email: 'ada@example.test', note: 'called about pricing' };

const hold = (runId: string, principal: string) => createAnonSurfaceWriteApproval({
  tenantId: T, orgId: 'o', widgetId: 'w', principal, runId, toolCallIdx: 0,
  tool: { name: 'openwop:kanban.add-todo', args: { title: 'x' } },
  captured: PII,
});

const blob = (a: unknown): string => JSON.stringify(a ?? {});

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-0469-erase-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('PROBE-0469-1 (executable) — DSAR erasure reaches anon-surface-write holds', () => {
  it('redacts the captured PII of the erased subject', async () => {
    const a = await hold('run-1', SUBJECT);

    // PRECONDITION — without this the test below is vacuous.
    const before = await getApproval(a.approvalId);
    expect(before, 'the hold was not created — the rest of this test would be vacuous').toBeTruthy();
    expect(blob(before), 'captured PII missing BEFORE erasure — wrong row shape').toContain(PII.email);

    await eraseApprovalSubject(T, SUBJECT);

    const after = await getApproval(a.approvalId);
    expect(blob(after), 'captured email survived erasure').not.toContain(PII.email);
    expect(blob(after), 'captured name survived erasure').not.toContain(PII.name);
    expect(blob(after), 'captured note survived erasure').not.toContain(PII.note);
  });

  it('leaves ANOTHER subject untouched — erasure is scoped, not a purge', async () => {
    // The other polarity. A redactor that wipes everything would pass the test
    // above while destroying unrelated records.
    const mine = await hold('run-2', SUBJECT);
    const theirs = await hold('run-3', 'anon:visitor-2');

    await eraseApprovalSubject(T, SUBJECT);

    expect(blob(await getApproval(mine.approvalId))).not.toContain(PII.email);
    expect(
      blob(await getApproval(theirs.approvalId)),
      'a different subject lost their data — erasure over-reached',
    ).toContain(PII.email);
  });
});
