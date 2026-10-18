// ADR 0880 — types for the shared Tracegate recorder (plain .mjs, no build step).
export function installRecorder(opts: {
  afterAll: (fn: () => Promise<void> | void) => void;
  expect: { getState(): { testPath?: string } };
  /** Absolute repo root. */
  repoRoot: string;
  /** Repo-relative lane directory, e.g. `backend/typescript`. */
  laneDir: string;
}): Promise<void>;
