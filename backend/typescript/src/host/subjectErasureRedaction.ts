/**
 * Shared redaction primitives for the HOST-store subject erasers (ADR 0464 P2).
 *
 * ADR 0464's taxonomy splits every subject-bearing host store into two lawful
 * outcomes: a subject's OWN data is DELETED, and a structurally-needed row (an
 * ACL membership, a canvas version, a scheduled job) is ANONYMIZED in place —
 * its shape survives (referential integrity, ACL structure, replay determinism)
 * while every subject identifier / subject-authored free-text field is
 * overwritten with a sentinel. This module owns the sentinel + the subject-key
 * matcher every host eraser shares, so the redaction reads uniformly across
 * stores and matches the approvals redactor's value (`PLAN_PROPOSAL_ERASED_NOTE`).
 */

/** The in-place anonymization / redaction sentinel. A redacted field carries
 *  this marker instead of the subject's identifier or authored text. */
export const ERASED = '[erased]';

/** The `user:`-tagged subjectRef after anonymization — keeps the tagged-ref
 *  shape (`user:<id>`) that participant / reaction / read-state consumers parse
 *  while carrying no id. */
export const ERASED_USER_REF = `user:${ERASED}`;

/**
 * The candidate string forms of a DSAR subject key.
 *
 * A subject key reaches the erasure seam either as a RAW id (`"alice"`, the
 * `User.userId` form the users-eraser matches) OR as a subject SCOPE
 * (`"user:alice"`, the ADR 0041 `subjectRef` form the kicktodo stores and the
 * chat participant/read-state/feedback/reaction stores hold). A single host
 * store holds one form or the other, so an eraser matches a field against every
 * form. Matching is exact string equality only, and the raw form is stripped
 * ONLY from a `user:`/`agent:`-tagged principal — any other resolver-expanded
 * key (e.g. `crm:contact:<id>`) contributes itself verbatim, so a stripped
 * segment of an unrelated key shape can never enter the match set.
 *
 * The set also holds the subject's `userRef()` spelling (`user:` + the key, and
 * `user:` + the scope). `User.userId` is ITSELF `user:<hash>`
 * (`usersService.userIdFor`), and several writers apply `userRef()` to it
 * (`userRef(req.userId)` in the chat routes, `user:${req.userId}` in a few
 * features), so live rows hold `user:user:<hash>`, which no other form matches.
 * Only the key and the scope are re-prefixed, never the stripped `raw`: for an
 * `agent:X` key, `user:X` would bridge into an unrelated person's ref (the
 * projects-eraser F2 rule). ADR 0464 correction 2026-10-26 (DSAR-DBL).
 *
 * - `forms`: the set to test a stored id/ref field against (`forms.has(field)`).
 * - `scope`: the `user:<id>` scope form (for stores whose KEYS embed a scope —
 *   subject memory, subject knowledge).
 * - `raw`:   the bare id (for `Subject.id` / raw-`userId` fields).
 */
export function subjectKeyForms(subjectKey: string): {
  forms: ReadonlySet<string>;
  scope: string;
  raw: string;
} {
  const m = /^(user|agent):(.+)$/.exec(subjectKey);
  const raw = m ? m[2]! : subjectKey;
  // An already-scoped key (any `prefix:` shape) is its own scope form; only a
  // bare id gets `user:`-tagged.
  const scope = m || subjectKey.includes(':') ? subjectKey : `user:${subjectKey}`;
  return { forms: new Set([subjectKey, raw, scope, `user:${subjectKey}`, `user:${scope}`]), scope, raw };
}
