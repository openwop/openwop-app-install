/**
 * ADR 0963 D3 — a card the work loop restored after a stopped or failed run
 * carries a MACHINE line in its blocker note, marked `[auto:run-restore]`
 * (`backend/typescript/src/host/cardRunRecovery.ts` RESTORE_NOTE_MARK — keep the
 * two spellings identical). While that line is present the loop will not pick
 * the card: it is HELD until a person releases it.
 *
 * The note mixes a person's text with that machine line, so every surface that
 * shows or edits it splits the two: people see and edit only their own text,
 * the hold is shown as a state with a Release action, and the marker string
 * itself never reaches the screen.
 */
export const RESTORE_NOTE_MARK = '[auto:run-restore]';

const lines = (note: string | undefined): string[] => (note ?? '').split('\n').filter((l) => l.trim());

/** Whether the work loop holds this card (the backend's `isHeldForReview`). */
export function isHeldNote(note: string | undefined): boolean {
  return typeof note === 'string' && note.includes(RESTORE_NOTE_MARK);
}

/** The person-authored part of a blocker note. */
export function humanNote(note: string | undefined): string {
  return lines(note).filter((l) => !l.includes(RESTORE_NOTE_MARK)).join('\n').trim();
}

/** The machine lines, kept verbatim so an edit of the human part does not release the hold. */
export function machineNote(note: string | undefined): string {
  return lines(note).filter((l) => l.includes(RESTORE_NOTE_MARK)).join('\n');
}

/** Recombine an edited human part with the machine lines it was split from. */
export function withMachineNote(human: string, machine: string): string {
  const h = human.trim();
  return [h, machine].filter(Boolean).join('\n');
}
