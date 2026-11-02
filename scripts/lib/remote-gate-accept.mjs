/** ADR 0863 D9: local acceptance boundary. Run this installed/local reader, never
 * a reader supplied in the worker's artifacts. It neither imports Hyvemind GREEN
 * into the local ledger nor authorizes a merge, deploy or replacement gate.
 */
import { inspectRemoteGateCandidate } from './remote-gate-source.mjs';
import { validateRemoteGateResult } from './remote-gate-result.mjs';

export function acceptRemoteGateResult({ repo, home, ...input }) {
  // Validate the same local checkout on both sides of artifact validation. No
  // remote result field or transport artifact can supply this observation.
  const candidate = inspectRemoteGateCandidate({ repo, home, ...input });
  const result = validateRemoteGateResult(input);
  inspectRemoteGateCandidate({ repo, home, ...input });
  return { ...result, candidate, mergeAuthorized: false };
}
