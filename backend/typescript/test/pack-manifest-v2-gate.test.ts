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
    expect(checkPackManifestForMajor(chainManifest(typeId), 2)).toMatchObject({ code: 'validation_error' });
  });

  it.each(['^1.0.0', '>=1.0.0 <2.0.0', 'latest'])('refuses ranged external sub-chain version %s', (version) => {
    expect(checkPackManifestForMajor(chainManifest('core.ai.callPrompt@1.0.0', version), 2)).toMatchObject({ code: 'validation_error' });
  });
});
