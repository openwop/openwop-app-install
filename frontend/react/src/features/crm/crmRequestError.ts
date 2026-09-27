/**
 * The CRM transport failure, carrying the HTTP STATUS — in its own module so
 * BOTH fetch clients (`crmClient.ts` tenant-scoped, `crmOrgClient.ts`
 * org-scoped) and the UI helper (`crmUiHelpers.ts`) can share it without a
 * client↔client import, and so a test that mocks one client module wholesale
 * (several do, without spreading the original) does not leave the class
 * `undefined` for the helper's `instanceof`.
 *
 * Without a status a caller can only render `err.message` — the server's
 * untranslated English — which is how a KNOWN, expected refusal (the 409
 * referential-integrity guards on `deletePipeline` / `updatePipeline`) reached
 * the user as a raw wire string in whatever locale they were not using.
 * CRM-UX-14: `crmActionError` maps the status to localized copy; the wire
 * string stays in `console.warn` for the developer.
 */
export class CrmRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CrmRequestError';
    this.status = status;
  }
}
