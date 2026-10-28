/**
 * The ONE reading of the `agents.proposals` advertisement, shared by discovery and
 * the v2 routes so the two cannot disagree (ADR 0938 D3, ADR 0972 D9).
 *
 * Advertised only when `OPENWOP_PROPOSALS_ENABLED=true` AND some kind has a
 * registered installer, with `artifactKinds` = exactly those kinds. The
 * `prompt-template` installer is registered only once the vendored v2 schemas carry
 * RFC 0249 (`feature.ts`), so `clientDrafts` and `readback` appear with it and not
 * before.
 */

import { installableProposalKinds } from './proposalsService.js';
import type { ProposalKind } from './types.js';

export interface ProposalsFacet {
  artifactKinds: ProposalKind[];
  duplicationDetection: false;
  activation: 'direct-rbac';
  clientDrafts?: true;
  readback?: ProposalKind[];
}

/** Kinds whose installer has a v2 read-back (RFC 0249 §D). Phase 1: templates only. */
const READBACK_KINDS: readonly ProposalKind[] = ['prompt-template'];

export function proposalsFacet(): ProposalsFacet | null {
  const kinds = installableProposalKinds();
  if (process.env.OPENWOP_PROPOSALS_ENABLED !== 'true' || kinds.length === 0) return null;
  const readback = kinds.filter((k) => READBACK_KINDS.includes(k));
  return {
    artifactKinds: kinds,
    duplicationDetection: false,
    activation: 'direct-rbac',
    ...(readback.length > 0 ? { clientDrafts: true as const, readback } : {}),
  };
}
