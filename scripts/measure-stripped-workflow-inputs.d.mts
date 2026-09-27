// Types for measure-stripped-workflow-inputs.mjs. The implementation stays plain
// ESM JavaScript because `scripts/*.mjs` are run directly by node (no build
// step); this declaration exists so the vitest suite importing it is fully typed
// — an untyped .mjs import resolves to `any`, which is banned in this repo.

/**
 * A workflow definition, structurally — only the parts this tool reads.
 *
 * No `[k: string]: unknown` index signature: it would make the real
 * `WorkflowDefinition` unassignable here, which would force the tests to cast
 * and defeat the point of typing this at all.
 */
export interface MeasuredDefinition {
  workflowId?: string;
  nodes?: unknown;
}

export interface HeadRow {
  workflowId: string;
  definition: MeasuredDefinition;
}

export interface RevisionRow {
  workflowId: string;
  tenantId?: string;
  definition: MeasuredDefinition;
}

export interface OwnershipRow {
  workflowId: string;
  tenantId: string;
}

export interface ClassifiedEntry {
  workflowId: string;
  /** Input-carrying node count on the CURRENT head. */
  now: number;
  /** The most this workflow ever carried, across surviving revisions. */
  everHad: number;
  tenants: string[];
}

export interface PopulationCounts {
  heads: number;
  /** Head carries none; an earlier revision did. A FLOOR, never the total. */
  stripped: number;
  intact: number;
  /** No inputs now, none ever recorded — NOT provably clean. */
  unknowable: number;
  /** DISTINCT tenants with >=1 stripped head (never workflow×tenant pairs). */
  strippedTenants: number;
  unownedHeads: number;
  /** DD-0524-1 — stripped revisions still reachable as rollback targets. */
  poisonedRollbackTargets: number;
  revisionsScanned: number;
}

export interface PopulationResult {
  counts: PopulationCounts;
  buckets: {
    stripped: ClassifiedEntry[];
    intact: ClassifiedEntry[];
    unknowable: ClassifiedEntry[];
  };
}

/**
 * Count nodes carrying a NON-EMPTY `inputs` object. Mirrors the module-private
 * counter in `host/preserveDroppedFields.ts`; the parity is asserted
 * behaviourally in the test, because two copies of one predicate is how a tool
 * ends up measuring a population the guard does not act on.
 *
 * Accepts `unknown` deliberately: it scans rows straight out of the database,
 * where a malformed definition must degrade to 0 rather than kill the scan.
 */
export declare function nodesCarryingInputs(def: unknown): number;

/** Classify every head against its own revision history. */
export declare function classifyPopulation(
  heads: HeadRow[],
  revisions: RevisionRow[],
  ownership?: OwnershipRow[],
): PopulationResult;

/**
 * Render the report. Deliberately emits four figures and NO headline
 * percentage — a single "% clean" line reads as the answer and silently
 * absorbs the unknowable bucket.
 */
export declare function formatReport(result: PopulationResult): string;

/**
 * Load `pg` from whichever workspace has it (the backend owns the dependency,
 * not the repo root). Exported so the sibling repair tool shares one resolution
 * path rather than duplicating the fallback chain.
 *
 * Rejects with a message that distinguishes "not installed" from "installed but
 * failed to load" — reporting the latter as the former sends an operator to
 * reinstall a package that is already there.
 */
export declare function loadPg(): Promise<{ Client: new (config: { connectionString?: string }) => {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<{ k: string; v: string }>; rowCount: number }>;
  end(): Promise<void>;
} }>;
