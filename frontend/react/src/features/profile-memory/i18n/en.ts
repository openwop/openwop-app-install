/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  // ADR 0666 D6 (`PKWF-8`) — this said "Private to you." and that was FALSE for the documents:
  // a personal collection is created with no subject binding, so org scope is the whole rule
  // and any workspace reader can reach it. The ACCESS RULE is a deliberate, documented
  // cross-feature decision (ADR 0042 accepts it in terms — "correct RBAC, but a slightly leaky
  // 'personal' abstraction"), so the promise is corrected and the rule left alone. Same shape as
  // ADR 0665 D3, and the same fix the agent lane took one iteration earlier (ADR 0664 D2 /
  // `AGKM-7`), whose `notesHint` stopped claiming "Private to this agent" for the same reason.
  knowledgeIntro:
    'Attach <0>documents</0> to your profile — sources your digital twin can draw on, alongside the facts in your Memory tab.',
  // The audience disclosure, at the CREATE door — the lesson ADR 0664 D2 paid for: it put the
  // string where the grant actually happens, because the bind-existing control has no importer
  // and copy there would have been shown to nobody.
  knowledgeAudience:
    'Documents live in your workspace, not in a private store: anyone who can read that workspace can open them. Your Memory notes below are different — those stay yours.',
  knowledgeEmptyBody: 'Create a source above, then add documents your twin can cite.',
  knowledgeSearchTitle: 'Search your knowledge',
  knowledgeSearchPlaceholder: 'What would your twin recall?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  // ADR 0666 D6 — "private to you" is TRUE of these notes (the routes are self-only by
  // construction — no endpoint accepts a subject id) but it was silent about the one way they
  // leave: a twin grant the person issues themselves. The twin tab carries the full disclosure;
  // this is the tab where the data is CREATED, so it now points there instead of implying the
  // notes can never be read by an agent.
  memoryIntro:
    'Train your profile with personal memories — facts, preferences, and context about how you work. Over time this becomes a <0>digital twin</0> of you. Durable and yours alone, unless you grant an agent permission to recall them.',
  memoryAddPlaceholder: 'I prefer async updates over meetings; my focus hours are 9–11am.',
  memoryEmptyBody: 'Start training your twin: add a fact or preference about how you work.',

  // Auto-extraction consent (ADR 0120)
  consentLabel: 'Automatically learn durable facts from my chats',
  consentHint: 'When on, your assistant may save lasting facts it learns during chats. Learned facts are listed below, marked “Auto-learned”, and you can delete them. Turning this OFF stops future learning — it does not delete what was already learned. Off by default.',
  erasureScopeNote: 'Deleting your account data removes your personal memory. It does not reach what a shared workspace agent remembers from your conversations with it — that recall belongs to the workspace. Ask a workspace admin to clear an agent’s memory from its Memory tab.',
  consentError: 'Could not update the memory-learning setting.',
  consentLoadFailed: 'Could not read whether memory-learning is on. It may be ON — this is not confirmation that it is off.',
  consentRetry: 'Try again',
} as const;
