/**
 * ADR 0779 D7 — the BYOK write-access predicate and the 409 reader.
 * `canManageByok` is FAIL-OPEN (only a resolved member lacking the scope is
 * read-only); `deleteConflictOf` reads what the server said a delete refusal was.
 *
 * Sabotage that turns these red (lib/writeAccess.ts, byok/lib/byokWriteAccess.ts):
 * any fail-open arm flipped, the scope check bypassed, `referencesKnown`/`owner`
 * dropped, a non-409 read as a conflict, the server sentence or the 403 mapping
 * dropped, 5xx bodies surfaced.
 *
 * The last case ("the compat client error shape") overlaps "an explained 4xx" and
 * compatClient.errors.test.ts (which builds the error through the real client). It
 * is kept: this file is protected, and a dedupe needs a human ask.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../client/requestJson.js';
import { byokErrorMessage, canManageByok, deleteConflictOf } from '../lib/byokWriteAccess.js';

describe('canManageByok', () => {
  it('only a resolved member WITHOUT host:byok:manage reads as read-only', () => {
    expect(canManageByok({ basis: 'member', scopes: ['workspace:write'] }, true)).toBe(false);
    expect(canManageByok({ basis: 'member', scopes: ['host:byok:manage'] }, true)).toBe(true);
  });
  it('fails open while loading, for the tenant owner, a failed read, and a superadmin', () => {
    expect(canManageByok({ basis: 'member', scopes: [] }, false)).toBe(true);
    expect(canManageByok({ basis: 'tenant-owner', scopes: [] }, true)).toBe(true);
    expect(canManageByok({ basis: 'none', scopes: [] }, true)).toBe(true);
    expect(canManageByok({ basis: 'member', scopes: [], superadmin: true }, true)).toBe(true);
  });
});

describe('deleteConflictOf', () => {
  const conflict = (details: unknown): ApiError => new ApiError({ status: 409, statusText: 'Conflict', url: '/x', body: { error: 'conflict', details } });
  it('reads named consumers, an unverifiable index, and an owning lifecycle', () => {
    expect(deleteConflictOf(conflict({ references: ['realtime voice'] }))).toEqual({ references: ['realtime voice'], referencesKnown: true });
    expect(deleteConflictOf(conflict({ referencesKnown: false }))).toEqual({ references: [], referencesKnown: false });
    expect(deleteConflictOf(conflict({ owner: 'connections' }))).toEqual({ references: [], referencesKnown: true, owner: 'connections' });
  });
  it('is null for anything that is not a 409', () => {
    expect(deleteConflictOf(new ApiError({ status: 403, statusText: 'Forbidden', url: '/x' }))).toBeNull();
    expect(deleteConflictOf(new Error('x'))).toBeNull();
  });
});

describe('byokErrorMessage', () => {
  const t = (k: string): string => `T(${k})`;
  it('a 403 is the localized permission message, never transport text', () => {
    expect(byokErrorMessage(t, new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { message: 'Missing required scope: host:byok:manage' } }))).toBe('T(common:error_forbidden)');
  });
  it('an explained 4xx keeps the server sentence; a 5xx is classified', () => {
    expect(byokErrorMessage(t, new ApiError({ status: 400, statusText: 'Bad', url: '/x', body: { message: 'is managed by connections' } }))).toBe('is managed by connections');
    expect(byokErrorMessage(t, new ApiError({ status: 500, statusText: 'err', url: '/x', body: { message: 'stack trace' } }))).toMatch(/^T\(common:error_/);
  });
});

describe('byokErrorMessage — the compat client error shape (grade-ux H1)', () => {
  it('a compat 400 with a server sentence keeps it (it used to read "Something went wrong. Retry.")', () => {
    const err = Object.assign(new Error('baseUrl must be https'), { status: 400, body: { error: 'validation_error', message: 'baseUrl must be https' } });
    expect(byokErrorMessage((k: string) => k, err)).toBe('baseUrl must be https');
  });
});
