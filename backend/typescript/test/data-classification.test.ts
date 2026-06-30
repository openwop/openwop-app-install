/**
 * ADR 0077 Phase 1 — data classification taxonomy + PII field registry.
 *
 * Verifies the registry queries (per-entity + entity-agnostic), the `internal`
 * default, the `looksLikePiiName` heuristic, and a LINT that the known high-risk
 * entities are registered (catches a missing declarePiiFields side-effect import).
 * (The registry is authoritative; the heuristic is a conservative secondary signal —
 * a declared field like `name` is covered by the registry even if the heuristic, by
 * design, only matches `_`-delimited PII shapes.)
 */

import { describe, expect, it } from 'vitest';
// Importing the services triggers their module-load declarePiiFields side effects.
import '../src/features/crm/contactsService.js';
import '../src/features/users/usersService.js';
import {
  declarePiiFields, isPiiField, isKnownPiiFieldName, classificationOf,
  piiFieldRegistry, looksLikePiiName, __resetPiiRegistry,
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
    declarePiiFields('crm.contact', ['email']); // re-declare existing
    declarePiiFields('crm.contact', ['phone']); // add new
    expect(isPiiField('crm.contact', 'phone')).toBe(true);
    expect(isPiiField('crm.contact', 'email')).toBe(true);
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
  it('__resetPiiRegistry clears the registry', () => {
    declarePiiFields('temp.entity', ['email']);
    expect(isPiiField('temp.entity', 'email')).toBe(true);
    __resetPiiRegistry();
    expect(isPiiField('temp.entity', 'email')).toBe(false);
    expect(isKnownPiiFieldName('email')).toBe(false);
  });
});
