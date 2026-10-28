/**
 * ADR 0946 D5 — pre-flight for a creative round through the ONE content-rules
 * library: `channel-policy`, `accessibility`, `diversity`, `fidelity` and
 * `brand-lock`, in the ADR 0933 finding frame. Pure and deterministic: the
 * same input gives the same findings, ids and digest, so a review can
 * recompute it at decision time (0933 D5).
 *
 * Every finding is `introduced` for a new set (D5). The P4 `preflight` node
 * builds the input from a VariantSet and stores the report on it.
 */
import { reportDigest, normalizeFindings, rulesetVersionOf, type ContentFinding } from '../findings.js';
import { CHANNEL_SPECS_VERSION } from '../channelSpecs.js';
import { checkChannelPolicy } from './channelPolicy.js';
import { checkAccessibility } from './accessibility.js';
import { checkFidelity } from './fidelity.js';
import { checkBrandLocks } from './brandLock.js';
import { scoreDiversity } from './diversity.js';
import type { CreativeRulesInput, CreativeRulesReport } from './types.js';

/** The `creative` family's version. Bump on any rule, threshold or message
 *  change. The channel table's version is part of it, so a table edit changes
 *  the digest too. A report names it as `creative@…` (`rulesetVersionOf`). */
export const CREATIVE_RULES_VERSION = `2026-10-20.1/channels-${CHANNEL_SPECS_VERSION}`;

export function checkCreative(input: CreativeRulesInput): CreativeRulesReport {
  const findings: ContentFinding[] = [];
  for (const m of input.members) {
    findings.push(...checkChannelPolicy(m), ...checkAccessibility(m), ...checkFidelity(m), ...checkBrandLocks(m, input.brandLocks));
  }
  const rulesetVersion = rulesetVersionOf({ creative: CREATIVE_RULES_VERSION });
  const diversity = scoreDiversity(input, rulesetVersion);
  findings.push(...diversity.findings);
  const normalized = normalizeFindings(findings);
  return { rulesetVersion, asOf: input.asOf, findings: normalized, digest: reportDigest(rulesetVersion, normalized), diversity: diversity.report };
}
