/**
 * Research Notebooks — the transformation TEMPLATE catalog (ADR 0084
 * Transformations T2). A small `const` configuration of reusable transformations a
 * source can be run through: each pairs a fixed `systemPrompt` (what the LLM does)
 * with the Document `kind` its output is written under.
 *
 * This is CONFIG, exactly like the T1 summarize system prompt — NOT a parallel
 * store. The OUTPUT of a transformation lands in **Documents** (the single owner of
 * stored artifacts, ADR 0053), owned by the notebook subject (`ownerSubject =
 * project:<notebookId>`). There is no "transformation store"; the catalog only names
 * the prompt + the output kind, and Documents is queried by `ownerSubject` to list
 * the results.
 *
 * Every prompt grounds ONLY in the provided source, outputs Markdown, and emits no
 * preamble — the same fail-closed discipline as the summarize prompt.
 *
 * @see docs/adr/0084-research-notebooks.md (Transformations T2)
 * @see src/features/notebooks/summarizeWorkflow.ts — the T1 system-prompt config precedent
 */

export interface NotebookTransformation {
  /** Stable catalog id (the `templateId` the route accepts). */
  id: string;
  /** Human label for the FE control + the generated Document title. */
  label: string;
  /** The fixed system prompt the LLM run is driven with. */
  systemPrompt: string;
  /** The Document `kind` the result is written under (a kebab tag). */
  docKind: string;
}

/** Markdown / grounded / no-preamble discipline shared by every transformation. */
const GROUND = 'Ground ONLY in the provided source — do not add outside knowledge. Output Markdown. No preamble, no closing remarks.';

export const NOTEBOOK_TRANSFORMATIONS: ReadonlyArray<NotebookTransformation> = [
  {
    id: 'summary',
    label: 'Summary',
    systemPrompt: `Produce a concise, structured summary of the following source. ${GROUND}`,
    docKind: 'notebook-summary',
  },
  {
    id: 'key-concepts',
    label: 'Key Concepts',
    systemPrompt: `Extract the key concepts and terms from the following source, each with a one-line definition. ${GROUND}`,
    docKind: 'notebook-key-concepts',
  },
  {
    id: 'methodology',
    label: 'Methodology',
    systemPrompt: `Describe the methods and approach used in the following source. ${GROUND}`,
    docKind: 'notebook-methodology',
  },
  {
    id: 'takeaways',
    label: 'Takeaways',
    systemPrompt: `List the actionable takeaways from the following source. ${GROUND}`,
    docKind: 'notebook-takeaways',
  },
  {
    id: 'questions',
    label: 'Open Questions',
    systemPrompt: `List the open questions the following source raises. ${GROUND}`,
    docKind: 'notebook-questions',
  },
] as const;

/** The set of Document kinds the transformation catalog produces — used to filter
 *  a notebook's owned Documents down to its transformation artifacts. */
export const NOTEBOOK_TRANSFORMATION_KINDS: ReadonlySet<string> = new Set(
  NOTEBOOK_TRANSFORMATIONS.map((t) => t.docKind),
);

/** Resolve a transformation by id, or `undefined` for an unknown id (the route
 *  turns that into a 400 — the same posture as an unknown context level). */
export function getTransformation(id: string): NotebookTransformation | undefined {
  return NOTEBOOK_TRANSFORMATIONS.find((t) => t.id === id);
}
