# ADR 0578 — Service-desk reply composer gesture (closes SD-G4)

Status: implemented (2026-08-15) — textarea with Enter-send/Shift+Enter-newline/IME guard/auto-grow; hint ×4 locales; pinned by replyComposer.test.tsx (probes: IME guard + Shift dropped, each fired its named test).

## Problem

The agent reply composer is a single-line `<input>` with Enter-to-send
(`SupportPage.tsx:200`). Outbound customer replies are prose; a single-line
box forbids paragraphs, and pasted multi-line text collapses. R2 deferred the
fix because changing the send gesture agents have LEARNED "deserves its own
decision rather than riding along" — this is that decision.

## Research basis (bounded)

The agent-console field is unanimous on the gesture (Zendesk, Intercom,
Front — the class our R1 catalog graded against; no fresh sweep, budget
exhausted): **Enter sends, Shift+Enter inserts a newline**, in a multi-line
auto-growing composer. Chat-adjacent consoles optimize for reply THROUGHPUT
(Enter-to-send) while still permitting prose (Shift+Enter). The alternative
convention (Enter = newline, Cmd/Ctrl+Enter = send) belongs to long-form
editors, not ticket consoles.

## Decision

Replace the `<input>` with a `<textarea>` that **keeps the learned gesture**:

- **Enter sends. Shift+Enter inserts a newline.** The R2 concern (breaking
  the learned gesture) is resolved by NOT changing it — only widening what
  the box can hold.
- **Cmd/Ctrl+Enter also sends** (the belt for users trained on the editor
  convention; costs nothing).
- **IME composition guard:** Enter during active composition
  (`e.nativeEvent.isComposing` / `keyCode 229`) never sends — the classic
  CJK-input defect this class of change ships without.
- **Auto-grow 1→6 rows** (CSS `field-sizing`/measured, capped; scroll beyond),
  so the default visual stays the compact single line agents know.
- **A focus-visible hint** ("Shift+Enter for a new line") in muted microcopy,
  ×4 locales; `aria-label` unchanged.
- **Paste keeps newlines** (falls out of textarea); send trims trailing
  whitespace only — internal newlines are the point.

## Alternatives weighed

- **Enter = newline / Cmd+Enter = send:** rejected — inverts the learned
  gesture R2 explicitly protected, against the console-class convention.
- **Keep the input, add an "expand" toggle:** rejected — two composers, two
  behaviors, the drift shape.

## Test plan / sabotage

RTL: Enter sends (fn called once, value cleared); Shift+Enter does NOT send
and the value contains `\n`; Enter mid-composition does not send; Cmd+Enter
sends; pasted multi-line survives to the send payload. Sabotage: drop the
composition guard ⇒ its test fires; revert to `<input>` ⇒ the newline test
fires.

## RFC verdict

None — one component.

## Open questions (for David)

None — this is the decision R2 asked for; approve = implement as scoped.
