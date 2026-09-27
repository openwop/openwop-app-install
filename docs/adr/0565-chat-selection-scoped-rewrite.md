# ADR 0565 — Selection-scoped rewrite in the chat feed (append-only-honest)

Status: implemented (Phase 1, 2026-08-15 — SelectionRewrite.tsx + the composerSeed live lane; Phase 2 in-place replacement stays RFC-gated)
Date: 2026-08-14
Feature: chat (core, RFC 0005) — extends the ONE chat; no new toggle, no new surface
Origin: UX_UPGRADE-chat R2 gap #2 — "Gemini's standout... named as the top
round-3 candidate, agent+nodes/RFC lane; also a product call." This ADR IS the
product call put concretely: a design David can accept, amend, or decline.

## Context

Gemini's selection-scoped rewrite (highlight a span of a reply → Regenerate /
Shorter / Longer / Remove) is the one competitor interaction the R2 matrix
scored as a standout we lack. R2 assumed closing it meant partial-turn
MODIFICATION — which collides with RFC 0005 §195's append-only replayable
turn log and therefore looked wire-gated (an RFC 0021 envelope addition).

## Boundaries audit (the seam already exists)

- **`chat/composerSeed.ts`** (`stageComposerDraft`/`takeStagedComposerDraft`,
  ADR 0334 5b) — the one-shot staged-draft seam another surface uses to open
  the chat with a pre-filled composer.
- **`features/document-editor/DocumentEditorSurface.tsx:329`** — the shipped
  precedent: select text in a document → "improve this selection with AI" →
  `stageComposerDraft(t('aiImprovePrompt', { text: selected }))` → the ONE
  chat. Selection→AI is not a new interaction in this app; it just does not
  exist on the chat's own replies yet.
- **`MessageFeed.tsx`** owns assistant-message rendering (streaming, announce-
  once live region, per-message action bar) — the selection affordance mounts
  here.
- **RFC 0005 §195** — turns are an append-only replayable log; the sanctioned
  variant mechanism is the sibling-conversation fork.

## Decision (proposed)

**Phase 1 — the append-only shape (no wire, no envelope, no new tool):**
select a span inside a COMPLETED assistant message → a small floating
affordance (Rewrite / Shorter / Longer — the Gemini verb set minus Remove,
which implies in-place mutation) → compose a NEW user turn that quotes the
selected span (blockquote + a localized instruction) into the composer via
the existing seed seam — visible, editable, sent by the USER. The reply is a
new assistant turn. Properties:

- Append-only preserved — nothing is modified in place; replay/fork safety
  untouched; nothing to change in RFC 0005 or RFC 0021.
- The model sees exactly what the user sees (the quoted span + instruction —
  no hidden prompt scaffolding; the LLM-EXCHANGE honesty rules hold trivially
  because the exchange rides an ordinary user turn).
- Works with EVERY agent/provider today, embedded surfaces included, because
  it is only a composer affordance.

**Phase 2 (explicitly NOT this ADR, named for honesty):** in-place span
replacement (Gemini's actual visual) — requires a turn-mutation or variant
representation on the wire → an `../openwop` RFC first (the R2-P2 family).
Phase 1 neither blocks nor presupposes it.

## Alternatives weighed

- **Chat-time tool + RFC 0021 envelope** (R2's assumed lane) — heavier than
  the capability needs: a rewrite request originates from the USER at compose
  time, not from the model in-run; an envelope adds trust/replay machinery to
  a flow that is an ordinary turn. Rejected for Phase 1.
- **In-place mutation now** — violates RFC 0005 §195. Rejected; Phase 2 gate.
- **Do nothing** — keeps a scored standout gap that the existing seam closes
  at composer-affordance cost.

## Decisions (2026-08-15 design pass — open questions resolved; decision-ready)

1. **Verb set: Rewrite / Shorter / Longer, exactly.** The field's core trio
   (the Notion-class rewrite menu the R2 catalog cited); tone verbs
   (Formal/Casual) are the FIRST extension candidates, deferred until live
   usage shows demand — a menu is a budget, and every verb dilutes the three
   that carry the feature. "Explain" stays excluded: it is a QUESTION, and the
   selection-quote affordance already routes questions into a normal turn.
   "Remove" stays excluded (implies mutation of an immutable transcript).
2. **Assistant replies only.** Rewriting one's own message is compose-side
   editing — a different surface with different semantics (it would fork the
   turn); out of scope by decision, not omission.
3. **Desktop-first; the touch affordance ships behind the live-verify gate**
   (long-press selection UX is confirmed on-device before the menu registers
   on touch).

Residual open point: none blocking — implement on approval.

## RFC verdict

Phase 1: host UI work only — no RFC, no envelope, no capability change.
Phase 2 (if ever): new `../openwop` RFC (wire).

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | selection affordance + quoted-turn seed (×4 locales, a11y: keyboard path via message action bar, reduced-motion) + tests | not started (awaiting acceptance) |
| 2 | in-place variants | blocked on wire RFC — out of scope |
