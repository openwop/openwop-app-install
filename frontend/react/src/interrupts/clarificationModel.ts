/**
 * ADR 1001 D8 — the ONE reader of a multi-question clarification interrupt
 * (`ClarificationData.questions[]`, RFC 0021 / interrupt.md) for every card that
 * shows one: the run page and inbox (`ClarificationDialog`), the chat feed's run
 * card, and the chat `ask-user` card.
 *
 * The host already lifted the model's ask onto a closed vocabulary
 * (`backend/.../host/clarificationLift.ts`): free text, one of a list of choices,
 * or yes/no. This parser re-applies the same bounds and fails CLOSED to `null`
 * on anything else, so a malformed or hostile payload falls back to the legacy
 * single-question card instead of rendering an unbounded form. It never returns
 * markup: every string is rendered as a React text node.
 */

/** The interrupt-data profile of an agent's ask (host `AGENT_CLARIFICATION_PROFILE`). */
export const AGENT_CLARIFICATION_PROFILE = 'openwop-agent-clarification';

export const CLARIFY_UI_LIMITS = { maxQuestions: 5, maxQuestionChars: 500, maxChoices: 8, maxChoiceChars: 120, maxTextChars: 2000 } as const;

export type ClarifyControl =
  | { kind: 'text'; maxLength: number }
  | { kind: 'choice'; choices: string[] }
  | { kind: 'boolean' };

export interface ClarifyQuestion {
  id: string;
  question: string;
  control: ClarifyControl;
}

export interface AgentClarification {
  questions: ClarifyQuestion[];
  /** The asking agent's display name, when the host stamped one. */
  askedBy?: string;
}

/** A value per question id; `undefined` = not answered yet. */
export type ClarifyValues = Record<string, string | boolean | undefined>;

function controlOf(schema: unknown): ClarifyControl | null {
  if (schema === undefined) return { kind: 'text', maxLength: CLARIFY_UI_LIMITS.maxTextChars };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as { type?: unknown; enum?: unknown; maxLength?: unknown };
  if (s.type === 'boolean') return { kind: 'boolean' };
  if (s.type !== 'string') return null;
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length < 2 || s.enum.length > CLARIFY_UI_LIMITS.maxChoices) return null;
    if (!s.enum.every((c) => typeof c === 'string' && c.length > 0 && c.length <= CLARIFY_UI_LIMITS.maxChoiceChars)) return null;
    return { kind: 'choice', choices: s.enum as string[] };
  }
  const max = typeof s.maxLength === 'number' && Number.isInteger(s.maxLength) && s.maxLength > 0
    ? Math.min(s.maxLength, CLARIFY_UI_LIMITS.maxTextChars)
    : CLARIFY_UI_LIMITS.maxTextChars;
  return { kind: 'text', maxLength: max };
}

/** `null` = not a multi-question clarification (render the legacy card). */
export function parseAgentClarification(data: unknown): AgentClarification | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as { questions?: unknown; askedBy?: unknown; profile?: unknown };
  // Only the host's agent ask: another producer's `questions[]` clarification
  // has its own resume shape, so it keeps the legacy card.
  if (d.profile !== AGENT_CLARIFICATION_PROFILE) return null;
  if (!Array.isArray(d.questions) || d.questions.length === 0 || d.questions.length > CLARIFY_UI_LIMITS.maxQuestions) return null;
  const out: ClarifyQuestion[] = [];
  const seen = new Set<string>();
  for (const raw of d.questions) {
    if (!raw || typeof raw !== 'object') return null;
    const q = raw as { id?: unknown; question?: unknown; schema?: unknown };
    if (typeof q.id !== 'string' || !q.id || seen.has(q.id)) return null;
    if (typeof q.question !== 'string' || !q.question || q.question.length > CLARIFY_UI_LIMITS.maxQuestionChars) return null;
    const control = controlOf(q.schema);
    if (!control) return null;
    seen.add(q.id);
    out.push({ id: q.id, question: q.question, control });
  }
  const askedBy = typeof d.askedBy === 'string' && d.askedBy.trim() ? d.askedBy.trim().slice(0, 80) : undefined;
  return { questions: out, ...(askedBy ? { askedBy } : {}) };
}

/** The resume value (`ClarificationResume`), or `null` while any question is
 *  unanswered or out of bounds. Order and ids follow the questions exactly —
 *  the host's generated `resumeSchema` refuses anything else. */
export function buildClarificationAnswers(questions: readonly ClarifyQuestion[], values: ClarifyValues): { answers: Array<{ id: string; answer: string | boolean }> } | null {
  const answers: Array<{ id: string; answer: string | boolean }> = [];
  for (const q of questions) {
    const v = values[q.id];
    if (q.control.kind === 'boolean') {
      if (typeof v !== 'boolean') return null;
      answers.push({ id: q.id, answer: v });
    } else if (q.control.kind === 'choice') {
      if (typeof v !== 'string' || !q.control.choices.includes(v)) return null;
      answers.push({ id: q.id, answer: v });
    } else {
      // Code points, as the host's JSON Schema `maxLength` counts them.
      if (typeof v !== 'string' || !v.trim() || [...v].length > q.control.maxLength) return null;
      answers.push({ id: q.id, answer: v });
    }
  }
  return { answers };
}

/** A Skip: the spec's `ClarificationResume` with no answers (the host's expiry
 *  sends the same). */
export const CLARIFICATION_SKIP = { answers: [] } as const;

/** The chat lane's answer turn as the person sees it (ADR 1001 D7): one line
 *  per answered question, the same text the host persists for that turn, so the
 *  optimistic bubble matches the hydrated one. `skipText` is the localized
 *  Skip line. */
export function clarificationAnswerSummary(data: unknown, answers: unknown, skipText: string): string {
  // The chat ask's data carries no profile (the feed adds it to render the card).
  const ask = data && typeof data === 'object' && !Array.isArray(data) ? parseAgentClarification({ ...data, profile: AGENT_CLARIFICATION_PROFILE }) : null;
  if (!ask || !Array.isArray(answers) || answers.length === 0) return skipText;
  const byId = new Map<string, unknown>();
  for (const a of answers) if (a && typeof a === 'object' && 'id' in a && typeof a.id === 'string') byId.set(a.id, 'answer' in a ? a.answer : undefined);
  const lines: string[] = [];
  for (const q of ask.questions) {
    const v = byId.get(q.id);
    if (typeof v === 'boolean') lines.push(`${q.question} ${v ? 'yes' : 'no'}`);
    else if (typeof v === 'string') lines.push(`${q.question} ${v}`);
  }
  return lines.length > 0 ? lines.join('\n') : skipText;
}
