/**
 * ADR 0524 Phase E0 — the client field-contract marker.
 *
 * The server's ADR 0524 guard restores node `inputs` (and `variables` /
 * `configurableSchema`) when a save omits them ENTIRELY, inferring "this bundle
 * cannot serialize the field" from "the field is absent everywhere". That
 * inference has a real false positive: a workflow with exactly ONE
 * input-carrying node whose input the user clears IS a whole-set omission, and
 * would be resurrected. Harmless while preset inputs are read-only; a
 * silent-resurrection bug the day they become editable.
 *
 * This header replaces the inference with a fact. A client that declares it
 * models a field is telling the server that an omission is a DELETION.
 *
 * ── THE RULE THAT IS EASY TO GET WRONG ─────────────────────────────────────
 * **The contract describes the SOURCE, not the serializer.**
 *
 * Every lane in this bundle shares one corrected `serializeWorkflow`, so it is
 * tempting to send this header from all of them. That would be wrong, and
 * actively harmful. The runs index and the chat `@workflow` mention serialize
 * from **localStorage**, and a `SavedWorkflow` written by a pre-ADR-0523 bundle
 * carries no node `inputs` at all. A correct serializer faithfully emits the
 * nothing that is there — so declaring "I model inputs" from those lanes would
 * tell the server to treat stale, lossy data as an intentional deletion and
 * **delete the head's inputs**. That is precisely the harm ADR 0524 exists to
 * prevent, re-introduced through the mechanism meant to make it unnecessary.
 *
 * So: only a lane whose SOURCE OF TRUTH models these fields may declare them.
 * Today that is the builder store alone.
 */

/** Must match `FIELD_CONTRACT_HEADER` in `host/preserveDroppedFields.ts`. */
export const FIELD_CONTRACT_HEADER = 'x-openwop-field-contract';

/**
 * The fields the BUILDER STORE models. Kept as an explicit list rather than
 * derived from a type: a field silently joining this header would tell the
 * server to stop protecting it, so growing this list must be a deliberate edit
 * with a test, not a side effect of widening a type elsewhere.
 */
export const BUILDER_FIELD_CONTRACT = ['inputs', 'variables', 'configurableSchema'] as const;

/** Header pair for a lane whose source of truth models the fields above. */
export function fieldContractHeader(): Record<string, string> {
  return { [FIELD_CONTRACT_HEADER]: BUILDER_FIELD_CONTRACT.join(',') };
}
