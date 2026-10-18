export type GateBaselineResult =
  | { ok: true; baseline: number; note?: string }
  | { ok: false; error: string };
export declare function resolveGateBaseline(name: string, rawValue: string | undefined, fileDefault: number): GateBaselineResult;
export declare function readGateBaseline(gate: string, name: string, fileDefault: number): number;
