/**
 * Module-scope NodeRegistry singleton. Sample uses a single in-process
 * registry — multi-instance hosts would replicate via a shared DB or
 * a message bus.
 */

import type { NodeModule } from './types.js';

type NodePackResolver = (typeId: string) => Promise<NodeModule | null>;
/** Sync twin of the pack resolver: does an installed pack DECLARE this typeId? */
type NodePackIndexProbe = (typeId: string) => boolean;

const inProcess = new Map<string, NodeModule>();
/** typeIds the host registered itself (`register`). A pack never replaces one
 *  (#5808): `core.openwop.flow` aliases `core.delay` to its own `waitNode`, and
 *  the first flow-pack load used to swap the reserved node out for every later
 *  run on the instance. */
const hostOwned = new Set<string>();
let resolver: NodePackResolver | null = null;
let indexProbe: NodePackIndexProbe | null = null;

export function getNodeRegistry() {
  return {
    register(node: NodeModule): void {
      inProcess.set(node.typeId, node);
      hostOwned.add(node.typeId);
    },
    /** A pack's node. Refused (returns false) when the host owns the typeId;
     *  a later pack load still replaces an earlier pack's module. */
    registerFromPack(node: NodeModule): boolean {
      if (hostOwned.has(node.typeId)) return false;
      inProcess.set(node.typeId, node);
      return true;
    },
    has(typeId: string): boolean {
      return inProcess.has(typeId);
    },
    /** Synchronous get (in-process only). */
    get(typeId: string): NodeModule | null {
      return inProcess.get(typeId) ?? null;
    },
    /** Async resolve — falls through to the pack resolver on miss.
     *  Note: a pack-resolver call usually registers EVERY typeId in
     *  the pack (loadPackFromManifest iterates the full `nodes` map),
     *  not just the one we asked for. The resolver's return value is
     *  typically the FIRST module registered in that pass — which is
     *  not necessarily the one we wanted. So after the resolver runs,
     *  re-read inProcess[typeId] to get the right module. */
    async resolve(typeId: string): Promise<NodeModule | null> {
      const direct = inProcess.get(typeId);
      if (direct) return direct;
      if (resolver) {
        await resolver(typeId);
        const reread = inProcess.get(typeId);
        if (reread) return reread;
      }
      return null;
    },
    /** Would `resolve(typeId)` find a module? In-process registration, or an
     *  installed pack whose manifest declares it — the same two lanes
     *  `resolve()` walks, answered without loading the pack. The conformance
     *  fixture advert (`host/index.ts`) reads this so it can only offer a
     *  fixture whose every node the executor would actually find. */
    isResolvable(typeId: string): boolean {
      return inProcess.has(typeId) || (indexProbe?.(typeId) ?? false);
    },
    listTypeIds(): readonly string[] {
      return Array.from(inProcess.keys()).sort();
    },
  };
}

export function setNodePackResolver(fn: NodePackResolver, probe?: NodePackIndexProbe): void {
  resolver = fn;
  indexProbe = probe ?? null;
}
