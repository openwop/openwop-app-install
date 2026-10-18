/** Types for `v1RelianceScan.mjs` (ADR 0786) — consumed by backend/typescript/test/check-v1-reliance.test.ts. */
export declare const STRIPE_CHOKE_FILE: string;
export declare const V1_PATH: string;
export declare function isThirdPartyApiCall(file: string, line: string): boolean;
export declare function scanMatches(root: string, dir: string, pattern: string, includes: string[], excludes?: string[]): string[];
export declare function stripeChokeViolations(root: string, srcDir?: string): string[];
export declare const KEEP_MARKER: string;
export declare function ownV1Pattern(segments: string[]): string;
export declare function keptLines(root: string, dirs: string[], includes: string[]): string[];
export declare function scanSites(root: string, dir: string, pattern: string, includes: string[], excludes?: string[]): { file: string; line: number; match: string }[];
