// ADR 0880 — types for the shared Tracegate recorder (plain .mjs, no build step).
export function installRecorder(opts: {
  afterAll: (fn: () => Promise<void> | void) => void;
  expect: { getState(): { testPath?: string } };
  /** Absolute repo root. */
  repoRoot: string;
  /** Repo-relative lane directory, e.g. `backend/typescript`. */
  laneDir: string;
  /** ADR 0968 P2 (shadow only): a SYNCHRONOUS digest of what one app boot left
   *  behind, run inside each `__tracegateBoot('end', app)` mark. It must load
   *  nothing; its own coverage window is discarded. */
  bootDigest?: (app: unknown) => string;
  /** Repo-relative path of the digest module, left out of every footprint. */
  bootDigestFile?: string;
}): Promise<void>;
