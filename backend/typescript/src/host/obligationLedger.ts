/**
 * Obligation ledger (ADR 0447) — the ONE state machine for "we owe a third
 * party a cut of a paid source": accrual/reversal rows + CAS-claimed payout
 * runs, extracted verbatim from the ADR 0445 share ledger (including its
 * grade-sweep fixes). Two laws are inherited as construction, not convention:
 *
 *  - MONEY IS DERIVED: features derive rows from their own money truth
 *    (order observers, etc.) and convert to INTEGER MINOR UNITS before
 *    calling in — this machine never converts, never rounds, never imports a
 *    feature (`host/` seam; the core→feature import rule).
 *  - THE HOST NEVER MOVES MONEY: a payout run is an operator record; rows
 *    flip accrued→paid only on `confirmRun` with attested external evidence.
 *
 * Machine invariants (each test-pinned in test/obligation-ledger.test.ts):
 *  - accrual key `${tenant}::${sourceId}::${lineId}` — one obligation per
 *    SOURCE LINE (money can't dedupe coarser; the ADR 0445 HIGH), first-write-
 *    wins so replay/reprocess is idempotent and a rate change is forward-only;
 *  - a reversal MIRRORS its accrual negated (`::reversal` key) — never
 *    recomputed from a current rate;
 *  - `createRun` CAS-claims rows (a concurrent run's CAS loser is excluded)
 *    for payees whose per-currency NET is positive, then releases any group
 *    whose ACTUALLY-CLAIMED net fails to clear zero (no negative-entry runs);
 *  - `confirmRun`/`cancelRun` CAS-claim the RUN transition FIRST (the
 *    resolveApproval discipline) so confirm+cancel can never interleave into
 *    a double-pay; row effects are re-entrant behind the claimed transition.
 *
 * Consumers (adapters own domain + policy + RBAC + routes):
 *  - kicktodo-commerce/shareLedgerService (author shares — ADR 0445)
 *  - commerce/affiliate (commissions — ADR 0447 P2)
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

export interface ObligationRow {
  tenantId: string;
  /** The money-truth anchor (e.g. an orderId). */
  sourceId: string;
  /** The line discriminator within the source (e.g. a productId / code). */
  lineId: string;
  kind: 'accrual' | 'reversal';
  /** Who is owed (opaque subject / feature-scoped id). */
  payeeSubject: string;
  currency: string;
  /** The basis the rate applied to (line net), integer minor units; negative on reversal. */
  basisMinor: number;
  /** The frozen rate stamp (e.g. bps) — display/audit only, never recomputed from. */
  rateStamp: number;
  /** The obligation, integer minor units; negative on reversal. */
  amountMinor: number;
  policyVersion: number;
  state: 'accrued' | 'paid';
  payoutId?: string;
  sourceCreatedAt: string;
  createdAt: string;
  /** Domain passthrough (e.g. kicktodo's challengeId) — opaque to the machine. */
  meta?: Record<string, string>;
}

export interface ObligationRunEntry { payeeSubject: string; currency: string; totalMinor: number; rowCount: number }

export interface ObligationRun {
  tenantId: string;
  runId: string;
  state: 'open' | 'confirmed' | 'canceled';
  entries: ObligationRunEntry[];
  createdBy: string;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
  /** The external payment evidence (observed payout id / operator note). */
  reference?: string;
}

export class ObligationRunError extends Error {
  constructor(message: string, readonly code: 'nothing-accrued' | 'not-found' | 'bad-state') {
    super(message);
  }
}

export interface AccrueInput {
  tenantId: string;
  sourceId: string;
  lineId: string;
  payeeSubject: string;
  currency: string;
  basisMinor: number;
  rateStamp: number;
  amountMinor: number;
  policyVersion: number;
  sourceCreatedAt: string;
  meta?: Record<string, string>;
}

/** CSV escape with spreadsheet-formula-prefix neutralization on STRING fields
 *  (numeric columns stay raw — a leading '-' there is a legitimate negative). */
export function csvEscape(v: string): string {
  return `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
}

export interface ObligationLedgerConfig {
  /** Row collection name — VERBATIM (a consumer keeps its historical namespace). */
  ns: string;
  /** Run collection name — verbatim. */
  runsNs: string;
  logComponent: string;
  /** Optional read-tolerance hook: rename/upgrade a legacy-shaped stored row.
   *  Return null to drop an unreadable row (fail-closed on garbage). */
  upgradeRow?: (parsed: unknown) => ObligationRow | null;
}

export interface ObligationLedger {
  /** First-write-wins accrual. Returns true when a row was written. */
  accrue(input: AccrueInput): Promise<boolean>;
  /** Mirror-negate every accrual of a source (idempotent). Returns rows written. */
  reverseSource(tenantId: string, sourceId: string): Promise<number>;
  listForPayee(tenantId: string, payeeSubject: string): Promise<ObligationRow[]>;
  listForTenant(tenantId: string): Promise<ObligationRow[]>;
  /** `opts.payeeSubject` scopes the run to ONE payee (the per-affiliate payout
   *  shape); omitted = every net-positive payee in the tenant. */
  createRun(tenantId: string, actor: string, opts?: { payeeSubject?: string }): Promise<ObligationRun>;
  confirmRun(tenantId: string, runId: string, actor: string, reference: string): Promise<ObligationRun>;
  cancelRun(tenantId: string, runId: string): Promise<ObligationRun>;
  listRuns(tenantId: string): Promise<ObligationRun[]>;
  /** Test-only: wipe both collections (the `__reset*` convention). */
  __clear(): Promise<void>;
}

/** Accrued/paid totals per currency (reversals net into `accrued`). Accepts
 *  the minimal projection so adapters can feed domain-shaped rows castlessly. */
export function summarizeObligations(rows: Array<Pick<ObligationRow, 'currency' | 'state' | 'amountMinor'>>): Array<{ currency: string; accruedMinor: number; paidMinor: number }> {
  const byCurrency = new Map<string, { accruedMinor: number; paidMinor: number }>();
  for (const r of rows) {
    const cur = byCurrency.get(r.currency) ?? { accruedMinor: 0, paidMinor: 0 };
    if (r.state === 'paid') cur.paidMinor += r.amountMinor;
    else cur.accruedMinor += r.amountMinor;
    byCurrency.set(r.currency, cur);
  }
  return [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v })).sort((a, b) => a.currency.localeCompare(b.currency));
}

const nowIso = (): string => new Date().toISOString();

export function createObligationLedger(config: ObligationLedgerConfig): ObligationLedger {
  const log = createLogger(config.logComponent);

  const rowKey = (r: Pick<ObligationRow, 'tenantId' | 'sourceId' | 'lineId' | 'kind'>): string =>
    `${r.tenantId}::${r.sourceId}::${r.lineId}${r.kind === 'reversal' ? '::reversal' : ''}`;

  const rows = new DurableCollection<ObligationRow>(config.ns, rowKey, config.upgradeRow);
  const runs = new DurableCollection<ObligationRun>(config.runsNs, (r) => `${r.tenantId}::${r.runId}`);

  return {
    async accrue(input: AccrueInput): Promise<boolean> {
      const key = rowKey({ ...input, kind: 'accrual' });
      if (await rows.get(key)) return false; // first-write-wins: replay/reprocess-idempotent
      if (!Number.isInteger(input.amountMinor) || !Number.isInteger(input.basisMinor)) {
        throw new Error(`obligation ledger '${config.ns}': amounts MUST be integer minor units`);
      }
      await rows.put({ ...input, kind: 'accrual', state: 'accrued', createdAt: nowIso() });
      log.info('obligation_accrued', { sourceId: input.sourceId, lineId: input.lineId, amountMinor: input.amountMinor });
      return true;
    },

    async reverseSource(tenantId: string, sourceId: string): Promise<number> {
      // Mirror the ACCRUAL rows — no rate re-read (claw back exactly what was
      // accrued, under the policy version it was accrued with).
      let written = 0;
      const sourceRows = await rows.listByPrefix(`${tenantId}::${sourceId}::`);
      for (const accrual of sourceRows.filter((r) => r.kind === 'accrual')) {
        const { payoutId: _p, ...rest } = accrual;
        // Insert-once, atomically. This was `get(reversalKey)` then `put(...)`,
        // the same read-check-write `claimJoin` carried. SEVERITY IS LOWER HERE
        // and worth stating rather than blurring: `rowKey` is deterministic, so
        // two concurrent reversals wrote the SAME row and the money state stayed
        // correct — what doubled was `written` and the `obligation_reversed`
        // log line, i.e. the report of the work, not the work. Using the real
        // primitive makes the count honest and costs nothing.
        const inserted = await rows.putIfAbsent({
          ...rest,
          kind: 'reversal',
          basisMinor: -accrual.basisMinor,
          amountMinor: -accrual.amountMinor,
          state: 'accrued',
          createdAt: nowIso(),
        });
        if (!inserted) continue; // already reversed — idempotent
        written += 1;
        log.info('obligation_reversed', { sourceId, lineId: accrual.lineId, amountMinor: -accrual.amountMinor });
      }
      return written;
    },

    async listForPayee(tenantId: string, payeeSubject: string): Promise<ObligationRow[]> {
      const all = await rows.listByPrefix(`${tenantId}::`);
      return all.filter((r) => r.payeeSubject === payeeSubject).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async listForTenant(tenantId: string): Promise<ObligationRow[]> {
      return (await rows.listByPrefix(`${tenantId}::`)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async createRun(tenantId: string, actor: string, opts: { payeeSubject?: string } = {}): Promise<ObligationRun> {
      const all = await rows.listByPrefix(`${tenantId}::`);
      const candidates = all.filter((r) => r.state === 'accrued' && !r.payoutId
        && (opts.payeeSubject === undefined || r.payeeSubject === opts.payeeSubject));

      const nets = new Map<string, number>();
      for (const r of candidates) nets.set(`${r.payeeSubject}::${r.currency}`, (nets.get(`${r.payeeSubject}::${r.currency}`) ?? 0) + r.amountMinor);

      const runId = `payrun:${randomUUID()}`;
      const claimed: ObligationRow[] = [];
      for (const r of candidates) {
        if ((nets.get(`${r.payeeSubject}::${r.currency}`) ?? 0) <= 0) continue; // keep accruing
        const next: ObligationRow = { ...r, payoutId: runId };
        if (await rows.compareAndSwap(r, next)) claimed.push(next); // CAS loser ⇒ another run owns it
      }

      // The net>0 gate ran on a SNAPSHOT but rows were claimed individually: a
      // concurrent run (or a refund landing mid-claim) can split a reversal from
      // its accrual. Recompute nets from the rows ACTUALLY claimed and release
      // any group that no longer clears zero — a run never carries a
      // non-positive entry.
      const byEntry = new Map<string, ObligationRunEntry>();
      for (const r of claimed) {
        const k = `${r.payeeSubject}::${r.currency}`;
        const e = byEntry.get(k) ?? { payeeSubject: r.payeeSubject, currency: r.currency, totalMinor: 0, rowCount: 0 };
        e.totalMinor += r.amountMinor;
        e.rowCount += 1;
        byEntry.set(k, e);
      }
      const kept: ObligationRow[] = [];
      for (const r of claimed) {
        if ((byEntry.get(`${r.payeeSubject}::${r.currency}`)?.totalMinor ?? 0) > 0) { kept.push(r); continue; }
        const { payoutId: _released, ...rest } = r;
        await rows.put(rest as ObligationRow); // back to the unclaimed pool
      }
      for (const [k, e] of [...byEntry.entries()]) if (e.totalMinor <= 0) byEntry.delete(k);
      if (kept.length === 0) throw new ObligationRunError('Nothing accrued to pay out.', 'nothing-accrued');

      const run: ObligationRun = {
        tenantId,
        runId,
        state: 'open',
        entries: [...byEntry.values()].sort((a, b) => a.payeeSubject.localeCompare(b.payeeSubject)),
        createdBy: actor,
        createdAt: nowIso(),
      };
      await runs.put(run);
      log.info('obligation_run_created', { tenantId, runId, entries: run.entries.length, rows: kept.length });
      return run;
    },

    async confirmRun(tenantId: string, runId: string, actor: string, reference: string): Promise<ObligationRun> {
      const run = await runs.get(`${tenantId}::${runId}`);
      if (!run) throw new ObligationRunError('Not found.', 'not-found');
      let next: ObligationRun;
      if (run.state === 'confirmed') {
        next = run; // idempotent re-confirm — still finish interrupted row flips below
      } else {
        if (run.state !== 'open') throw new ObligationRunError('Only an open run can be confirmed.', 'bad-state');
        // CAS the RUN transition FIRST: a concurrent cancel that also read
        // `open` loses this swap and errors — no double-pay interleave.
        next = { ...run, state: 'confirmed', confirmedAt: nowIso(), confirmedBy: actor, reference };
        if (!(await runs.compareAndSwap(run, next))) {
          throw new ObligationRunError('The run changed underneath this confirm — re-read and retry.', 'bad-state');
        }
      }
      // Row flips AFTER the claimed transition; re-entrant, so a crash mid-flip
      // is finished by the next (idempotent) confirm call.
      const claimed = (await rows.listByPrefix(`${tenantId}::`)).filter((r) => r.payoutId === runId && r.state === 'accrued');
      for (const r of claimed) await rows.put({ ...r, state: 'paid' });
      log.info('obligation_run_confirmed', { tenantId, runId, rows: claimed.length });
      return next;
    },

    async cancelRun(tenantId: string, runId: string): Promise<ObligationRun> {
      const run = await runs.get(`${tenantId}::${runId}`);
      if (!run) throw new ObligationRunError('Not found.', 'not-found');
      let next: ObligationRun;
      if (run.state === 'canceled') {
        next = run; // idempotent — still finish interrupted row releases below
      } else {
        if (run.state !== 'open') throw new ObligationRunError('Only an open run can be canceled.', 'bad-state');
        next = { ...run, state: 'canceled' };
        if (!(await runs.compareAndSwap(run, next))) {
          throw new ObligationRunError('The run changed underneath this cancel — re-read and retry.', 'bad-state');
        }
      }
      const claimed = (await rows.listByPrefix(`${tenantId}::`)).filter((r) => r.payoutId === runId && r.state === 'accrued');
      for (const r of claimed) {
        const { payoutId: _released, ...rest } = r;
        await rows.put(rest as ObligationRow);
      }
      log.info('obligation_run_canceled', { tenantId, runId, rowsReleased: claimed.length });
      return next;
    },

    async listRuns(tenantId: string): Promise<ObligationRun[]> {
      return (await runs.listByPrefix(`${tenantId}::`)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async __clear(): Promise<void> {
      await rows.__clear();
      await runs.__clear();
    },
  };
}
