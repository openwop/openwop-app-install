/**
 * The Knowledge Base transport failure, carrying the HTTP STATUS.
 *
 * `KBX-4` — every KB write used to reach the user as `e.message`, and the two
 * DELETE paths did not even parse the response body: they threw the literal
 * `` `deleteDocument returned ${res.status}` ``, which `KnowledgeBasePage`
 * rendered verbatim. During a reindex the operator's toast read
 * **"deleteDocument returned 409"** — a wire diagnostic, in English, in a
 * four-locale app, naming a function the user has never heard of and saying
 * nothing about the reindex that actually refused the write. The parsing paths
 * were only marginally better: they surfaced the server's own English sentence
 * ("A reindex is in progress for this collection; …") untranslated.
 *
 * The status is the part the UI can name in the user's language. This class
 * carries it out of the client so `kbUiHelpers.kbActionError` can map it; the
 * wire string stays on the error for `console.warn` and nowhere else. Same
 * shape as `features/crm/crmRequestError.ts` (`CRM-UX-14`) — deliberately a
 * SEPARATE class rather than a cross-feature import, because a feature package
 * does not reach into another's module (ADR 0001), and because a test that
 * mocks `kbClient.js` wholesale must not leave the `instanceof` undefined.
 */
export class KbRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'KbRequestError';
    this.status = status;
  }
}
