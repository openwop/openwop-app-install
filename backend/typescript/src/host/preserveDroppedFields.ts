/**
 * ADR 0524 — the SERVER-SIDE half of "a save must not lose authored content".
 *
 * ADR 0523 stopped the builder deleting node `inputs` on every save, but that
 * fix is client-side. Two lanes never self-heal on their own: the runs index and
 * the chat `@workflow` mention serialize from **localStorage**, so a record
 * written by an older bundle keeps stripping the head even on the corrected
 * bundle — the staleness is in browser storage, not in the JS. A workflow the
 * user only ever RUNS is never healed. So the window does not close on a
 * calendar; it closes on a measured zero.
 *
 * WHY MERGE AND NOT REFUSE. `routes/workflows.ts` already ruled on this exact
 * question for the removed-node guard (ADR 0440 P2): a refusal here is *"an
 * unsatisfiable 409 arriving 1.5s after a keystroke, via an autosave the user
 * never triggered."* Refusal also inverts the harm — an old-bundle user would
 * lose everything typed since their last successful save (remedy: a hard refresh
 * the error cannot perform) instead of one field. Merging restores fields the
 * ingest contract already accepts (`workflowDefinitionValidation` models
 * `inputs`, `variables` and `configurableSchema`), so it is not the
 * carry-verbatim anti-pattern ADR 0523 rejected: nothing is promised that the
 * server does not honour.
 *
 * WHY THE MERGE IS DISCRIMINATED, NOT UNCONDITIONAL. An unconditional merge makes
 * DELETION IMPOSSIBLE. That is harmless only while nothing can delete a preset
 * input — the Inspector section is deliberately read-only today — and becomes a
 * silent resurrection bug the day editable preset inputs ship. So the merge fires
 * only on WHOLE-SET omission: the incoming definition carries the field on zero
 * nodes while the prior head carried it on at least one. An old bundle zeroes all
 * of them at once; a user deleting one input leaves the others intact. That is a
 * bundle-capability signal rather than a content signal, so it stays correct after
 * editing ships.
 *
 * NOT SILENT. Every merge returns a `preservedFields` disclosure, logs, and
 * increments a counter. A merge nobody can see would be this repo's dominant
 * defect family (silent success) wearing the costume of a fix.
 */
import { createLogger } from '../observability/logger.js';
import type { WorkflowDefinition } from '../executor/types.js';

const log = createLogger('preserve-dropped-fields');

/**
 * Fields this guard restores. Each is accepted and persisted by
 * `validateWorkflowDefinition`, so restoring one is never a false promise.
 *
 * ADR 0595 widened the set from three to five. The original three were derived
 * from what the pre-ADR-0523 BUILDER bundle dropped. The AI workflow author is a
 * second, *provable* dropper — its structured-output schema
 * (`packs/feature.workflow-author.nodes/index.mjs` `RESPONSE_SCHEMA`) cannot
 * express `settings` or node `compensation` AT ALL.
 *
 * §CORRECTION (ADR 0595 §Correction 1, measured). This block first said the
 * builder's own `SavedWorkflow` "models neither" either. That is true of
 * `settings` (no occurrence anywhere in `builder/schema/`) and FALSE of
 * `compensation`, which the builder carries VERBATIM in both directions
 * (`workflow.ts` `compensation?: Record<string, unknown>`, `serialize.ts`
 * "emit the inverse action back", `deserialize.ts`) precisely because dropping
 * it was found three times. So on a CURRENT builder bundle an absent
 * `compensation` is not a capability signal; the population it is a signal for
 * is a pre-fix bundle, a localStorage-sourced `SavedWorkflow` written by one,
 * and the AI author. Read the code, not the sentence.
 *
 * `compensation` is the one with teeth: RFC 0151 §B is the node's INVERSE
 * action, and `workflowDefinitionValidation.ts` already records that dropping it
 * makes an unwind "report a clean `none` for a run that committed real effects".
 *
 * ── THE EXIT `compensation` NEEDS, AND WHY IT IS NOT OPTIONAL ───────────────
 *
 * The discriminated merge below is safe only because "explicitly cleared" is
 * REPRESENTABLE: `inputs:{}`, `variables:[]`, `configurableSchema:{}` and
 * `settings:{}` all validate, so `carries()` stands down and a deletion is
 * honoured. `compensation` has NO such form. RFC 0151 §B is a CLOSED block with
 * `nodeTypeId` REQUIRED, so `compensation:{}` is a 400, and `compensation:null`
 * is normalized to `undefined` by `validateNodeCompensation` — byte-identical to
 * omission by the time this helper sees it. Widening the set WITHOUT an exit
 * therefore made a node's inverse action permanently UNDELETABLE: verbatim the
 * forbidden state the header comment above names ("an unconditional merge makes
 * DELETION IMPOSSIBLE"), reached by a discriminator that can never discriminate.
 *
 * So the field is preserved AND the declaration is reachable from every lane
 * that can intend a deletion: the REST lane declares via
 * `x-openwop-field-contract`; the AI-author lane declares via `clearFields` on
 * `openwop:feature.workflow-author.nodes.persist` (ADR 0595 §Correction 1),
 * which parses through `parseFieldContract` below so the two can never drift.
 * The builder and the collab lane have NO compensation editor, so they cannot
 * intend a clear and need no exit — that is a statement about their UI, and it
 * stops being true the day a compensation editor ships, at which point the
 * builder must ADD `compensation` to `BUILDER_FIELD_CONTRACT` in the same PR.
 *
 * TWO fields are deliberately NOT here, on mechanism rather than effort:
 *  - `metadata` — the author lane WRITES it (the `draft` node stamps
 *    `metadata.authoring`, and ADR 0595 stamps `metadata.lifecycle`
 *    server-side), so it is never a whole-set omission, and a wholesale restore
 *    would fight both stampers.
 *  - edge `condition` — there is no stable key to restore onto. Node `inputs`
 *    re-attach by surviving `nodeId`; edge ids are regenerated per authoring
 *    pass (`e1`, `e2`, …), so a re-keyed restore is exactly the
 *    stale-attachment hazard ADR 0523 §Q3 names. Recorded as a residual, not
 *    silently omitted.
 */
export type PreservableField = 'inputs' | 'variables' | 'configurableSchema' | 'settings' | 'compensation';

export interface PreserveResult {
  /** The definition to persist — `next` unchanged when nothing was restored. */
  definition: WorkflowDefinition;
  /** Fields restored from the prior head. Empty when the save was lossless. */
  preserved: PreservableField[];
}

/** A node-level field the whole-set discriminator applies to. Both members are
 *  optional on `WorkflowNode` and both are re-attached by SURVIVING `nodeId`. */
type NodeField = 'inputs' | 'compensation';

type NodeLike = WorkflowDefinition['nodes'][number] & Record<string, unknown>;

/**
 * "Carries" = present and non-empty. An empty `{}` is not a declaration, and
 * counting it would make the discriminator fire on a definition that declares
 * nothing — the vacuity that turns a guard into a resurrector.
 *
 * **Do NOT add a `typeof v === 'object'` narrowing here.** It looks like an
 * obvious hardening and it is a DIVERGENCE: `Object.keys('abc')` has length 3,
 * so the guard counts a truthy non-object and the narrowed form does not. The
 * measurement script diverged from the guard in exactly this way once already,
 * and `test/measure-stripped-workflow-inputs.test.ts` carries a value-matrix
 * parity table (§Correction, "the case that caught the divergence") precisely so
 * the next person cannot do it silently. It caught this refactor too. The
 * leading `!!v` is what keeps `Object.keys(null)` from throwing.
 */
const carries = (node: NodeLike, field: NodeField): boolean => {
  const v = node[field];
  return !!v && Object.keys(v as object).length > 0;
};

const nodesCarrying = (def: WorkflowDefinition, field: NodeField): number =>
  (def.nodes ?? []).filter((n) => carries(n as NodeLike, field)).length;

/**
 * ONE node-field restorer, called once per member of `NodeField`.
 *
 * Hoisted deliberately: the previous shape hand-wrote the whole-set test, the
 * prior-by-id map, and the surviving-node re-attach for `inputs` alone, and the
 * repo's dominant fix-defect is "N hand-written copies, two of them half-right".
 * A second field must not mean a second copy of the iteration.
 *
 * Returns `null` when nothing was restored, so the caller can keep the
 * `preserved` list honest.
 */
function restoreNodeField(
  next: WorkflowDefinition,
  previous: WorkflowDefinition,
  field: NodeField,
): WorkflowDefinition | null {
  if (nodesCarrying(previous, field) === 0) return null;      // nothing to restore
  if (nodesCarrying(next, field) > 0) return null;            // partial ⇒ an author edit
  const priorById = new Map(
    (previous.nodes ?? [])
      .filter((n) => carries(n as NodeLike, field))
      .map((n) => [n.nodeId, (n as NodeLike)[field]] as const),
  );
  // Restore ONLY onto nodes that still exist under the same id. A node the user
  // deleted must stay deleted; a node they added must not inherit anything.
  // Re-keying by anything other than the surviving id would be the
  // stale-attachment hazard ADR 0523 §Q3 names.
  const merged = (next.nodes ?? []).map((n) => {
    const prior = priorById.get(n.nodeId);
    return prior ? { ...n, [field]: prior } : n;
  });
  if (!merged.some((n, i) => n !== (next.nodes ?? [])[i])) return null;
  return { ...next, nodes: merged };
}

/**
 * Restore fields an incoming definition dropped wholesale relative to the head
 * it replaces. Pure: no I/O, no clock — the caller supplies `previous`, which
 * both write lanes already read for their own reasons.
 *
 * `previous === null` (a first write, or a caller that does not own the row)
 * means there is nothing to compare against, so nothing is restored.
 */
export function preserveDroppedFields(
  next: WorkflowDefinition,
  previous: WorkflowDefinition | null,
  /**
   * ADR 0524 Phase E0 — the fields the CLIENT declares it models, parsed from
   * the `x-openwop-field-contract` request header.
   *
   * The whole-set discriminator is a HEURISTIC: it infers "this bundle cannot
   * serialize the field" from "the field is absent everywhere". That inference
   * has one real false positive — a workflow with exactly ONE input-carrying
   * node whose input the user clears IS a whole-set omission, and would be
   * resurrected. Unreachable while the preset-inputs section is read-only, and
   * reachable the day editable inputs ship. "Workflows with exactly one
   * input-carrying node" is not a corner case.
   *
   * A declaration replaces the inference with a fact: a client that says it
   * models `inputs` and sends none is DELETING them, so nothing is restored.
   *
   * `undefined` means the client said nothing — an old bundle, or the collab
   * lane, which has no request to carry a header. Those keep the heuristic,
   * which is the entire population the guard exists for.
   *
   * TRUST: a client that lies only affects a workflow it already owns and is
   * already sending the full content of. This adds no authority a caller did
   * not have — it cannot widen access, only decline a repair of its own row.
   */
  declaredFields?: ReadonlySet<PreservableField>,
): PreserveResult {
  if (!previous) return { definition: next, preserved: [] };

  const models = (f: PreservableField): boolean => declaredFields?.has(f) === true;

  const preserved: PreservableField[] = [];
  let definition = next;

  // Node-level fields — whole-set omission only, and only when the client has
  // NOT declared that it models them. ONE loop over the shared restorer.
  const beforeCount = nodesCarrying(previous, 'inputs');
  for (const field of ['inputs', 'compensation'] as const) {
    if (models(field)) continue;
    const restored = restoreNodeField(definition, previous, field);
    if (restored) {
      definition = restored;
      preserved.push(field);
    }
  }

  // COHERENCE (grade-code): the three restorations were independently gated, so
  // a client that models `variables` (sends an explicit `[]`) but NOT node
  // `inputs` got restored inputs carrying `{type:'variable'}` refs while the
  // declarations stayed cleared — refs resolving against an empty bag, which is
  // verbatim the failure `SavedWorkflow.variables`' own docblock says must never
  // happen, and incoherent in a way NEITHER endpoint was. If restoring inputs
  // reintroduces a ref the surviving declarations do not cover, the declarations
  // come back with them: the pair moves together or not at all.
  const declaredNames = (vars: unknown): Set<string> =>
    new Set(
      (Array.isArray(vars) ? vars : [])
        .map((v) => (v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === 'string'),
    );
  const refNamesIn = (value: unknown, acc = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) { for (const v of value) refNamesIn(v, acc); }
    else if (value && typeof value === 'object') {
      const v = value as { type?: unknown; variableName?: unknown };
      if (v.type === 'variable' && typeof v.variableName === 'string') acc.add(v.variableName);
      for (const inner of Object.values(value)) refNamesIn(inner, acc);
    }
    return acc;
  };
  if (!models('variables') && preserved.includes('inputs') && previous.variables !== undefined && next.variables !== undefined) {
    const declared = declaredNames(next.variables);
    const needed = refNamesIn((definition.nodes ?? []).map((n) => n.inputs));
    const dangling = [...needed].filter((n) => !declared.has(n));
    if (dangling.length > 0) {
      definition = { ...definition, variables: previous.variables };
      preserved.push('variables');
      log.warn('workflow_save_restored_variables_for_coherence', {
        workflowId: next.workflowId, dangling,
        hint: 'restored inputs referenced variables the incoming definition had cleared — refs without declarations resolve to undefined',
      });
    }
  }

  // Def-level companions. Absent entirely (not emptied) is the bundle signal —
  // an explicit `[]`/`{}` is an author clearing them and must be honoured.
  //
  // A declared field is exempt here too: a client that models `variables` and
  // omits them entirely is clearing them. (Note the asymmetry is deliberate —
  // for the def-level fields ABSENT is the bundle signal and `[]` is already an
  // explicit clear, so the declaration only settles the absent case.)
  if (!models('variables') && previous.variables !== undefined && next.variables === undefined) {
    definition = { ...definition, variables: previous.variables };
    preserved.push('variables');
  }
  if (!models('configurableSchema') && previous.configurableSchema !== undefined && next.configurableSchema === undefined) {
    definition = { ...definition, configurableSchema: previous.configurableSchema };
    preserved.push('configurableSchema');
  }
  // ADR 0595 — `settings` joins the def-level companions on the same rule.
  // Neither the builder's `SavedWorkflow` nor the AI author's response schema
  // models it, so an absent `settings` is a bundle signal on every live lane.
  if (!models('settings') && previous.settings !== undefined && next.settings === undefined) {
    definition = { ...definition, settings: previous.settings };
    preserved.push('settings');
  }

  // ── `M3` (ADR 0603 R1) — the THIRD metadata lane ───────────────────────────
  //
  // `parseWorkflowDefinition` replaces `metadata` WHOLESALE from the request
  // body, and both writers are exposed: the REST save (`routes/workflows.ts`) and
  // the collab derive (`workflowCollabResource.ts`, a `JSON.parse` of a client
  // blob). Today that is mitigated CLIENT-SIDE ONLY — the builder's serializer
  // emits no metadata and all five POST sites re-compose it — which is not a
  // guarantee, and this exact class already fired once (ADR 0440 P1, the same
  // keys). §2.2 of this ADR is the same family one lane over.
  //
  // The prescription reviewed was "add `metadata` to PRESERVABLE_FIELDS", and it
  // is REFUSED — the docblock at the top of this file already records why, on
  // mechanism: the author lane WRITES metadata (`metadata.authoring` from the
  // draft node, `metadata.lifecycle` from ADR 0595), so a wholesale restore would
  // fight both stampers and resurrect provenance an author had legitimately
  // replaced. That reasoning stands and is not weakened here.
  //
  // What IS restored is a closed set of HOST-DERIVED keys. No client authors
  // them — they are minted by `expandChain` / `buildChainBackedDefinition` /
  // `promptStore` — so "absent from the incoming body" can only mean the writer
  // did not model them, never that someone cleared them. That makes the rule a
  // fact rather than the whole-set HEURISTIC the fields above use, which is why
  // it needs no client contract and takes no `models()` exemption: a client
  // cannot declare it models a field it must never write.
  //
  // Each key has a live reader, so a drop is a real regression and not a tidiness
  // concern: `deferredParameterAliases` → `variablesRuntime` + the RFC 0124
  // sensitive-param guard in `routes/runs.ts`; `expansionMode` → the migration-14
  // skip predicate in `seedWorkflows.ts`; `expandedFrom` → re-expansion in
  // `workflowChainPackLoader`; `mintedPromptTemplates` → `promptStore`;
  // `chainId` → `features/assistant/chainBackedShape.ts`.
  const prevMeta = previous.metadata;
  if (prevMeta && typeof prevMeta === 'object') {
    const nextMeta = (definition.metadata ?? {}) as Record<string, unknown>;
    const restoredKeys: string[] = [];
    for (const key of HOST_DERIVED_METADATA_KEYS) {
      if (nextMeta[key] !== undefined) continue;                 // the writer modelled it
      const prior = (prevMeta as Record<string, unknown>)[key];
      if (prior === undefined) continue;                          // nothing to restore
      restoredKeys.push(key);
    }
    if (restoredKeys.length > 0) {
      const merged: Record<string, unknown> = { ...nextMeta };
      for (const key of restoredKeys) merged[key] = (prevMeta as Record<string, unknown>)[key];
      definition = { ...definition, metadata: merged };
      log.warn('workflow_save_restored_host_metadata', {
        workflowId: next.workflowId,
        restoredKeys,
        hint: 'a writer replaced `metadata` wholesale and dropped host-derived chain provenance — these keys are minted by the host and never authored by a client',
      });
    }
  }

  if (preserved.length > 0) {
    log.warn('workflow_save_dropped_fields_restored', {
      workflowId: next.workflowId,
      preserved,
      nodesWithInputsBefore: beforeCount,
      // The lane is not knowable here; the caller tags it.
      hint: 'a client serialized a definition without fields the prior head carried — likely a pre-ADR-0523 bundle or a localStorage-sourced register',
    });
  }

  return { definition, preserved };
}

/** The request header a client uses to declare which fields it models. */
export const FIELD_CONTRACT_HEADER = 'x-openwop-field-contract';

/**
 * The closed set, EXPORTED as the SSoT for every surface that has to name these
 * fields to someone else (ADR 0595 §Correction 1).
 *
 * `PreservableField` is a type: it vanishes at runtime, so a JSON Schema `enum`
 * or a tool-input `enum` cannot be derived from it and has to be written out.
 * Every such copy is a drift site, and CLAUDE.md's rule is explicit — schema
 * text reaching a model is generated from its SSoT or test-pinned to it. The
 * `clearFields` enum on `…nodes.persist` imports this array; the pack's
 * `persist.output.schema.json` cannot import anything, so it is test-pinned
 * against this array instead.
 */
export const PRESERVABLE_FIELDS: readonly PreservableField[] = ['inputs', 'variables', 'configurableSchema', 'settings', 'compensation'];

/**
 * `M3` (ADR 0603 R1) — the closed set of `metadata` keys the HOST derives and no
 * client ever authors, restored key-by-key when an incoming definition replaced
 * `metadata` wholesale without them.
 *
 * Deliberately NOT `PreservableField`s. Those use a whole-set omission HEURISTIC
 * and honour a client field contract, because a client legitimately writes them.
 * These are the opposite: they are minted by `expandChain` /
 * `buildChainBackedDefinition` / `promptStore`, so their absence can only ever
 * mean "the writer did not model them". Keeping the two mechanisms separate is
 * what lets `metadata` stay OFF `PRESERVABLE_FIELDS` — a wholesale metadata
 * restore would fight the `metadata.authoring` and `metadata.lifecycle` stampers,
 * which is exactly why the docblock above rules it out.
 *
 * Adding a key here is a claim that NOTHING a client sends may author it. Check
 * that before extending. (`kind`/`feature` are NOT here: `PODWF-2` is sequenced
 * for the closeout — see ADR 0603 §8.)
 */
export const HOST_DERIVED_METADATA_KEYS: readonly string[] = [
  'chainId',
  'expansionMode',
  'expandedFrom',
  'mintedPromptTemplates',
  'deferredParameterAliases',
];

const PRESERVABLE = PRESERVABLE_FIELDS;

/**
 * Parse the `x-openwop-field-contract` header into a closed set.
 *
 * CLOSED-WORLD, but be honest about what that buys. An unrecognised token is
 * dropped. That is NOT a guard against a client disabling protection it was not
 * granted — `models(f)` tests for an exact field name, so a junk token is inert
 * whether it is stored or dropped. (I claimed otherwise in the first draft; a
 * sabotage probe showed the route behaves identically either way, so the test
 * asserting it was vacuous.)
 *
 * What it actually buys is FORWARD COMPATIBILITY. The day a fourth field joins
 * `PreservableField`, an old client that had been sending that name
 * speculatively would suddenly be declaring a contract it never implemented, and
 * would start deleting a field the guard used to protect. Dropping unknown
 * tokens at parse time means a declaration only ever counts once the server has
 * agreed to honour it.
 *
 * Returns `undefined` for a missing/blank/entirely-unrecognised header, which is
 * the "client said nothing" case the guard treats as an old bundle. That is the
 * SAFE default: it keeps the repair, and the population this guard exists for is
 * exactly the clients that cannot send this header.
 */
export function parseFieldContract(raw: unknown): ReadonlySet<PreservableField> | undefined {
  // Express gives a string, or an array when the header repeats.
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  if (!text.trim()) return undefined;
  const declared = new Set<PreservableField>();
  for (const token of text.split(',')) {
    const name = token.trim();
    const match = PRESERVABLE.find((f) => f === name);
    if (match) declared.add(match);
  }
  return declared.size > 0 ? declared : undefined;
}
