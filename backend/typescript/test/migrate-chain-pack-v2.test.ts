/**
 * RFC 0266 — `npm run chains:migrate-v2`: the path for a v1-signed chain pack
 * authored outside the registry. The loader refuses a v1 signing block
 * (`workflow_chain_pack_signing_v1`); this tool strips it (a v1 signature cannot be
 * relabelled, packs.md §Signing) and reports, never guesses, what the author must
 * declare: the engine ceiling and exact node pins.
 *
 * Breaks it: keeping or relabelling the v1 block fails case 1; touching a v2 block
 * fails case 2; silently accepting an engines range without major 2, or an unpinned
 * node reference, fails cases 3 and 4.
 */
import { describe, expect, it } from 'vitest';
import { migrateChainManifest } from '../scripts/migrate-chain-pack-v2.mjs';

const chain = (typeId: string) => ({
  chainId: 'acme.demo',
  dag: { nodes: [{ id: 'a', typeId }], edges: [] },
});
const base = (over: Record<string, unknown> = {}) => ({
  name: 'acme.chains', version: '1.0.0', kind: 'workflow-chain',
  engines: { openwop: '>=2.0.0 <3.0.0' },
  chains: [chain('core.flow.noop@1.0.0')],
  ...over,
});

describe('chains:migrate-v2 (RFC 0266)', () => {
  it('removes a v1 signing block and reports it', () => {
    const r = migrateChainManifest(base({ signing: { method: 'manual', publicKeyRef: 'k', signatureRef: 'pack.sig' } }));
    expect(r.manifest['signing']).toBeUndefined();
    expect(r.changes.join(' ')).toMatch(/removed the v1 signing block \(method, publicKeyRef, signatureRef\)/);
    expect(r.findings).toEqual([]);
  });

  it('keeps a v2 { keyId, scheme } block and changes nothing', () => {
    const signing = { keyId: 'openwop-team-1', scheme: 'ed25519-canonical-json' };
    const r = migrateChainManifest(base({ signing }));
    expect(r.manifest['signing']).toEqual(signing);
    expect(r.changes).toEqual([]);
  });

  it('reports an engines range that does not admit major 2', () => {
    const r = migrateChainManifest(base({ engines: { openwop: '>=1.0.0 <2.0.0' } }));
    expect(r.findings.join(' ')).toMatch(/does not admit protocol major 2/);
    expect((r.manifest['engines'] as { openwop: string }).openwop).toBe('>=1.0.0 <2.0.0');
  });

  it('hands an unpinned node reference to chains:pin', () => {
    const r = migrateChainManifest(base({ chains: [chain('core.flow.noop')] }));
    expect(r.findings.join(' ')).toMatch(/chains:pin/);
  });
});
