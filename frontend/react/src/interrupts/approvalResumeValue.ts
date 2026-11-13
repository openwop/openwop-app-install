/**
 * ADR 1058 PR-B / RFC 0183 §A.2 — the ONE resume value an approval card sends.
 *
 * A `refine` resolution MUST carry `refineFeedback` (`{ scope, text? }`): the
 * host refuses a refine without it, and a declared refine loopback (RFC 0258)
 * hands that feedback to the re-entered producer. Both approval cards (the chat
 * card and the run-detail twin) used to send `{ action, comment }` only, so
 * clicking Refine on a refine-capable gate was always a 400. The free-text
 * comment becomes the feedback's `text`, scoped to the whole artifact; every
 * other action keeps the shape it had.
 */
export function approvalResumeValue(action: string, comment: string): Record<string, unknown> {
  const text = comment.trim();
  if (action === 'refine') {
    return { action, refineFeedback: { scope: 'whole', ...(text ? { text } : {}) }, ...(text ? { comment: text } : {}) };
  }
  return { action, comment: comment || undefined };
}
