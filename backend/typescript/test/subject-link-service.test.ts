/**
 * subjectLinkService — RFC 0159 cross-lane deny store (ADR 0613).
 *
 * The deny store is a LINK-deny, not a merge: it records that an opaque,
 * IdP-stable subject id (SCIM externalId == persistent SAML NameID) has been
 * deactivated in a tenant, so the SAML decision path can fail-close the linked
 * identity WITHOUT rewriting `userIdFor` or coalescing the two durable Users.
 * Deterministic key `${tenantId}:${externalId}` ⇒ idempotent + replay-safe.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  clearLinkedSubjectDeny,
  denyLinkedSubject,
  eraseSubjectLinkDeny,
  isLinkedSubjectDenied,
} from '../src/host/auth/subjectLinkService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-subjlink-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('subjectLinkService (RFC 0159 §A)', () => {
  beforeEach(() => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, `sl-${Math.random().toString(36).slice(2)}.db`)));
  });

  it('deny → isDenied → clear round-trips', async () => {
    expect(await isLinkedSubjectDenied('t', 'ext-1')).toBe(false);
    await denyLinkedSubject('t', 'ext-1');
    expect(await isLinkedSubjectDenied('t', 'ext-1')).toBe(true);
    // idempotent re-deny
    await denyLinkedSubject('t', 'ext-1');
    expect(await isLinkedSubjectDenied('t', 'ext-1')).toBe(true);
    // clear (re-hire / reactivation)
    await clearLinkedSubjectDeny('t', 'ext-1');
    expect(await isLinkedSubjectDenied('t', 'ext-1')).toBe(false);
  });

  it('is tenant-isolated: a deny in tenant A does NOT deny the same externalId in tenant B', async () => {
    await denyLinkedSubject('tenant-a', 'shared-ext');
    expect(await isLinkedSubjectDenied('tenant-a', 'shared-ext')).toBe(true);
    expect(await isLinkedSubjectDenied('tenant-b', 'shared-ext')).toBe(false);
    // clearing A leaves B untouched (B was never denied)
    await clearLinkedSubjectDeny('tenant-a', 'shared-ext');
    expect(await isLinkedSubjectDenied('tenant-a', 'shared-ext')).toBe(false);
    expect(await isLinkedSubjectDenied('tenant-b', 'shared-ext')).toBe(false);
  });

  it('a falsy tenant or externalId is fail-closed at the write and never records a deny', async () => {
    await denyLinkedSubject('', 'ext-x');
    await denyLinkedSubject('t', '');
    expect(await isLinkedSubjectDenied('', 'ext-x')).toBe(false);
    expect(await isLinkedSubjectDenied('t', '')).toBe(false);
  });

  describe('DSAR subject erasure (ADR 0464 §2.1)', () => {
    it('erases the deny row when the DSAR key is the bare opaque externalId', async () => {
      await denyLinkedSubject('t', 'idp-op-8f3a');
      expect(await isLinkedSubjectDenied('t', 'idp-op-8f3a')).toBe(true);
      const report = await eraseSubjectLinkDeny('t', 'idp-op-8f3a');
      expect(report.rowsTouched).toBe(1);
      expect(await isLinkedSubjectDenied('t', 'idp-op-8f3a')).toBe(false);
    });

    it('reaches the row via a saml:<NameID> principal key (externalId == NameID, RFC 0159)', async () => {
      await denyLinkedSubject('t', 'idp-op-8f3a');
      const report = await eraseSubjectLinkDeny('t', 'saml:idp-op-8f3a');
      expect(report.rowsTouched).toBe(1);
      expect(await isLinkedSubjectDenied('t', 'idp-op-8f3a')).toBe(false);
    });

    it('is tenant-scoped: erasing in tenant A leaves the same externalId denied in tenant B', async () => {
      await denyLinkedSubject('tenant-a', 'shared-ext');
      await denyLinkedSubject('tenant-b', 'shared-ext');
      const report = await eraseSubjectLinkDeny('tenant-a', 'shared-ext');
      expect(report.rowsTouched).toBe(1);
      expect(await isLinkedSubjectDenied('tenant-a', 'shared-ext')).toBe(false);
      expect(await isLinkedSubjectDenied('tenant-b', 'shared-ext')).toBe(true);
    });

    it('a key from a different identity space matches nothing (harmless no-op)', async () => {
      await denyLinkedSubject('t', 'idp-op-8f3a');
      const report = await eraseSubjectLinkDeny('t', 'user:someone-else');
      expect(report.rowsTouched).toBe(0);
      expect(await isLinkedSubjectDenied('t', 'idp-op-8f3a')).toBe(true);
    });
  });
});
