/**
 * ADR 0517 open question 1 — the three branches are not interchangeable copy.
 * Each makes a different factual claim, and picking the wrong one is how a user
 * deletes the key their chat is actually using.
 */
import { describe, it, expect } from 'vitest';
import { duplicateKeysNotice } from '../duplicateKeysNotice.js';

const G = 'byok:google';
const OLD1 = 'byok:google:1782080112882';
const OLD2 = 'byok:google:1785358774187';

describe('duplicateKeysNotice', () => {
  it('says nothing when there is nothing to disambiguate', () => {
    expect(duplicateKeysNotice([], null, 'Google')).toBeNull();
    expect(duplicateKeysNotice([G], G, 'Google')).toBeNull();
    // One key that is NOT the active one is still not a duplicate situation.
    expect(duplicateKeysNotice([G], 'unknown', 'Google')).toBeNull();
  });

  it('names the live key and counts only the INACTIVE ones', () => {
    const n = duplicateKeysNotice([G, OLD1, OLD2], G, 'Google');
    expect(n).toEqual({ key: 'duplicateKeysWithActive', params: { count: 2, active: G } });
  });

  it('counts 1 when exactly two keys exist — the singular case', () => {
    // This is the case that produced "The other 1 stored here are inactive"
    // before the string was pluralised. The count must be 1, not 2.
    expect(duplicateKeysNotice([G, OLD1], G, 'Google')?.params.count).toBe(1);
  });

  it('refuses to claim the others are inactive when the binding is UNREADABLE', () => {
    // A guess here invites deleting the live key. It must say it does not know.
    const n = duplicateKeysNotice([G, OLD1], 'unknown', 'Google');
    expect(n?.key).toBe('duplicateKeysUnknownActive');
    expect(n?.params.count).toBe(2);          // the TOTAL — nothing is known to be inactive
    expect(n?.params.active).toBeUndefined(); // never names one it cannot vouch for
  });

  it('asks the user to pick when the binding names none of these', () => {
    expect(duplicateKeysNotice([OLD1, OLD2], null, 'Google')?.key).toBe('duplicateKeysNoneActive');
    // Bound to a DIFFERENT provider's key ⇒ still "none of these".
    expect(duplicateKeysNotice([OLD1, OLD2], 'byok:openai', 'Google')?.key).toBe('duplicateKeysNoneActive');
  });
});
