/** CC-BLD-1 — the ONE place a source projection is computed from a node kind.
 * Every caller (canvas edges, a node's virtual ports, pair ghost edges, the edge
 * inspector, node connections, pair edge types) must pass the same catalog facts,
 * or an edge's sourceHandle stops matching a port the node renders and the label
 * disagrees between surfaces. Builder presentation only; nothing reaches the wire. */
import { catalogEntry } from '../palette/catalogRegistry.js';
import { projectSourceOutput, virtualSourceOutputs, type SourceBinding, type SourceProjection } from '../schema/sourceOutput.js';

export function projectSourceOutputForKind(edge: SourceBinding, kind: string | undefined, language?: string): SourceProjection {
  const entry = catalogEntry(kind ?? '');
  return projectSourceOutput(edge, entry?.outputs ?? [], language, entry?.declaredOutputs);
}

export function virtualSourceOutputsForKind(edges: readonly SourceBinding[], kind: string | undefined, language?: string): SourceProjection[] {
  const entry = catalogEntry(kind ?? '');
  return virtualSourceOutputs(edges, entry?.outputs ?? [], language, entry?.declaredOutputs);
}
