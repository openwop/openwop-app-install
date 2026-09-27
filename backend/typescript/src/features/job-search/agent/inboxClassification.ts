/**
 * ADR 0543 D3 / P4 — classify an inbound email; never obey it.
 *
 * CRM's `gmailSyncService` already syncs Gmail into CRM activity, so nothing new
 * ingests mail. This module only reads a synced message and says what KIND it is,
 * plus which pipeline stage that would imply. It proposes; it does not move.
 *
 * ## Why this does NOT reuse the ADR 0542 posting screen
 *
 * They look like the same problem and are not, and reusing the screen would be a
 * false economy that quietly broke the feature.
 *
 * A job POSTING containing an imperative aimed at an agent is always hostile:
 * employers do not write "ignore previous instructions" in a job ad. A recruiter
 * EMAIL containing imperatives is the normal corpus — "please confirm your
 * availability", "send us your portfolio", "let me know if Thursday works". The
 * base rates are opposite, so the posting screen applied here would skip most
 * genuine recruiter mail and the user would never learn why.
 *
 * ## How "never obeyed" is guaranteed
 *
 * Structurally, not by prompt and not by filtering. This function returns a
 * value from a CLOSED SET of labels. There is no code path by which an email
 * body becomes an action, a URL fetch, or a tool call, because the return type
 * cannot express one. An attacker who fully controls the body can, at most,
 * cause a wrong LABEL — which a human sees and can correct on a card.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** The closed label set. Extending it is a deliberate act; nothing here can
 *  invent a label, so the set bounds what an email can ever cause. */
export type InboxLabel =
  | 'rejection'
  | 'interview-invite'
  | 'information-request'
  | 'offer'
  | 'automated-receipt'
  | 'other';

/** The stage a label IMPLIES. Advisory: the move is a human's or a governed
 *  surface write, never a side effect of classifying. */
export type ProposedStage = 'Applied' | 'Screening' | 'Interviewing' | 'Offer' | null;

export interface Classification {
  label: InboxLabel;
  /** Which stage this would suggest, or null when it implies no movement. */
  proposedStage: ProposedStage;
  /** The matched phrase, so a human can judge the label rather than trust it. */
  evidence: string | null;
  /** True when the body contains text SHAPED like an instruction to an agent.
   *  Recorded, NOT acted on — the label is still produced. Flagging rather than
   *  skipping is right here because a hostile line inside a real interview
   *  invitation must not lose the user the interview. */
  containsInstructionShapedText: boolean;
}

interface Rule { label: InboxLabel; stage: ProposedStage; re: RegExp }

/**
 * Ordered — first match wins. Rejection is checked BEFORE interview because a
 * rejection often mentions the interview it is declining ("after your interview
 * we have decided…"), and reading that as an invitation would move a dead
 * application forward and hide the outcome from the user.
 */
const RULES: readonly Rule[] = [
  { label: 'rejection', stage: null, re: /\b(unfortunately|regret to inform|not (?:moving|proceeding) forward|decided (?:not to proceed|to move forward with other)|will not be progressing)\b/i },
  { label: 'offer', stage: 'Offer', re: /\b(offer of employment|pleased to offer|we (?:would like|are delighted) to offer|formal offer)\b/i },
  { label: 'interview-invite', stage: 'Interviewing', re: /\b(schedule (?:a|an) (?:call|interview|chat)|invite you to interview|book a time|availability for (?:a|an) (?:call|interview)|set up (?:a|an) (?:call|interview))\b/i },
  { label: 'information-request', stage: 'Screening', re: /\b(could you (?:send|share|provide)|please (?:send|share|provide|complete)|we need (?:a|your)|additional information)\b/i },
  { label: 'automated-receipt', stage: null, re: /\b(do ?not reply|no-reply|we have received your application|thank you for applying|your application has been received)\b/i },
];

/** Instruction-SHAPED text. Recorded for a human, never a reason to drop the mail. */
const INSTRUCTION_SHAPED =
  /\b(ignore|disregard)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,40}\b(instruction|prompt|rule)/i;

/** ROLE-PREFIX injection — `SYSTEM:` / `ASSISTANT:` at the start of a line.
 *  Missed by the first draft, which only looked for ANGLE-BRACKETED markers; a
 *  bare prefix is the more common technique and a test caught it. Anchored to a
 *  line start so ordinary prose ("our system: v2") does not trip it. */
const ROLE_PREFIX = /^\s*(SYSTEM|ASSISTANT|USER|INST)\s*:/im;

const FENCE_MARKER = /<\/?\s*(SYSTEM|INSTRUCTIONS?|UNTRUSTED)\s*>|\[\/?\s*(SYSTEM|INST)\s*\]/i;
const PERSONA_HIJACK = /\byou are now\b|\bprocess\.env\b/i;

const instructionShaped = (text: string): boolean =>
  INSTRUCTION_SHAPED.test(text) || ROLE_PREFIX.test(text) || FENCE_MARKER.test(text) || PERSONA_HIJACK.test(text);

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * Classify a synced message.
 *
 * Never throws, and always returns a label — `other` is a real answer, not a
 * failure. An email the rules do not recognise must still appear in the user's
 * pipeline rather than vanishing into an error path.
 */
export function classifyInboxMessage(subject: string | null | undefined, body: string | null | undefined): Classification {
  const text = [subject ?? '', body ?? ''].join('\n').trim();
  const instruction = instructionShaped(text);
  if (text.length === 0) {
    return { label: 'other', proposedStage: null, evidence: null, containsInstructionShapedText: instruction };
  }
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      return {
        label: rule.label,
        proposedStage: rule.stage,
        evidence: clip(m[0]),
        containsInstructionShapedText: instruction,
      };
    }
  }
  return { label: 'other', proposedStage: null, evidence: null, containsInstructionShapedText: instruction };
}
