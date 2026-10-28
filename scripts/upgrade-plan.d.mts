/** Types for scripts/upgrade-plan.mjs (consumed by backend tests). */
export interface ReleaseEntry {
  version: string;
  date: string;
  requiredStop: boolean;
  requiredStopReason: string | null;
  rollingSafe: boolean;
  rollingUnsafeReason: string | null;
  schemaVersion: { sqlite: number; postgres: number };
  appMigrationVersion: number;
  breakingConfig: string[];
  notes: string;
}

export interface ReleaseManifest {
  latest: string;
  releases: ReleaseEntry[];
  [k: string]: unknown;
}

export interface UpgradeStep {
  from: string;
  to: string;
  requiredStop: boolean;
  requiredStopReason: string | null;
  stopOldBinary: boolean;
  stopOldBinaryBecause: string[];
  backupFirst: true;
  schema: { sqlite: [number, number]; postgres: [number, number]; app: [number, number] };
  operatorActions: string[];
  releaseNotes: string[];
}

export interface UpgradePlan {
  from: string;
  to: string;
  steps: UpgradeStep[];
}

export class PlanError extends Error {}
export function compareVersions(a: string, b: string): number;
export function validateReleases(manifest: unknown): string[];
export function planUpgrade(manifest: ReleaseManifest, from: string, to?: string): UpgradePlan;
export function formatPlan(plan: UpgradePlan): string;
export function readManifest(path?: string): ReleaseManifest;
