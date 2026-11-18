/**
 * Issue 5962 — the email client's typed failure. `asJson` used to throw a plain
 * `Error` carrying only the server's message, and the template page decided
 * "not found" by looking for `404` in that text. The server's real 404 body says
 * "Template not found.", so every stale or deleted template link read as a load
 * failure. The status and the envelope's code now travel with the error, and the
 * page decides by them. Its own module, so a test that mocks the client keeps it.
 */
export class EmailApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'EmailApiError';
  }
}

/** A definitive "this does not exist here": a 404, or the canonical `not_found` code. */
export function isEmailNotFound(e: unknown): boolean {
  return e instanceof EmailApiError && (e.status === 404 || e.code === 'not_found');
}
