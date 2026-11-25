/**
 * The caller-supplied header fields of an outbound email: the sender display name and
 * the Reply-To address (#6135). One check, shared by the transactional seam
 * (`transactionalEmail.ts`) and the email adapter (`emailAdapter.ts`), so a value
 * refused at one door is refused at the other.
 *
 * Both values end up in a header line on every transport (SendGrid and Postmark build
 * it from JSON; SMTP writes it). A control character, CR and LF above all, could start
 * a second header line, so such a value is refused, never cleaned: a sender name that
 * silently changes is not what the caller asked for.
 *
 * Core: imports nothing.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** One bare address: no display name, no list, no comment, no quoting. */
const BARE_ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

export const FROM_NAME_MAX = 100;

export type EmailHeaderFieldProblem = 'from_name_invalid' | 'reply_to_invalid';

/** The first problem with `fromName` / `replyTo`, or null when both are absent or acceptable. */
export function emailHeaderFieldProblem(fields: { fromName?: string | undefined; replyTo?: string | undefined }): EmailHeaderFieldProblem | null {
  if (fields.fromName !== undefined) {
    const n = fields.fromName;
    if (CONTROL.test(n) || n.trim() === '' || n.length > FROM_NAME_MAX) return 'from_name_invalid';
  }
  if (fields.replyTo !== undefined) {
    const r = fields.replyTo;
    if (CONTROL.test(r) || r.length > 254 || !BARE_ADDRESS.test(r)) return 'reply_to_invalid';
  }
  return null;
}

/** `"Name" <addr>` for a transport that takes the From line as one string (Postmark). */
export function formatFromLine(address: string, fromName?: string): string {
  if (fromName === undefined) return address;
  return `"${fromName.replace(/[\\"]/g, (c) => `\\${c}`)}" <${address}>`;
}
