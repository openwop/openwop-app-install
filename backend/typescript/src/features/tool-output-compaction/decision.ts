/**
 * ADR 0099 — resolve the per-run compaction decision at run-start.
 *
 * Registered as a `RunStartContributor` (host/runStartContext.ts): runs ONCE at
 * run creation, freezes the result into `run.metadata.compaction`, and is read
 * back verbatim on `:fork` — never re-resolved (replay-deterministic).
 *
 * Phase 1: structure-preserving only — `lossless` when the tenant's toggle is
 * enabled, else no stamp (identity). The per-agent `lossy` opt-in
 * (`agentProfile.compaction`) lands in Phase 2.
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { getAgentProfile } from '../../host/agentProfileService.js';
import type { RunStartContext } from '../../host/runStartContext.js';
import type { CompactionDecision } from '../../executor/types.js';
import { COMPACTION_METADATA_KEY } from '../../executor/compaction.js';

export const TOGGLE_ID = 'tool-output-compaction';

/**
 * The per-agent lossy opt-in, stored in `agentProfile.configParameters.compaction`
 * (ADR 0031 open config map — no schema change). Parsed defensively: an untyped
 * map could hold anything, so non-conforming values degrade to "no opt-in".
 */
interface AgentCompactionConfig {
  lossy?: boolean;
  head?: number;
  tail?: number;
  minChars?: number;
  /** Tool names whose output stays byte-exact (never compacted). */
  exemptTools?: string[];
}

function readAgentCompactionConfig(configParameters: unknown): AgentCompactionConfig | undefined {
  if (!configParameters || typeof configParameters !== 'object') return undefined;
  const raw = (configParameters as Record<string, unknown>)[COMPACTION_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: AgentCompactionConfig = {};
  if (typeof r.lossy === 'boolean') out.lossy = r.lossy;
  if (typeof r.head === 'number') out.head = r.head;
  if (typeof r.tail === 'number') out.tail = r.tail;
  if (typeof r.minChars === 'number') out.minChars = r.minChars;
  if (Array.isArray(r.exemptTools)) {
    const tools = r.exemptTools.filter((t): t is string => typeof t === 'string');
    if (tools.length) out.exemptTools = tools;
  }
  return out;
}

/**
 * The run-start contributor. Resolves the tenant toggle and, when enabled,
 * returns `{ compaction: { mode: 'lossless' } }` to be frozen into run.metadata.
 * When disabled, returns `{}` (no stamp ⇒ the run replays uncompacted, as born).
 * Fail-soft: any resolution error contributes nothing (host/runStartContext
 * swallows + logs), so a toggle outage never blocks run creation.
 */
export async function resolveCompactionDecision(ctx: RunStartContext): Promise<Record<string, unknown>> {
  const assignment = await resolveOne(TOGGLE_ID, { tenantId: ctx.tenantId });
  if (!assignment?.enabled) return {};

  // Base: structure-preserving lossless (Phase 1). `minChars` defaults to 0 —
  // compaction's own never-regress guard already prevents bloat on tiny payloads,
  // so a global floor would only forgo small-but-real savings (ADR 0099 §minChars,
  // resolved). A per-agent `minChars` override remains available below.
  const decision: CompactionDecision = { mode: 'lossless' };

  // ADR 0099 Phase 2/§residuals — per-agent overrides from
  // agentProfile.configParameters.compaction. Read ONCE here at run-start; never
  // live at the tool-result boundary (that would break replay). getAgentProfile is
  // tenant-scoped + fail-closed cross-tenant. Any miss ⇒ safe lossless default.
  if (ctx.agentId) {
    try {
      const profile = await getAgentProfile(ctx.tenantId, ctx.agentId);
      const cfg = readAgentCompactionConfig(profile?.configParameters);
      if (cfg) {
        // Lossy opt-in (Phase 2): upgrade mode + array head/tail.
        if (cfg.lossy) {
          decision.mode = 'lossy';
          if (cfg.head !== undefined) decision.head = cfg.head;
          if (cfg.tail !== undefined) decision.tail = cfg.tail;
        }
        // minChars floor + per-tool exemptions apply in BOTH modes (residuals).
        if (cfg.minChars !== undefined) decision.minChars = cfg.minChars;
        if (cfg.exemptTools) decision.exemptTools = cfg.exemptTools;
      }
    } catch {
      // fail-open: any profile-read error leaves the safe lossless default.
    }
  }

  return { [COMPACTION_METADATA_KEY]: decision };
}
