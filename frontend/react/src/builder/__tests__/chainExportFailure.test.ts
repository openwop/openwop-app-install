/**
 * grade-ux U-3/U-8, grade-code C-14 — the one mapping both chain-export actions
 * use to turn a failure into author-facing words and a node to select.
 * Breaks it: naming nodes by kind instead of their canvas label, dropping the
 * selection of the first offender, blaming nodes when the catalog never loaded,
 * or losing a SerializeError's own node.
 */
import { describe, expect, it } from 'vitest';
import { chainExportFailure } from '../builderShellHelpers.js';
import { ChainExportVersionError } from '../schema/chainPackManifest.js';
import { SerializeError } from '../schema/serialize.js';

const nodes = [
  { id: 'n1', kind: 'vendor.x.summarize', name: 'Summarize feedback' },
  { id: 'n2', kind: 'vendor.x.search', name: 'Find sources' },
  { id: 'n3', kind: 'vendor.x.summarize', name: 'Summarize again' },
];

describe('chainExportFailure', () => {
  it('names the offending node INSTANCES by their canvas labels and selects the first', () => {
    const out = chainExportFailure(new ChainExportVersionError(['vendor.x.summarize']), nodes, true);
    expect(out.message).toContain('Summarize feedback, Summarize again');
    expect(out.message).toMatch(/^Could not export this chain pack/);
    expect(out.selectNodeId).toBe('n1');
  });

  it('blames the catalog, not the nodes, when the catalog never loaded', () => {
    const out = chainExportFailure(new ChainExportVersionError(['vendor.x.summarize', 'vendor.x.search']), nodes, false);
    expect(out.message).toMatch(/node catalog didn't load/);
    expect(out.selectNodeId).toBeUndefined();
  });

  it('falls back to the type id when no instance matches', () => {
    const out = chainExportFailure(new ChainExportVersionError(['vendor.y.gone']), nodes, true);
    expect(out.message).toContain('vendor.y.gone');
    expect(out.selectNodeId).toBeUndefined();
  });

  it('a serialization error keeps its own message and node', () => {
    expect(chainExportFailure(new SerializeError('cycle at n2', 'n2'), nodes, true)).toEqual({ message: 'cycle at n2', selectNodeId: 'n2' });
  });
});
