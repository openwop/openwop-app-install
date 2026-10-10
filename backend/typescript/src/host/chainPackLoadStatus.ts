/**
 * NP-V2 grade-code C-1 — what the last DEFAULT-ROOT chain-pack load refused,
 * readable after the fact.
 *
 * The registry-install lesson (ADR 0767 D7: 16 refusals invisible for eight days
 * behind a warn line) applies one layer down: a chain pack the loader refuses —
 * `workflow_chain_unpinned`, `workflow_chain_pin_invalid`, a schema failure — is a
 * template that silently disappears from the gallery while readiness says 200.
 * This records the refusals of the boot load and of every hot reload (both read
 * `defaultWorkflowChainPackRoots()`); `/readiness` reports them and
 * `verify-deploy.sh` refuses a revision that has any. Tests that load synthetic
 * roots call the loader directly and never touch this record.
 */

export interface ChainPackRefusal {
  pack: string;
  code: string;
}

export interface ChainPackLoadStatus {
  loaded: number;
  refused: ChainPackRefusal[];
}

let status: ChainPackLoadStatus = { loaded: 0, refused: [] };

export function recordChainPackLoad(outcome: { installed: readonly unknown[]; errors: ReadonlyArray<{ pack: string; code: string }> }): void {
  status = { loaded: outcome.installed.length, refused: outcome.errors.map((e) => ({ pack: e.pack, code: e.code })) };
}

/** A copy — callers must not be able to edit the record. */
export function chainPackLoadStatus(): ChainPackLoadStatus {
  return { loaded: status.loaded, refused: status.refused.map((r) => ({ ...r })) };
}
