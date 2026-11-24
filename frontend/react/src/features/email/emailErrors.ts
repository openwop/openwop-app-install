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

/**
 * A definitive "this does not exist here": a 404.
 *
 * TST-OAR-1 (user decision 2026-11-22): this used to also accept
 * `code === 'not_found'`. Every email route that sends that code sends it with a
 * 404 (`routes.ts` "Template not found.", "Template version not found."), so the
 * code half never decided anything and no test could witness it. It is dropped.
 * If a route ever sends `not_found` with another status, add it back with a
 * fixture copied from that route's real body.
 */
export function isEmailNotFound(e: unknown): boolean {
  return e instanceof EmailApiError && e.status === 404;
}
