/**
 * RFC 0029 §A reference implementation — four-layer PromptRef resolution
 * with a debuggable chain trace.
 *
 * Given a `(node, kind)` pair plus the four resolution contexts (the
 * bound `AgentManifest` if any, the workflow's `defaults.promptRefs`,
 * and the host's `capabilities.prompts.defaults`), this helper walks
 * the resolution chain per `spec/v1/prompts.md` §"Resolution chain
 * (normative)" and returns the winning ref + the chain[] trace that
 * the `agent.promptResolved` `RunEventDoc` payload carries.
 *
 * Layer order (per RFC 0029 §A):
 *   0. run-configurable — RunOptions.configurable.promptOverrides[kind]
 *                       (optional, NON-NORMATIVE extension; highest when
 *                       present). Opt-in: only consulted when the caller
 *                       supplies `req.runConfigurable`; a run that carries
 *                       no override map produces no chain entry, so the
 *                       normative trace is byte-identical to before.
 *   1. node           — WorkflowNode.config.{kind}PromptRef
 *   2. agent-*        — AgentManifest fields (intrinsic / overrides /
 *                       library-default). Gated on
 *                       capabilities.prompts.agentBindings: true; skipped
 *                       entirely when config.agentId is absent or
 *                       unresolved.
 *   3. workflow-defaults — WorkflowDefinition.defaults.promptRefs[kind]
 *   4. host-defaults  — capabilities.prompts.defaults[kind] (lowest)
 *
 * The `run-configurable` extension layer is optional + non-normative per
 * RFC 0029 §A. This host honors it as an opt-in: a caller that reads
 * `RunOptions.configurable.promptOverrides` passes it as
 * `req.runConfigurable`, and it takes precedence over every normative
 * layer. Absent → the layer is skipped with no trace entry (back-compat).
 */

// Mirror of the PromptKind enum from schemas/prompt-kind.schema.json.
// Kept local rather than imported from promptCompose.ts so the two
// modules stay independently usable (the resolver runs ahead of
// composition in the dispatch pipeline).
export type PromptKind = 'system' | 'user' | 'few-shot' | 'schema-hint';

export type ResolutionLayer =
  | 'run-configurable'
  | 'node'
  | 'agent-intrinsic'
  | 'agent-overrides'
  | 'agent-library-default'
  | 'workflow-defaults'
  | 'host-defaults';

export interface ChainEntry {
  layer: ResolutionLayer;
  source?: string;
  applied: boolean;
  reason?: string;
}

export interface NodeConfigInputs {
  /** The node identifier. Surfaced on the emitted payload's `nodeId`. */
  nodeId: string;
  config?: {
    systemPromptRef?: unknown;
    userPromptRef?: unknown;
    schemaHintPromptRef?: unknown;
    fewShotPromptRefs?: unknown[];
    agentId?: string;
  };
}

export interface AgentManifestInputs {
  agentId: string;
  /** RFC 0003 intrinsic surface — either inline body or tarball ref.
   *  Inline body is projected to a synthetic `prompt:agent-intrinsic:<id>`
   *  ref for the chain trace; tarball ref is projected to
   *  `prompt:<tarball-path>`. */
  systemPrompt?: string;
  systemPromptRef?: string;
  /** RFC 0029 §B per-kind preferred PromptRefs. */
  promptOverrides?: Partial<Record<PromptKind, unknown>>;
  /** RFC 0029 §B library scope for layer-2 fallback lookup. */
  promptLibraryRef?: string;
}

export interface WorkflowDefaultsInputs {
  promptRefs?: Partial<Record<PromptKind, unknown>>;
}

export interface ResolveRequest {
  kind: PromptKind;
  node: NodeConfigInputs;
  /** OPTIONAL run-configurable override map (layer 0) — the non-normative
   *  RFC 0029 §A extension, sourced from `RunOptions.configurable.promptOverrides`.
   *  When present, `[kind]` takes precedence over every normative layer. When
   *  absent (the default), the layer is skipped entirely and emits no chain
   *  entry — so runs that don't use it keep an unchanged resolution trace. */
  runConfigurable?: Partial<Record<PromptKind, unknown>>;
  agentManifest?: AgentManifestInputs;
  workflowDefaults?: WorkflowDefaultsInputs;
  hostDefaults?: Partial<Record<PromptKind, unknown>>;
  /** Whether the host advertises `capabilities.prompts.agentBindings`.
   *  When false, layer 2 is skipped entirely. */
  agentBindingsSupported?: boolean;
  /** For `kind: "few-shot"`, the entry index into
   *  `node.config.fewShotPromptRefs[]` to resolve. Defaults to 0 when
   *  unset (back-compat for callers that only handle the first
   *  exemplar). Ignored for other kinds, which read singular ref
   *  fields. */
  fewShotIndex?: number;
}

export interface ResolveResult {
  nodeId: string;
  kind: PromptKind;
  agentId?: string;
  chain: ChainEntry[];
  resolved: string | null;
}

/** Canonicalize a PromptRef value into its stringy form for chain
 *  traces. Accepts either a `prompt:...` string or a `{ templateId,
 *  version? }` object. Returns null when the input is non-conforming. */
function toStringyRef(ref: unknown): string | null {
  if (typeof ref === 'string') {
    if (ref.startsWith('prompt:')) return ref;
    // Tolerate bare templateIds during projection from AgentManifest's
    // tarball-relative path — surface them with a vendor-prefix marker
    // so the chain trace is still readable.
    return `prompt:agent-intrinsic-tarball:${ref}`;
  }
  if (ref && typeof ref === 'object') {
    const o = ref as { templateId?: unknown; version?: unknown; libraryId?: unknown };
    if (typeof o.templateId !== 'string') return null;
    const lib = typeof o.libraryId === 'string' && o.libraryId !== '' ? `${o.libraryId}.` : '';
    const ver = typeof o.version === 'string' && o.version !== '' ? `@${o.version}` : '';
    return `prompt:${lib}${o.templateId}${ver}`;
  }
  return null;
}

/** Map a PromptKind to the WorkflowNode.config field name that carries
 *  the corresponding layer-1 ref. The few-shot kind reads
 *  `fewShotPromptRefs[fewShotIndex]` (default index 0); the others
 *  read singular fields and ignore the index. */
function nodeConfigRef(
  config: NodeConfigInputs['config'] | undefined,
  kind: PromptKind,
  fewShotIndex: number,
): unknown {
  if (!config) return undefined;
  switch (kind) {
    case 'system':
      return config.systemPromptRef;
    case 'user':
      return config.userPromptRef;
    case 'schema-hint':
      return config.schemaHintPromptRef;
    case 'few-shot':
      return Array.isArray(config.fewShotPromptRefs) && fewShotIndex < config.fewShotPromptRefs.length
        ? config.fewShotPromptRefs[fewShotIndex]
        : undefined;
  }
}

/** Synthesize a PromptRef-stringy form for an agent's intrinsic
 *  system-prompt declaration. Per RFC 0029 §A, when an AgentManifest
 *  has `systemPrompt` or `systemPromptRef`, the resolver projects
 *  this into the chain trace as a synthetic ref. */
function agentIntrinsicRef(am: AgentManifestInputs): string | null {
  if (typeof am.systemPromptRef === 'string' && am.systemPromptRef !== '') {
    return `prompt:agent-intrinsic-tarball:${am.systemPromptRef}`;
  }
  if (typeof am.systemPrompt === 'string' && am.systemPrompt !== '') {
    // Synthetic — the inline body has no canonical templateId.
    return `prompt:agent-intrinsic-inline:${am.agentId}`;
  }
  return null;
}

/** Surface `RunOptions.configurable.promptOverrides` as the resolver's
 *  layer-0 map (RFC 0029 §A run-configurable extension) — but ONLY when it
 *  is a plain object. Anything else (absent / array / scalar) yields
 *  `undefined`, so `resolvePromptRef` skips the layer entirely and the
 *  resolution trace is unchanged. Callers pass the result as
 *  `ResolveRequest.runConfigurable`. */
export function promptOverridesFromConfigurable(
  configurable: Record<string, unknown> | undefined,
): Partial<Record<PromptKind, unknown>> | undefined {
  const raw = configurable?.promptOverrides;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Partial<Record<PromptKind, unknown>>)
    : undefined;
}

/**
 * Resolve a `(node, kind)` pair through the four-layer chain.
 * Returns the winning stringy ref + the full chain[] trace.
 */
export function resolvePromptRef(req: ResolveRequest): ResolveResult {
  const { kind, node, agentManifest, workflowDefaults, hostDefaults } = req;
  const chain: ChainEntry[] = [];
  let resolved: string | null = null;

  const recordApplied = (layer: ResolutionLayer, source: string): void => {
    chain.push({ layer, source, applied: true });
    resolved = source;
  };

  const recordSkipped = (layer: ResolutionLayer, source: string | undefined, reason: string): void => {
    const entry: ChainEntry = { layer, applied: false, reason };
    if (source !== undefined) entry.source = source;
    chain.push(entry);
  };

  // ── Layer 0: run-configurable (optional, non-normative RFC 0029 §A) ──
  // Only consulted when the caller opts in by supplying `runConfigurable`
  // (from RunOptions.configurable.promptOverrides). Highest precedence.
  // When the field is absent, emit NO entry — the normative chain trace is
  // byte-identical to a host that doesn't honor the extension.
  if (req.runConfigurable !== undefined) {
    const runCfgRef = toStringyRef(req.runConfigurable[kind]);
    if (runCfgRef !== null) {
      recordApplied('run-configurable', runCfgRef);
    } else {
      recordSkipped('run-configurable', undefined, 'no run-configurable override for this kind');
    }
  }

  // ── Layer 1: node config ────────────────────────────────────────
  const fewShotIndex = typeof req.fewShotIndex === 'number' && req.fewShotIndex >= 0
    ? req.fewShotIndex
    : 0;
  if (resolved === null) {
    const nodeRefRaw = nodeConfigRef(node.config, kind, fewShotIndex);
    const nodeRef = toStringyRef(nodeRefRaw);
    if (nodeRef !== null) {
      recordApplied('node', nodeRef);
    } else {
      recordSkipped('node', undefined, 'no candidate at this layer');
    }
  } else {
    recordSkipped('node', undefined, 'superseded by higher-precedence layer');
  }

  // ── Layer 2: agent binding ──────────────────────────────────────
  const agentId = node.config?.agentId;
  const agentBindingsSupported = req.agentBindingsSupported !== false;
  if (resolved === null && typeof agentId === 'string' && agentId !== '') {
    if (!agentBindingsSupported) {
      // Host doesn't advertise the capability — skip all agent-* layers.
      recordSkipped('agent-overrides', undefined, 'capabilities.prompts.agentBindings: false');
    } else if (!agentManifest || agentManifest.agentId !== agentId) {
      // Unresolved agent reference — emit one consolidated skip entry.
      // Per spec, the host SHOULD also emit a `log.appended` warning
      // with code: 'agent_binding_unresolvable' — that's a callsite
      // concern, not the resolver's job.
      recordSkipped('agent-overrides', undefined, 'agentId unresolvable');
    } else {
      // 2a — agent intrinsic (system kind only)
      if (kind === 'system') {
        const intrinsic = agentIntrinsicRef(agentManifest);
        if (intrinsic !== null) {
          recordApplied('agent-intrinsic', intrinsic);
        } else {
          recordSkipped('agent-intrinsic', undefined, 'agent has no intrinsic systemPrompt|systemPromptRef');
        }
      }
      // 2b — agent overrides
      if (resolved === null) {
        const overrideRaw = agentManifest.promptOverrides?.[kind];
        const overrideRef = toStringyRef(overrideRaw);
        if (overrideRef !== null) {
          recordApplied('agent-overrides', overrideRef);
        } else {
          recordSkipped('agent-overrides', undefined, 'no promptOverrides for this kind');
        }
      }
      // 2c — agent library default
      if (resolved === null && typeof agentManifest.promptLibraryRef === 'string' && agentManifest.promptLibraryRef !== '') {
        // The lookup convention is host policy in v1.x per
        // spec/v1/prompts.md §"Resolution chain (normative)" Layer 2.
        // This reference host advertises a deterministic-but-no-op
        // attempt: the chain entry surfaces the canonical lookup ref
        // `prompt:<libraryId>.default-<kind>` so debuggers see what
        // the resolver looked for, but the lookup itself is deferred
        // pending convention normalization in a follow-up RFC. Marked
        // applied: false; the resolver falls through to layer 3.
        // When this host's PromptStore gains library-keyed default
        // lookup (or when the spec normates a different convention),
        // this branch flips to recordApplied with the resolved ref.
        const lookupRef = `prompt:${agentManifest.promptLibraryRef}.default-${kind}`;
        recordSkipped(
          'agent-library-default',
          lookupRef,
          'agent-library-default convention not yet normated in v1.x; this reference host advertises the attempted lookup ref but defers actual resolution to a follow-up RFC. Layer falls through to workflow-defaults.',
        );
      }
    }
  } else if (resolved === null && (typeof agentId !== 'string' || agentId === '')) {
    recordSkipped('agent-overrides', undefined, 'no agentId on node config');
  }

  // ── Layer 3: workflow defaults ──────────────────────────────────
  if (resolved === null) {
    const wfRaw = workflowDefaults?.promptRefs?.[kind];
    const wfRef = toStringyRef(wfRaw);
    if (wfRef !== null) {
      recordApplied('workflow-defaults', wfRef);
    } else {
      recordSkipped('workflow-defaults', undefined, 'no candidate at this layer');
    }
  } else {
    recordSkipped('workflow-defaults', undefined, 'superseded by higher-precedence layer');
  }

  // ── Layer 4: host defaults ──────────────────────────────────────
  if (resolved === null) {
    const hostRaw = hostDefaults?.[kind];
    const hostRef = toStringyRef(hostRaw);
    if (hostRef !== null) {
      recordApplied('host-defaults', hostRef);
    } else {
      recordSkipped('host-defaults', undefined, 'no candidate at this layer');
    }
  } else {
    recordSkipped('host-defaults', undefined, 'superseded by higher-precedence layer');
  }

  const result: ResolveResult = {
    nodeId: node.nodeId,
    kind,
    chain,
    resolved,
  };
  if (typeof agentId === 'string' && agentId !== '' && agentManifest?.agentId === agentId) {
    result.agentId = agentId;
  }
  return result;
}
