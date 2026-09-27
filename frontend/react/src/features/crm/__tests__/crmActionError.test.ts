/**
 * CRM-UX-14 — `crmActionError` is the ONE place a failed CRM write becomes
 * words for the user. The server's sentence is developer material: it goes to
 * `console.warn` and never to the toast. The HTTP status is what the UI can
 * name in the user's language.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18n from '../../../i18n/index.js';
import { CrmRequestError } from '../crmRequestError.js';
import { crmActionError, crmActionReason, revertedErr } from '../crmUiHelpers.js';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', () => ({ toast: { error: toastError, success: vi.fn() } }));

const WIRE = 'deleteContact returned 403 (subject lacks crm:write)';

beforeEach(() => { toastError.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('crmActionError — status → localized copy, never the wire string', () => {
  const cases: Array<[number, string]> = [
    [400, 'httpBadRequest'],
    [403, 'httpForbidden'],
    [404, 'httpNotFound'],
    [409, 'httpConflict'],
    [413, 'httpTooLarge'],
    [422, 'httpUnprocessable'],
    [429, 'httpTooMany'],
    [500, 'httpServerError'],
    [502, 'httpServerError'],
    [503, 'httpServerError'],
  ];
  for (const [status, key] of cases) {
    it(`${status} → crm:${key}`, () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const out = crmActionError(new CrmRequestError(WIRE, status), 'deleteFailed');
      expect(out).toBe(i18n.t(`crm:${key}`));
      expect(out).not.toContain('returned');
      expect(out).not.toContain('crm:write');
    });
  }

  it('a status the user cannot act on (401, 418) falls back to the caller\'s own key', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crmActionError(new CrmRequestError(WIRE, 401), 'deleteFailed')).toBe(i18n.t('crm:deleteFailed'));
    expect(crmActionError(new CrmRequestError(WIRE, 418), 'addFailed')).toBe(i18n.t('crm:addFailed'));
  });

  it('a plain Error (network drop, non-transport throw) falls back too — the message is NOT surfaced', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = crmActionError(new Error('Failed to fetch'), 'saveFailed');
    expect(out).toBe(i18n.t('crm:saveFailed'));
    expect(out).not.toContain('Failed to fetch');
  });

  it('a non-Error throw falls back and does not crash', () => {
    expect(crmActionError('nope', 'actionFailed')).toBe(i18n.t('crm:actionFailed'));
    expect(crmActionError(undefined, 'actionFailed')).toBe(i18n.t('crm:actionFailed'));
  });

  it('the wire string reaches console.warn — the developer still gets the truth', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    crmActionError(new CrmRequestError(WIRE, 403), 'deleteFailed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[crm]'), WIRE);
  });

  it('crmActionReason returns null when there is nothing status-specific to say', () => {
    expect(crmActionReason(new Error('x'))).toBeNull();
    expect(crmActionReason(new CrmRequestError('x', 401))).toBeNull();
    expect(crmActionReason(new CrmRequestError('x', 409))).toBe(i18n.t('crm:httpConflict'));
  });
});

describe('revertedErr — the optimistic-revert shape (CRM-UX-19 shares it with the board)', () => {
  it('leads with the status reason and ends on the reverted fact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    revertedErr(new CrmRequestError(WIRE, 409));
    expect(toastError).toHaveBeenCalledTimes(1);
    const msg = toastError.mock.calls[0]![0] as string;
    expect(msg).toBe(`${i18n.t('crm:httpConflict')} — ${i18n.t('crm:changeReverted')}`);
    expect(msg).not.toContain('returned');
  });

  it('with no status-specific reason it says only that the change was reverted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    revertedErr(new Error('Failed to fetch'));
    expect(toastError).toHaveBeenCalledWith(i18n.t('crm:changeReverted'));
  });
});
