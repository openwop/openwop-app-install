/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Attach <0>documents</0> to your profile — cited sources your digital twin can draw on, alongside the facts in your Memory tab. Private to you.',
  knowledgeEmptyBody: 'Create a source above, then add documents your twin can cite.',
  knowledgeSearchTitle: 'Search your knowledge',
  knowledgeSearchPlaceholder: 'What would your twin recall?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Train your profile with personal memories — facts, preferences, and context about how you work. Over time this becomes a <0>digital twin</0> of you. Durable and private to you.',
  memoryAddPlaceholder: 'I prefer async updates over meetings; my focus hours are 9–11am.',
  memoryEmptyBody: 'Start training your twin: add a fact or preference about how you work.',

  // Auto-extraction consent (ADR 0120)
  consentLabel: 'Automatically learn durable facts from my chats',
  consentHint: 'When on, your assistant may save lasting facts it learns during chats as memories below — which you can review and delete anytime. Off by default.',
  consentError: 'Could not update the memory-learning setting.',
} as const;
