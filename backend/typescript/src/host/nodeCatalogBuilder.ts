/**
 * Node-catalog builder — the SINGLE source of the host's resolvable node menu,
 * shared by the builder-palette route (`routes/nodeCatalog.ts`) and the AI
 * workflow-author feature (ADR 0072), so the authoring brain plans against the
 * exact same closed-world catalog the palette renders.
 *
 * Returns every resolvable node typeId on this host: the locally-registered
 * sample modules + any node declared in a pack manifest under OPENWOP_PACK_DIR.
 * Metadata only — no executable code. Schema refs (config/input/output) are read
 * from pack.json and inlined when small (<8kb each); larger schemas are flagged
 * (`$ref` + `_note`) rather than inlined.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { requiredHostSurfacesFor } from '../bootstrap/hostSurfaceMap.js';
import { listHostSurfaces } from '../bootstrap/hostSurfaceRegistry.js';
import type { WorkflowDefinition } from '../executor/types.js';

const MAX_SCHEMA_INLINE_BYTES = 8 * 1024;

export interface CatalogNode {
  typeId: string;
  version: string;
  label: string;
  description: string;
  category: string;
  role?: string;
  capabilities?: readonly string[];
  /** Source: 'local' for in-process modules, 'pack' for registry packs. */
  source: 'local' | 'pack';
  /** Pack name when source='pack'. */
  packName?: string;
  configSchema?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Host surfaces this node needs to execute (e.g., `host.kvStorage`). Empty
   *  means no host surface required (pure data / control nodes). */
  requiresHostSurfaces: string[];
  /** Subset of `requiresHostSurfaces` this host does NOT advertise. Empty means
   *  the node is runnable here. */
  missingHostSurfaces: string[];
  /** RFC 0031 §B — model-capability identifiers this NodeModule depends on. */
  requiredModelCapabilities?: string[];
  /** RFC 0031 §B — host-substitution coordinates when the active model can't
   *  satisfy `requiredModelCapabilities`. */
  fallbackModel?: { provider: string; model: string };
}

interface PackManifestNode {
  typeId: string;
  version: string;
  label?: string;
  description?: string;
  category?: string;
  role?: string;
  capabilities?: string[];
  requiredModelCapabilities?: string[];
  fallbackModel?: { provider: string; model: string };
  configSchemaRef?: string;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
}

interface PackManifest {
  name: string;
  version: string;
  nodes?: PackManifestNode[];
}

/** Build the de-duplicated node catalog for this host. */
export function buildNodeCatalog(): CatalogNode[] {
  const supported = new Set(listHostSurfaces().filter((s) => s.supported).map((s) => s.name));
  const nodes: CatalogNode[] = [];

  // 1. Locally-registered modules from the in-process NodeRegistry. These have
  //    no metadata beyond typeId/version; the frontend's static catalog supplies
  //    labels/categories for them.
  const registry = getNodeRegistry();
  for (const typeId of registry.listTypeIds()) {
    const mod = registry.get(typeId);
    if (!mod) continue;
    const required = requiredHostSurfacesFor(typeId);
    nodes.push({
      typeId,
      version: mod.version,
      label: typeId,
      description: '',
      category: 'flow',
      source: 'local',
      requiresHostSurfaces: [...required],
      missingHostSurfaces: required.filter((s) => !supported.has(s)),
    });
  }

  // 2. Pack-declared nodes scanned from ./packs/*/pack.json. We surface even
  //    packs whose modules haven't loaded yet (the resolver loads them on first
  //    use) — the builder palette declares a graph using a pack node before it's
  //    resolved.
  const packDir = resolveDefaultPackDir();
  if (existsSync(packDir)) {
    for (const entry of readdirSync(packDir)) {
      const manifestPath = join(packDir, entry, 'pack.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: PackManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackManifest;
      } catch {
        continue;
      }
      if (!Array.isArray(manifest.nodes)) continue;
      for (const n of manifest.nodes) {
        const required = requiredHostSurfacesFor(n.typeId);
        nodes.push({
          typeId: n.typeId,
          version: n.version,
          label: n.label ?? n.typeId,
          description: n.description ?? '',
          category: n.category ?? 'flow',
          role: n.role,
          capabilities: n.capabilities,
          source: 'pack',
          packName: manifest.name,
          configSchema: readSchemaInline(packDir, entry, n.configSchemaRef),
          inputSchema: readSchemaInline(packDir, entry, n.inputSchemaRef),
          outputSchema: readSchemaInline(packDir, entry, n.outputSchemaRef),
          requiresHostSurfaces: [...required],
          missingHostSurfaces: required.filter((s) => !supported.has(s)),
          ...(Array.isArray(n.requiredModelCapabilities) ? { requiredModelCapabilities: n.requiredModelCapabilities } : {}),
          ...(n.fallbackModel ? { fallbackModel: n.fallbackModel } : {}),
        });
      }
    }
  }

  // De-duplicate by typeId, preferring 'pack' source (richer metadata).
  const byTypeId = new Map<string, CatalogNode>();
  for (const n of nodes) {
    const existing = byTypeId.get(n.typeId);
    if (!existing || (existing.source === 'local' && n.source === 'pack')) {
      byTypeId.set(n.typeId, n);
    }
  }
  return Array.from(byTypeId.values());
}

/**
 * The set of node typeIds this host can actually RUN — every catalog node whose
 * required host surfaces are all advertised (no `missingHostSurfaces`). This is
 * the "closed world" a workflow may legally reference: a typeId outside it would
 * dispatch to `unknown_typeid` (absent) or fail for a missing surface at run
 * time. Reusable by any caller that wants to validate a definition against what
 * this host can run (the AI workflow-author, a builder pre-flight, a linter).
 */
export function runnableNodeTypeIds(): Set<string> {
  return new Set(buildNodeCatalog().filter((n) => n.missingHostSurfaces.length === 0).map((n) => n.typeId));
}

/** Node typeIds in `def` that are NOT in `legal` (defaults to the runnable set).
 *  Empty ⇒ the definition is closed-world-valid for this host. */
export function findUnknownTypeIds(def: WorkflowDefinition, legal: Set<string> = runnableNodeTypeIds()): string[] {
  const bad = new Set<string>();
  for (const node of def.nodes) {
    if (!legal.has(node.typeId)) bad.add(node.typeId);
  }
  return [...bad];
}

function readSchemaInline(packDir: string, packEntry: string, ref: string | undefined): unknown {
  if (!ref) return undefined;
  // Refuse path-traversal attempts; only relative refs within the pack dir.
  if (ref.includes('..') || ref.startsWith('/')) return undefined;
  const schemaPath = join(packDir, packEntry, ref);
  if (!existsSync(schemaPath)) return undefined;
  try {
    const raw = readFileSync(schemaPath);
    if (raw.byteLength > MAX_SCHEMA_INLINE_BYTES) return { $ref: ref, _note: 'schema too large to inline' };
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return undefined;
  }
}
