/**
 * ADR 0889 EVD-2 — the host_ext_kv key patterns a run delete must clear for the
 * agent tool-boundary capture (`host/evals/toolBoundary.ts`). Storage cannot
 * import the host module, so the key shapes are restated here and pinned by the
 * end-to-end cascade test (`adr0889-store-integrity.test.ts`): capture through the
 * real wrapper, delete the run, assert zero rows remain on both adapters.
 *
 *   hostext:agent:tool-boundary:<tenant>:<runId>:<wrapId>:<seq>   (calls)
 *   hostext:agent:tool-boundary:<tenant>:<runId>:#cap             (per-run counter)
 *   hostext:agent:tool-boundary-run:<tenant>:<agentId>:<runId>    (capture index)
 *
 * LIKE patterns with `\` as the escape (Postgres's default; sqlite passes
 * `ESCAPE '\'`). Ids are escaped so a `%`/`_` in a tenant or run id can never
 * widen the delete to another run's rows.
 */
const esc = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function toolBoundaryKeyPatterns(tenantId: string, runId: string): string[] {
  const t = esc(tenantId);
  const r = esc(runId);
  return [
    `hostext:agent:tool-boundary:${t}:${r}:%`,
    `hostext:agent:tool-boundary-run:${t}:%:${r}`,
  ];
}
