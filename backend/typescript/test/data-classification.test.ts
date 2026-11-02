/**
 * ADR 0077 Phase 1 — data classification taxonomy + PII field registry.
 *
 * Verifies the registry queries (per-entity + entity-agnostic), the `internal`
 * default, the `looksLikePiiName` heuristic, and a LINT that the known high-risk
 * entities are registered (catches a missing declarePiiFields side-effect import).
 * (The registry is authoritative; the heuristic is a conservative secondary signal —
 * a declared field like `name` is covered by the registry even if the heuristic, by
 * design, only matches `_`-delimited PII shapes.)
 *
 * TST-CUC-1. Red when classification counts an empty field set as PII, when the
 * heuristic over-matches operational compounds or stops splitting camelCase, when a
 * declaration skips the entity-agnostic union or replaces instead of adding, or
 * when the reset leaves the union populated. The reset case runs on a FRESH module
 * instance (`vi.resetModules`), so clearing it never empties the shared registry
 * the other cases read — the file passes in any order.
 */

import { describe, expect, it, vi } from 'vitest';
// Importing the services triggers their module-load declarePiiFields side effects.
import '../src/features/crm/contactsService.js';
import '../src/features/users/usersService.js';
import {
  declarePiiFields, isPiiField, isKnownPiiFieldName, classificationOf,
  piiFieldRegistry, looksLikePiiName,
} from '../src/host/dataClassification.js';

describe('ADR 0077 §1 — PII field registry queries', () => {
  it('answers per-entity and entity-agnostic lookups', () => {
    expect(isPiiField('crm.contact', 'email')).toBe(true);
    expect(isPiiField('crm.contact', 'company')).toBe(false); // org attribute, not PII
    expect(isKnownPiiFieldName('email')).toBe(true);
    expect(isKnownPiiFieldName('stage')).toBe(false);
  });

  it('classifies an entity with any PII field as confidential-pii, else internal (default)', () => {
    expect(classificationOf('crm.contact')).toBe('confidential-pii');
    expect(classificationOf('crm.deal-stage-config')).toBe('internal'); // unlabeled → internal, never public
  });

  it('declare is additive + idempotent', () => {
    // A fresh entity and field names no module declares, so "add new" is real.
    declarePiiFields('test.additive', ['w69_first_pii']);
    declarePiiFields('test.additive', ['w69_first_pii']); // re-declare existing
    declarePiiFields('test.additive', ['w69_second_pii']); // add new
    expect(isPiiField('test.additive', 'w69_first_pii')).toBe(true);
    expect(isPiiField('test.additive', 'w69_second_pii')).toBe(true);
    expect([...(piiFieldRegistry().get('test.additive') ?? [])].sort()).toEqual(['w69_first_pii', 'w69_second_pii']);
  });
});

describe('ADR 0077 §1 — looksLikePiiName heuristic', () => {
  it('matches obvious PII shapes across camelCase / snake_case', () => {
    for (const n of ['email', 'phone', 'firstName', 'first_name', 'lastName', 'ssn', 'dateOfBirth', 'streetAddress', 'zipCode']) {
      expect(looksLikePiiName(n)).toBe(true);
    }
  });
  it('does not match operational field names', () => {
    for (const n of ['stage', 'tenantId', 'createdAt', 'status', 'company', 'runId', 'count']) {
      expect(looksLikePiiName(n)).toBe(false);
    }
  });
  it('does not over-match operational compounds containing a PII word (code-review MEDIUM)', () => {
    for (const n of ['ipAddress', 'fromAddress', 'webhookAddress', 'emailSubject', 'addressBookId', 'phoneType']) {
      expect(looksLikePiiName(n), `${n} should NOT be treated as PII`).toBe(false);
    }
    // …but the unambiguous PII compounds still match.
    for (const n of ['emailAddress', 'streetAddress', 'phoneNumber']) {
      expect(looksLikePiiName(n)).toBe(true);
    }
  });
});

describe('ADR 0077 §1 — lint: key entities registered', () => {
  it('the known high-risk entities are registered (missing side-effect import would fail this)', () => {
    const entities = [...piiFieldRegistry().keys()];
    expect(entities).toContain('crm.contact');
    expect(entities).toContain('users.user');
  });
});

describe('ADR 0077 §1 — test isolation', () => {
  it('__resetPiiRegistry clears the registry', async () => {
    vi.resetModules();
    const fresh = await import('../src/host/dataClassification.js');
    fresh.declarePiiFields('temp.entity', ['email']);
    expect(fresh.isPiiField('temp.entity', 'email')).toBe(true);
    expect(fresh.isKnownPiiFieldName('email')).toBe(true);
    fresh.__resetPiiRegistry();
    expect(fresh.isPiiField('temp.entity', 'email')).toBe(false);
    expect(fresh.isKnownPiiFieldName('email')).toBe(false);
    // the shared instance the rest of the file reads is untouched
    expect(isPiiField('crm.contact', 'email')).toBe(true);
  });
});
