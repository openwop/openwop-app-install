/** Lossless source binding and presentation projection, owned by the builder.
 * Nothing in this module adds fields to the OpenWOP wire (ADR 0440). */
import i18n from '../../i18n/index.js';
import type { BuilderEdge, PortDef, PortType } from './workflow.js';

export type SourceBinding = Pick<BuilderEdge, 'sourcePort' | 'canonicalSourceOutput'>;
export interface SourceProjection {
  handleId: string;
  label: string;
  type: PortType;
  virtual: boolean;
  missing: boolean;
  /** CC-BLD-1 — a virtual port for a NAMED output that is not missing (declared
   *  optional, or on an open/undeclared schema), as opposed to the default port. */
  named: boolean;
}
export function sourceOutputForWire(edge: SourceBinding): string | undefined {
  const binding = edge.canonicalSourceOutput;
  if (binding === null) return undefined;
  if (typeof binding === 'string') return binding;
  if (binding !== undefined) throw new Error(i18n.t('builder:errCanonicalSourceOutput'));
  return edge.sourcePort && edge.sourcePort !== 'out' && edge.sourcePort !== 'output' ? edge.sourcePort : undefined;
}
export function sameSourceBinding(a: SourceBinding, b: SourceBinding): boolean {
  return sourceOutputForWire(a) === sourceOutputForWire(b);
}
function virtualHandle(base: string, outputs: readonly PortDef[]): string {
  const names = new Set(outputs.map(p => p.name));
  let id = base;
  // ':' never appears in the fixed-width hex name encoding, so appending it cannot
  // make two distinct missing names alias even when a real name collides.
  while (names.has(id)) id += ':';
  return id;
}
/** Encode JS code units, not Unicode scalar values: lone surrogates are valid
 * JSON strings too. Fixed four-hex-unit width is total and injective, without
 * normalizing/replacing any source name or exposing it to a URI encoder. */
function encodeSourceName(name: string): string {
  let encoded = '';
  for (let index = 0; index < name.length; index += 1) {
    encoded += name.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return encoded;
}
/** What the catalog knows beyond the port list (CC-BLD-1): every output name the
 * node's schema declares (required or optional), and whether that list is CLOSED
 * (`additionalProperties: false`). A pack with no output schema is `{ names: [],
 * closed: false }`. Absent = a curated entry whose ports are authoritative. */
export type DeclaredOutputs = { readonly names: readonly string[]; readonly closed: boolean } | undefined;

export function projectSourceOutput(edge: SourceBinding, outputs: readonly PortDef[], language?: string, declared?: DeclaredOutputs): SourceProjection {
  // Legacy records retain their old visible port. Their omission history is unknown.
  const name = edge.canonicalSourceOutput === undefined ? edge.sourcePort : edge.canonicalSourceOutput;
  if (name === null) return {
    handleId: virtualHandle('__openwop_default_output', outputs),
    label: i18n.t('builder:defaultSourceOutput', { lng: language }),
    type: outputs.find(p => p.name === 'output')?.type ?? 'any', virtual: true, missing: false, named: false,
  };
  const port = outputs.find(p => p.name === name);
  if (port) return { handleId: name, label: name, type: port.type, virtual: false, missing: false, named: false };
  // CC-BLD-1 — a name the schema declares without a port (an optional output), or
  // any name on an open schema (no schema, or extra properties allowed), is not
  // known to be missing: the node may well return it. Flag only names a CLOSED
  // declared schema (or a curated entry's ports) rules out.
  if (declared && (declared.names.includes(name) || !declared.closed)) return {
    handleId: virtualHandle(`__openwop_named_output:${encodeSourceName(name)}`, outputs),
    label: declared.names.includes(name) ? name : i18n.t('builder:undeclaredSourceOutput', { name, lng: language }),
    type: 'any', virtual: true, missing: false, named: true,
  };
  return {
    handleId: virtualHandle(`__openwop_missing_output:${encodeSourceName(name)}`, outputs),
    label: i18n.t('builder:missingSourceOutput', { name, lng: language }),
    type: 'any', virtual: true, missing: true, named: false,
  };
}
export function virtualSourceOutputs(edges: readonly SourceBinding[], outputs: readonly PortDef[], language?: string, declared?: DeclaredOutputs): SourceProjection[] {
  const ports = new Map<string, SourceProjection>();
  for (const edge of edges) {
    const port = projectSourceOutput(edge, outputs, language, declared);
    if (port.virtual) ports.set(port.handleId, port);
  }
  return [...ports.values()];
}
