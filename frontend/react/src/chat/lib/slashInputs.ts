/**
 * ADR 0768 follow-up B2 — the one-shot hand-off of a `/workflow` pick's
 * STRUCTURED inputs from the composer to the dispatch.
 *
 * The composer's `onSend(text)` contract carries text only, and three chat
 * surfaces implement it. Rather than widen that contract, the composer stages
 * the typed values here keyed by the workflow slug, and `runWorkflowMention`
 * takes them synchronously at its start (the `composerSeed` precedent). Keyed
 * by slug and consumed once, so a stale staging can never ride into a
 * different workflow's run.
 */
let staged: { slug: string; inputs: Record<string, unknown> } | null = null;

export function stageSlashInputs(slug: string, inputs: Record<string, unknown>): void {
  staged = Object.keys(inputs).length > 0 ? { slug, inputs } : null;
}

/** The staged inputs for THIS slug, cleared on read whichever slug asks. */
export function takeStagedSlashInputs(slug: string): Record<string, unknown> | null {
  const s = staged;
  staged = null;
  return s && s.slug === slug ? s.inputs : null;
}
