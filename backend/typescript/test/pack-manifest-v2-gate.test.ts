/**
 * RFC 0177 §E.1 — the registry's major-2 pack gate (`checkPackManifestForMajor`,
 * `src/host/packManifestV2Gate.ts`) refuses a `kind:"workflow-chain"` manifest
 * whose node typeIds or external sub-chain versions are not exact SemVer pins.
 *
 * The pin RULE itself is owned and covered by `chainPinRule.ts` /
 * `chain-pin-rule.test.ts` (ADR 0766). This file's own claim is that the GATE
 * DELEGATES to that rule for workflow-chain manifests, so a pack that the
 * loader would refuse is refused at the registry too. Each refusal asserts the
 * rule's own MESSAGE, not just `validation_error`, because the node-pin and
 * sub-chain findings share that code; the message tells them apart.
 *
 * What breaks it: dropping the `workflowChainPinRefusal` call from the gate
 * (probe 8fw1g1-v2-delegate), or the sub-chain half of the rule
 * (8fw1g1-v2-subchain).
 */
import { describe, expect, it } from 'vitest';
import { checkPackManifestForMajor } from '../src/host/packManifestV2Gate.js';

function chainManifest(typeId: string, externalVersion?: string): Record<string, unknown> {
  return {
    name: 'core.openwop.pin-test',
    version: '1.0.0',
    kind: 'workflow-chain',
    engines: { openwop: '>=2.0.0 <3.0.0' },
    chains: [{
      chainId: 'core.openwop.pin-test.chain',
      version: '1.0.0',
      dag: { nodes: [{ id: 'n1', typeId }], edges: [] },
      ...(externalVersion === undefined ? {} : {
        subChains: [{ ref: { packName: 'core.openwop.remote', chainId: 'remote', version: externalVersion } }],
      }),
    }],
  };
}

describe('RFC 0177 §E.1 workflow-chain exact pins', () => {
  it('accepts exact node and external sub-chain versions', () => {
    expect(checkPackManifestForMajor(chainManifest('core.ai.callPrompt@1.0.0', '2.3.4'), 2)).toBeNull();
  });

  it.each(['core.ai.callPrompt@^1', 'core.ai.callPrompt', 'core.ai.callPrompt@1.0'])('refuses ranged or missing node pin %s', (typeId) => {
    const refusal = checkPackManifestForMajor(chainManifest(typeId), 2);
    expect(refusal?.code).toBe('validation_error');
    expect(refusal?.message).toContain(`workflow-chain node typeId "${typeId}" MUST end in an exact SemVer pin`);
  });

  it.each(['^1.0.0', '>=1.0.0 <2.0.0', 'latest'])('refuses ranged external sub-chain version %s', (version) => {
    const refusal = checkPackManifestForMajor(chainManifest('core.ai.callPrompt@1.0.0', version), 2);
    expect(refusal?.code).toBe('validation_error');
    expect(refusal?.message).toContain(`workflow-chain external sub-chain version "${version}" MUST be an exact SemVer pin`);
  });
});
