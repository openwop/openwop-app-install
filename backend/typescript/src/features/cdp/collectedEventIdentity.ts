import { tombstoneKeyForms } from '../consent/consentService.js';
/** Shared narrow CDP identity matching: named identities or ingest-tagged PII,
 * never arbitrary payload text. */
export const COLLECTED_IDENTITY_KEYS = ['contactId', 'sessionKey', 'subjectKey', 'userId', 'visitor', 'visitorKey', 'visitorId', 'anonymousId', 'anonymousKey', 'distinctId'] as const;
export const foldCollectedIdentity = (value: string): string => value.trim().toLowerCase();
export const collectedIdentityForms = (value: string): string[] => [...new Set(tombstoneKeyForms(value).flatMap((form) => [form, foldCollectedIdentity(form)]))];
export function collectedIdentityValues(row: { payload: Record<string, unknown>; piiFields?: readonly string[] }): string[] {
  const out = new Set<string>();
  for (const key of new Set<string>([...COLLECTED_IDENTITY_KEYS, ...(row.piiFields ?? [])])) {
    const value = row.payload[key];
    if (typeof value === 'string' && foldCollectedIdentity(value)) out.add(value);
  }
  return [...out];
}
