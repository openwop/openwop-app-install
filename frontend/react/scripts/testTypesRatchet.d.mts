export declare const FILE_BASELINE: number;
export type BaselineResult =
  | { ok: true; baseline: number; note?: string }
  | { ok: false; error: string };
export declare function resolveBaseline(envValue: string | undefined, fileBaseline?: number): BaselineResult;
export interface TscRun { output?: string; status?: number; spawnFailed?: boolean; spawnCode?: string }
export type TscClassification =
  | { ok: true; count: number; errors: string[] }
  | { ok: false; reason: string; detail: string };
export declare function classifyTscResult(result: TscRun): TscClassification;
