// Types for scripts/measure-storage-growth.mjs (ADR 0871), for its unit test.
export declare const TRIGGERS: {
  t1TenantRows: number;
  t1HeavyPerDayPerFamily: number;
  t2TableQueryHeavyPerDay: number;
  t3NamespaceRows: number;
  t3SlowQueriesPerDay: number;
};

export interface FamilyGrowth {
  maxTenantRows: number;
  latestTotalRows: number;
  earliestTotalRows: number | null;
  heavy: number;
}

export interface GrowthVerdict {
  status: 'CLEAR' | 'TRIGGERED' | 'UNMEASURED';
  reason?: string;
  days?: number;
  failed: number;
  truncated?: string;
  families: Record<string, FamilyGrowth>;
  heavyByOp: Record<string, number>;
  t1: { triggered: boolean; families: string[] };
  t2: { triggered: boolean; tableQueryHeavyPerDay: number };
  t3: {
    triggered: boolean;
    maxNamespaceRows: number;
    slowPerDay: number;
    measured: boolean;
    pgvector: string | null;
    iterativeScanAvailable: boolean | null;
  };
}

export declare function evaluate(
  entries: ReadonlyArray<Record<string, unknown>>,
  days: number,
  t?: typeof TRIGGERS,
): GrowthVerdict;

export declare function versionAtLeast(v: string, major: number, minor: number): boolean;
