/**
 * Agent system-prompt scaffold (host extension, non-normative).
 *
 * Wraps a chat agent's authored persona prompt with a small, STRUCTURED context
 * contract that keeps the agent in character in a shared, multi-agent thread.
 * Motivated by a live bug: addressing `@iris` after `@devon` produced a reply
 * that (a) called the human "Devon" and (b) listed Devon's capabilities — i.e.
 * the model treated the previous agent as the user AND impersonated it.
 *
 * The contract targets the three documented multi-agent persona failures
 * (conformity / confabulation / impersonation) using established techniques:
 *   - USER IDENTITY: name the human (or fall back to second-person) so the model
 *     never borrows the nearest token as the user's name.
 *   - NARRATIVE CASTING: tell the agent that earlier assistant turns prefixed
 *     with "[Name]:" were written by a DIFFERENT agent — not itself, not the
 *     user. (The chat composer prefixes cross-agent turns with exactly that.)
 *   - HANDLE DISAMBIGUATION: "@name" is an agent handle, never the user's name.
 *   - RECENCY RE-ANCHOR: the strongest identity instruction is LAST, because
 *     identity drift worsens deep in the transcript.
 *
 * Kept terse on purpose — persona PROSE alone is a weak lever; the structure +
 * the trailing re-anchor are what hold the role. Pure function so it unit-tests
 * without the executor.
 */

export interface AgentPromptScaffoldInput {
  /** The agent's persona handle name, e.g. "Iris". */
  persona: string;
  /** The agent's role title, e.g. "Chief of Staff". Optional. */
  role?: string | undefined;
  /** The agent's authored system prompt (the persona body). */
  systemPrompt: string;
  /** The human user's display name, when known. Null/empty ⇒ anonymous: the
   *  scaffold addresses them in the second person and tells the model NOT to
   *  invent a name (the failure mode we are fixing). */
  userName?: string | null | undefined;
  /** Optional pre-resolved context block (ADR 0079 Phase 5 / ADR 0080 §Follow-on)
   *  from a board-context resolver — company planning the advisors receive
   *  (strategy is the only producer today). Snapshotted onto the boardroom
   *  conversation; injected verbatim here. The block carries its own framing
   *  (advisors MAY challenge it but MUST NOT invent facts, and it never overrides
   *  the persona/safety guidance). Absent ⇒ omitted entirely. */
  injectedContextBlock?: string | null | undefined;
  /** Optional FENCED knowledge block (ADR 0084 Phase 2) — the conversation's
   *  owner-subject knowledge composed by `composeKnowledgeForSubject` (cited
   *  trusted KB/memory + BEGIN/END-fenced untrusted chunks). Distinct from
   *  `injectedContextBlock` (a board-context snapshot): this is live-retrieved
   *  per turn and carries its own trust fencing. Absent/empty ⇒ omitted. */
  knowledgeBlock?: string | null | undefined;
}

/** Compose the wrapped system prompt for a chat agent turn. */
export function composeAgentSystemPrompt(input: AgentPromptScaffoldInput): string {
  const persona = input.persona.trim();
  const who = input.role && input.role.trim().length > 0 ? `${persona}, ${input.role.trim()}` : persona;
  const name = input.userName?.trim();
  const userLine = name
    ? `- You are talking to a human user named ${name}. Address them as ${name}. ${name} is a person, never an AI agent.`
    : `- You are talking to a human user. Address them in the second person ("you"); never invent or guess a name for them.`;

  const injectedBlock = input.injectedContextBlock?.trim();
  const knowledgeBlock = input.knowledgeBlock?.trim();

  return [
    input.systemPrompt.trim(),
    ...(injectedBlock ? ['', injectedBlock] : []),
    ...(knowledgeBlock ? ['', knowledgeBlock] : []),
    '',
    'CONVERSATION CONTEXT:',
    userLine,
    '- This is a shared chat thread that may also include OTHER AI agents. Any earlier' +
      ' assistant message prefixed with "[Name]:" was written by a DIFFERENT agent — it is' +
      ' NOT your words and NOT the user\'s. Messages you wrote carry no such prefix.',
    '- A token like "@name" is the user addressing an agent by its handle. "@name" is an' +
      ' agent handle, never the user\'s name.',
    '',
    `Stay in character as ${who}. Reply only as ${persona}, and only about what ${persona} does` +
      ` — never adopt another agent's name, role, or capabilities.`,
  ].join('\n');
}
