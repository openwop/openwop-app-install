/**
 * Is this host running as ITS OWN PROCESS — i.e. was `main()` in `src/index.ts`
 * the entry point — or was it built by `createApp` inside someone else's?
 *
 * ADR 0739 D1. The RFC 0158 kill seam performs a genuine `SIGKILL` on the
 * current process. In the default conformance lane and in every vitest, the
 * "current process" is the HARNESS: a kill there takes down the suite, not a
 * host. So the seam answers only when this is set, and only `main()` sets it.
 *
 * It is a structural fact rather than a second env flag on purpose (RFC 0158
 * item 12: "minting a second flag for one boundary is itself a hazard" — one
 * gets set in a context the other does not). Nobody can set this from a shell.
 */
let ownProcess = false;

export function markOwnProcess(): void {
  ownProcess = true;
}

export function isOwnProcess(): boolean {
  return ownProcess;
}

/** Test-only: restore the default so one test's mark cannot leak into the next. */
export function resetOwnProcessForTests(): void {
  ownProcess = false;
}
