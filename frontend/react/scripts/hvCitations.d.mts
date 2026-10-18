export declare const EVIDENCE: RegExp;
export declare const NEGATED: RegExp;
export declare function rowBlock(lines: readonly string[], i: number): string;
export declare function classifyRow(text: string): 'cited' | 'negated' | 'bare';
export declare const FILE_ROW_FLOOR: number;
export type RowFloorResult =
  | { ok: true; floor: number; note?: string }
  | { ok: false; error: string };
export declare function resolveRowFloor(envValue: string | undefined, fileFloor?: number): RowFloorResult;
