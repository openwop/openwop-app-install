/**
 * Tutorial data model (ADR 0490) — the MyndHyve tutorial system's typed-JSON
 * shape, trimmed to what this app renders. Tutorials are DATA (serializable
 * objects in `content/`), never JSX — one renderer, many walkthroughs.
 *
 * Content posture (the manual-tests precedent): the runner CHROME is
 * localized (i18n/<locale>.ts); tutorial CONTENT is authored English data —
 * localization of authored walkthroughs is a recorded follow-on.
 */

export type TutorialCategory = 'getting-started' | 'build' | 'marketing' | 'commerce';
export type TutorialDifficulty = 'beginner' | 'intermediate' | 'advanced';

/** One icon+text instruction line (supports **bold** spans). */
export interface InstructionItem {
  text: string;
}

export interface FeatureGridItem {
  label: string;
  desc: string;
}

export interface ChecklistItem {
  label: string;
}

/** Step content — a discriminated union of rendering strategies. */
export type TutorialStepContent =
  | { type: 'instructions'; items: InstructionItem[] }
  | { type: 'feature-grid'; items: FeatureGridItem[] }
  | { type: 'callout'; variant: 'info' | 'tip' | 'warning'; title: string; body: string }
  | { type: 'prose'; text: string }
  | { type: 'checklist'; items: ChecklistItem[] }
  | { type: 'code'; language?: string; code: string };

export interface TutorialStep {
  /** Badge id, e.g. "3.1" — also the progress key, so keep it stable. */
  id: string;
  title: string;
  content: TutorialStepContent[];
  /** ADR 0374 — the ORIGINAL whole-walkthrough link. **Legacy**: superseded by
   *  `run` below, which says the same thing with room for a node. Still read so
   *  a tutorial authored before ADR 0488 keeps working. */
  walkthroughId?: string;
  /**
   * ADR 0488 D1 — the narrative→spine BINDING. The narrative never contains an
   * action and the chain never contains a paragraph; this reference is the only
   * thing joining them.
   *
   * `chainId` is an RFC 0013 workflow-chain id (the walkthrough packs, or a
   * seeded sample walkthrough). `nodeId` is reserved for D2's phase sub-chains,
   * where a step points at one node of its phase's chain rather than the whole
   * thing — the player runs whole chains today, so it is carried and validated
   * but not yet dispatched on.
   *
   * Every `chainId` a shipped tutorial references is validated to RESOLVE
   * (`tutorial-binding-drift.test.ts`); a dangling one is a dead "Show me",
   * which is precisely the rot this binding exists to make impossible.
   */
  run?: { chainId: string; nodeId?: string };
}

export interface TutorialPhase {
  number: number;
  /**
   * ADR 0488 D2 — this phase's SUB-CHAIN. Running it drives just this phase,
   * which is the granularity the completion evidence argues for (3-step tours
   * complete at ~72%, 7-step at ~16%). The whole-tutorial parent chain composes
   * these via `core.subWorkflow` + `subChainRef`; see
   * `examples/workflow-chain-packs/tutorial-connect-your-ai/`.
   *
   * A phase with nothing to DO correctly has no `chainId` — the narrative and
   * the spine are separate artifacts precisely so a read-only phase is expressible.
   */
  chainId?: string;
  title: string;
  description?: string;
  /** Goal callout before the steps. */
  goal?: string;
  /** Outcome summary after the steps. */
  outcome?: string;
  steps: TutorialStep[];
}

export interface TutorialData {
  id: string;
  category: TutorialCategory;
  title: string;
  description: string;
  hero: { title: string; subtitle: string };
  goal?: string;
  learningObjectives?: string[];
  prerequisites?: string[];
  estimatedMinutes?: number;
  difficulty?: TutorialDifficulty;
  /** ADR 0488 D7 — routes this tutorial teaches. Drives the contextual
   *  "Teach me this" affordance (`TutorialHint`). Identifiers, not copy. */
  surfaces?: string[];
  phases: TutorialPhase[];
}
