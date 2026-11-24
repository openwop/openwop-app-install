/**
 * ADR 1156 D2/D5 — the chat's held-call card rides two host-extension run-log events,
 * written by the exchange next to the turns they belong to (the ADR 1001 D7
 * clarification-card precedent) and read by the client from the same events poll.
 * Neither carries the call's arguments or its description: those live on the ledger row
 * only while the ask is open (ADR 0834 D6), and the card reads them from there.
 */

/** A held call now waits on a card under the agent turn `askId`. */
export const TOOL_APPROVAL_REQUESTED_EVENT = 'openwop-app.conversation.tool-approval-requested';
/** What became of a card's approval: `ran`, `refused` (with the tool's words) or `superseded`. */
export const TOOL_APPROVAL_SETTLED_EVENT = 'openwop-app.conversation.tool-approval-settled';
