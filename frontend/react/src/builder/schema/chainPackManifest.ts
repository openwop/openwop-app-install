/**
 * Builder graph → RFC 0013 workflow-chain-pack manifest.
 *
 * Produces a `WorkflowChainPackManifest` (kind: "workflow-chain") with a
 * single chain whose `dag` is the built graph, conforming to
 * `schemas/workflow-chain-pack-manifest.schema.json`. This is the
 * *authoring* half of "publish as a chain pack" — the user downloads the
 * manifest and submits it via the PR-based registry flow (PUBLISHING.md);
 * the app never signs or pushes to the registry.
 *
 * The export was DESCRIBED as a degenerate (fully-bound, no `{{params.*}}`)
 * chain. That was only ever true by luck: `config` could already carry a token,
 * and once node `inputs` are exported too (ADR 0523) the exposure reaches
 * `inputs.to` — an email recipient. An UNDECLARED `{{params.x}}` freezes to `''`
 * and the node SUCCEEDS (ADR 0507), so shipping one with `parameters: {}` is a
 * fabrication, not an error the user would see.
 *
 * So `parameters` is now DERIVED from the tokens actually present, and the chain
 * is fully bound only when none are. The user still renames the
 * `community.local.*` placeholder before submitting.
 *
 * PII note: an instantiated workflow may have had its recipient FROZEN to a
 * literal, in which case nothing here can declare it away — the address ships
 * bare in a file the publish banner invites the user to PR to a public registry.
 * Tracked in the ADR 0523 §Open.
 */

import { serializeWithIdMap } from './serialize.js';
import type { SavedWorkflow } from './workflow.js';

interface FragmentNode {
  id: string;
  typeId: string;
  name?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  /** Pinned per-port inputs. Without this, "export chain pack" / "publish to
   *  registry" would strip what the round-trip fix just started preserving —
   *  the same defect, one surface along. */
  inputs?: Record<string, unknown>;
}
interface FragmentEdge { from: string; to: string }
interface WorkflowChain {
  chainId: string;
  version: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  dag: { nodes: FragmentNode[]; edges?: FragmentEdge[] };
}
export interface ChainPackManifest {
  name: string;
  version: string;
  kind: 'workflow-chain';
  description: string;
  engines: { openwop: string };
  chains: WorkflowChain[];
}

/** Reverse-DNS-safe slug for the `community.local.<slug>` segment, which
 *  MUST match `[a-z][a-z0-9_-]*` (start with a lowercase letter). */
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const prefixed = /^[a-z]/.test(s) ? s : `wf-${s || 'workflow'}`;
  // ADR 0525 — CAP IT. The manifest schema constrains `name` to maxLength 256,
  // and the emitted name is `community.local.<slug>` — so a 300-character
  // workflow title produced a 316-character name, i.e. a manifest that fails its
  // own schema. The user would only discover that at publish time, holding a
  // file the app told them to PR. Trim to a bound that leaves room for the
  // scope prefix, and never end on the separator.
  //
  // ADR 0766 §Correction (code-review HIGH) — 200 was right for v1 (`name`
  // maxLength 256) and wrong since exports are pinned: a pin routes the manifest
  // to the v2 schema, whose `ids.schema.json` chainId is capped at 128. The
  // chainId is `community.local.<slug>` (16 + slug), so the slug cap is 112.
  const MAX_SLUG = 112;
  return prefixed.length <= MAX_SLUG
    ? prefixed
    : prefixed.slice(0, MAX_SLUG).replace(/-+$/, '');
}

/**
 * Build the manifest. Reuses `serializeWithIdMap` for the canonical
 * node/edge shape + topological validation — so a graph with cycles,
 * orphans, or no nodes throws `SerializeError` (same as Run), and the
 * caller surfaces it.
 */
/**
 * `{{params.X}}` names actually present anywhere in the exported graph.
 *
 * The export used to hard-code `parameters: {}` and describe itself as "fully
 * bound (no {{params.*}})". That was only ever true by luck: `config` could
 * already carry a token, and once `inputs` is exported too the exposure reaches
 * `inputs.to` — an email recipient. Per ADR 0507 an EMBEDDED `{{params.x}}` with
 * no declared parameter freezes to `''` and the node SUCCEEDS, so an undeclared
 * token is a fabrication, not an error. Declaring what is present keeps the
 * manifest honest and makes the preflight surface the gap by name.
 */
function paramNamesIn(value: unknown, acc = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{\s*params\.([A-Za-z0-9_$]+)\s*\}\}/g)) acc.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) paramNamesIn(v, acc);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) paramNamesIn(v, acc);
  }
  return acc;
}

/**
 * ADR 0766 (NP-V2-8) — the export cannot pin a node type because the connected
 * host has not reported the version it runs. Thrown instead of emitting an
 * unpinned manifest: RFC 0177 §E.1 requires every chain reference to carry an
 * exact version, so an unpinned export is a file the registry — and this app's
 * own chain loader — refuses. Handing the user that file, with a banner inviting
 * them to PR it, would be the fabrication ADR 0525 exists to prevent.
 */
export class ChainExportVersionError extends Error {
  readonly typeIds: readonly string[];
  constructor(typeIds: readonly string[]) {
    super(`No installed version is known for: ${typeIds.join(', ')}`);
    this.name = 'ChainExportVersionError';
    this.typeIds = typeIds;
  }
}

/** The engine range an export declares: the v2 grammar's explicit upper bound
 *  (RFC 0177 §A.1). `^1.0.0` — what this used to write — is not in that grammar,
 *  so a v2 registry refused it at install. */
export const CHAIN_EXPORT_ENGINES = '>=1.0.0 <3.0.0';

/**
 * @param versionOf the version of a node type installed on the connected host —
 *   the builder passes the server catalog's (`catalogEntryByTypeId(t)?.version`).
 *   Injected rather than imported so this module stays a pure graph→manifest map.
 * @throws ChainExportVersionError when any node's version is unknown.
 */
export function buildChainPackManifest(
  snap: SavedWorkflow,
  versionOf: (typeId: string) => string | undefined,
): ChainPackManifest {
  const { definition, backendIdToBuilder } = serializeWithIdMap(snap);
  const builderById = new Map(snap.nodes.map((n) => [n.id, n]));

  // Resolve each type's version ONCE, so the check and the pin read one value.
  const pinned = new Map<string, string>();
  const unknownVersion: string[] = [];
  for (const typeId of new Set(definition.nodes.map((n) => n.typeId))) {
    const version = versionOf(typeId);
    if (version) pinned.set(typeId, version);
    else unknownVersion.push(typeId);
  }
  if (unknownVersion.length > 0) throw new ChainExportVersionError(unknownVersion.sort());

  const nodes: FragmentNode[] = definition.nodes.map((n) => {
    const builder = builderById.get(backendIdToBuilder[n.nodeId] ?? '');
    return {
      id: n.nodeId,
      // RFC 0177 §E.1 — an exact pin on every reference.
      typeId: `${n.typeId}@${pinned.get(n.typeId) as string}`,
      ...(builder?.name ? { name: builder.name } : {}),
      ...(builder?.position ? { position: { ...builder.position } } : {}),
      ...(n.config && Object.keys(n.config).length > 0 ? { config: n.config } : {}),
      ...(n.inputs && Object.keys(n.inputs).length > 0 ? { inputs: n.inputs } : {}),
    };
  });
  const edges: FragmentEdge[] = definition.edges.map((e) => ({ from: e.sourceNodeId, to: e.targetNodeId }));

  const slug = slugify(snap.name || 'workflow');
  // ADR 0525 §Correction (ux-review) — capping the SLUG bounded `name`/`chainId`
  // (maxLength 256) and left the TOP-LEVEL `description` (maxLength 1024)
  // unbounded, where the full label is embedded. Note what the schema does NOT
  // constrain: `$defs/WorkflowChain` puts no maxLength on `label` or
  // `description`, so the cap here is about the top-level field and about
  // layout, not about a chain-level limit — an earlier version of this comment
  // asserted a 1024 limit that does not exist. Nothing caps a workflow title in the builder,
  // so a ~950-character title reproduced the very defect the slug cap fixed: an
  // export that fails its own schema, found at publish time, holding a file the
  // app told the user to PR. Bound the label at the source instead of at one
  // call site, or the next field that embeds it inherits the bug again.
  const LABEL_MAX = 400;
  const packName = `community.local.${slug}`;
  const rawLabel = snap.name || 'Workflow';
  const label = rawLabel.length > LABEL_MAX ? `${rawLabel.slice(0, LABEL_MAX - 1)}…` : rawLabel;
  const paramNames = [...paramNamesIn(nodes)].sort();

  return {
    name: packName,
    version: '1.0.0',
    kind: 'workflow-chain',
    description: paramNames.length === 0
      ? `Workflow-chain pack exported from the OpenWOP builder: "${label}". Rename the community.local.* placeholder before publishing.`
      : `Workflow-chain pack exported from the OpenWOP builder: "${label}". Declares ${paramNames.length} parameter(s) found in the graph. Rename the community.local.* placeholder before publishing.`,
    engines: { openwop: CHAIN_EXPORT_ENGINES },
    chains: [
      {
        chainId: packName,
        version: '1.0.0',
        label,
        // BOTH branches are shown on the gallery card and the preflight modal, so
        // both address a person choosing a template. The zero-param branch used
        // to read "Builder export of X. Fully bound (no {{params.*}}) —
        // parameterize as needed." — three pieces of jargon and raw template
        // syntax, aimed at whoever wrote the exporter rather than whoever picks
        // the card.
        // Scoped to INPUTS deliberately. "Asks for nothing" would be false on the
        // preflight modal, which exists to list required connections, uninstalled
        // nodes and disabled toggles — this sentence can sit directly above
        // "Connect Gmail". And neither branch repeats `label`: the gallery card
        // already renders it as the heading immediately above, so restating it
        // was the same defect this ADR fixed elsewhere, now able to restate 400
        // characters.
        description: paramNames.length === 0
          ? 'Needs no values from you — start it and it runs.'
          : `Asks you for ${paramNames.length} value(s) when you start it: ${paramNames.join(', ')}.`,
        // Declared from the tokens actually present, never hard-coded empty —
        // an undeclared `{{params.x}}` freezes to '' and the node succeeds.
        parameters: paramNames.length === 0
          ? {}
          : {
              type: 'object',
              // REQUIRED deliberately. An unfilled param freezes to '' and the
              // node SUCCEEDS (ADR 0507), so "optional" here would reintroduce
              // the fabrication this derivation exists to prevent.
              //
              // Correction: an earlier version justified this as "better to block
              // the preflight". The preflight explicitly does NOT block on blank
              // inputs — it is `RunInputsDialog` that disables Run until required
              // inputs are answered. That dialog is where this buys anything.
              required: paramNames,
              properties: Object.fromEntries(paramNames.map((n) => [n, {
                type: 'string',
                // This string becomes the HELP TEXT under a required field in
                // the run-inputs form (`chainParamsToVariables` → RunInputsForm
                // `help`), so it must tell the user what to type — not where the
                // parameter came from.
                // HELP TEXT under a required field in the run-inputs form.
                //
                // Two corrections from the grade pass. My first rewrite dropped
                // the parameter NAME, so a five-input form showed the same
                // paragraph five times. And it promised "leaving it empty makes
                // the step run with nothing" — true on the preflight, which lets
                // blanks through, but FALSE in `RunInputsDialog`, which disables
                // Run until every required input is answered. Describing an
                // outcome the UI prevents is its own small dishonesty.
                //
                // "Required —" stays: `Field.tsx` marks the `*` `aria-hidden`, so
                // that word is the only required signal a screen reader gets
                // beyond `aria-required`.
                description: `Required — "${n}" is used each time this workflow runs.`,
              }])),
            },
        dag: { nodes, ...(edges.length > 0 ? { edges } : {}) },
      },
    ],
  };
}
