/**
 * ADR 0739 D5 — the supervised durability lane's VERDICT.
 *
 * The lane itself kills a real process and takes ~15 minutes, so it is not in
 * `npm test`. Its verdict is a pure function precisely so that the part most
 * likely to be vacuous — "did we pass because nothing ran?" — is pinned here,
 * cheaply, on every run.
 */
import { describe, expect, it } from 'vitest';

import { evaluateLane, REQUIRED_ROWS, KILL_ROW_COUNT, type Death, type LedgerRow } from '../conformance/durabilityLane.js';

const pass = (id: string): LedgerRow => ({ requirementId: id, disposition: 'executed-pass' });
const allPass = (): LedgerRow[] => REQUIRED_ROWS.map(pass);
const sigkill = (): Death => ({ atMs: 1, signal: 'SIGKILL', code: null });

describe('durability lane verdict (ADR 0739 D5)', () => {
  it('pins the population: five rows, two of which need a death — as LITERALS', () => {
    // A collection's size pinned to itself proves nothing; an emptied
    // REQUIRED_ROWS would make every loop below pass vacuously.
    expect(REQUIRED_ROWS.length).toBe(5);
    expect(KILL_ROW_COUNT).toBe(2);
  });

  it('five executed-pass rows across two real SIGKILLs is a witness', () => {
    expect(evaluateLane(allPass(), [sigkill(), sigkill()])).toEqual([]);
  });

  it('an EMPTY ledger is not a pass — every required row is reported missing', () => {
    const problems = evaluateLane([], [sigkill(), sigkill()]);
    expect(problems.length).toBe(5);
    for (const id of REQUIRED_ROWS) expect(problems.join('\n')).toContain(id);
  });

  it('`inapplicable` is NOT a witness — the state this host was in before the seam existed', () => {
    const rows = allPass().map((r) => (r.requirementId?.endsWith('kill-after-accept') ? { ...r, disposition: 'inapplicable', detail: 'no seam' } : r));
    const problems = evaluateLane(rows, [sigkill(), sigkill()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/kill-after-accept: inapplicable/);
  });

  it('`blocked` and `executed-fail` are each refused, with the suite’s own detail carried through', () => {
    for (const disposition of ['blocked', 'executed-fail']) {
      const rows = allPass().map((r) => (r.requirementId?.endsWith('duplicate-delivery') ? { ...r, disposition, detail: 'the staged run recorded no effects' } : r));
      const problems = evaluateLane(rows, [sigkill(), sigkill()]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(disposition);
      expect(problems[0]).toContain('recorded no effects');
    }
  });

  it('a row that passed once and failed once is refused — one good row does not launder a bad one', () => {
    const id = REQUIRED_ROWS[0];
    const problems = evaluateLane([...allPass(), { requirementId: id, disposition: 'executed-fail', detail: 'second leg' }], [sigkill(), sigkill()]);
    expect(problems).toHaveLength(1);
  });

  it('ALL GREEN WITH NO DEATH ON RECORD is refused — the vacuous pass this lane exists to exclude', () => {
    expect(evaluateLane(allPass(), [])).toHaveLength(1);
    expect(evaluateLane(allPass(), [sigkill()])[0]).toMatch(/observed 1 SIGKILL/);
  });

  it('a graceful exit is not a kill: SIGTERM and exit(1) do not count toward the floor', () => {
    const polite: Death[] = [{ atMs: 1, signal: 'SIGTERM', code: null }, { atMs: 2, signal: null, code: 1 }];
    const problems = evaluateLane(allPass(), polite);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/observed 0 SIGKILL/);
  });
});
