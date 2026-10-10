/**
 * The run-bound options, read the same way on both majors.
 *
 * v1 `run-options.md` puts them FLAT on the open `configurable` bag
 * (`configurable.runTimeoutMs`). v2 `runs.md` §`configurable` (RFC 0171 §D.1)
 * moves them into the closed `run` section (`configurable: { version: 1, run: {
 * runTimeoutMs } }`, `schemas/v2/configurable.schema.json` → `properties.run`).
 * The executor read only the flat key, so under major 2 a 1 s `runTimeoutMs`
 * never fired and `recursionLimit` was ignored (found by the corpus steward's
 * suite 2.45.15 witness wave, rows `runs.run-timeout-breach` /
 * `v2-run-execution-bounds`).
 *
 * The flat key wins when both are present. A v2 body cannot carry it (the closed
 * root refuses unknown keys), so it is present only on a v1 run, where it
 * always applied.
 */
export type RunOptionKey = 'recursionLimit' | 'runTimeoutMs' | 'maxLoopIterations' | 'escalationThreshold';

export function runOption(configurable: unknown, key: RunOptionKey): unknown {
  if (configurable === null || typeof configurable !== 'object') return undefined;
  const bag = configurable as Record<string, unknown>;
  if (bag[key] !== undefined) return bag[key];
  const section = bag['run'];
  return section !== null && typeof section === 'object' ? (section as Record<string, unknown>)[key] : undefined;
}
