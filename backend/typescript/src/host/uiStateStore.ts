/**
 * Per-user UI-state store (ADR 0071) — small, durable, NON-authoritative display
 * preferences (selected artifact revision, compare mode, expanded panels,
 * dismissed notices) that should survive reload and device changes.
 *
 * Boundaries (ADR 0071 §Storage rules): this is for DISPLAY state only. It MUST
 * NOT hold resume payloads, artifact content, review decisions, credentials,
 * hidden prompts, or provider traces — those live in their owning stores
 * (conversationReadState for read markers, the source records for review
 * decisions, Documents/Media for artifact content). Enforced here by a
 * resourceType allowlist, a hard value-size cap, and a recursive free-text scrub.
 *
 * Authorization is structural: a row is keyed by the AUTHENTICATED caller's
 * subjectRef, so a caller can only ever read/write their own rows. There is no
 * cross-subject or cross-tenant read.
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE (`/v1/host/openwop-app/*`).
 *
 * @see docs/adr/0071-chat-ui-state-and-feedback.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { OpenwopError } from '../types.js';

export type UiStateResourceType = 'conversation' | 'review' | 'artifact' | 'message';
const RESOURCE_TYPES: readonly UiStateResourceType[] = ['conversation', 'review', 'artifact', 'message'];

/** Bound the serialized value — these are display prefs, never documents. */
const MAX_VALUE_BYTES = 4096;
const MAX_KEY_LEN = 128;
const MAX_RESOURCE_ID_LEN = 256;

export interface UiStateEntry {
  tenantId: string;
  subjectRef: string;
  resourceType: UiStateResourceType;
  resourceId: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

// Key `${tenantId}:${subjectRef}:${resourceType}:${resourceId}:${key}`. Keys are
// never parsed (rows carry their own ids); internal colons in subjectRef
// (`user:<id>`) are harmless to point lookups + the per-(subject,resource) prefix.
const store = new DurableCollection<UiStateEntry>(
  'chat:ui-state',
  (e) => `${e.tenantId}:${e.subjectRef}:${e.resourceType}:${e.resourceId}:${e.key}`,
);

export function isUiStateResourceType(v: unknown): v is UiStateResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v);
}

/** Validate + redact + bound a UI-state write. Throws a 400/413 OpenwopError on
 *  a bad resourceType, an over-length key/id, or an over-cap/binary value. */
function sanitizeForWrite(resourceType: string, resourceId: string, key: string, value: unknown): { resourceType: UiStateResourceType; value: unknown } {
  if (!isUiStateResourceType(resourceType)) {
    throw new OpenwopError('validation_error', `resourceType MUST be one of ${RESOURCE_TYPES.join(', ')}.`, 400, { resourceType });
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN) {
    throw new OpenwopError('validation_error', `key MUST be a non-empty string ≤ ${MAX_KEY_LEN} chars.`, 400, {});
  }
  if (typeof resourceId !== 'string' || resourceId.length === 0 || resourceId.length > MAX_RESOURCE_ID_LEN) {
    throw new OpenwopError('validation_error', `resourceId MUST be a non-empty string ≤ ${MAX_RESOURCE_ID_LEN} chars.`, 400, {});
  }
  // Recursively scrub secret-shaped substrings out of any string leaves, then
  // hard-bound the serialized size (rejects accidental large/binary blobs).
  const redacted = sanitizeFreeTextDeep(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted ?? null);
  } catch {
    throw new OpenwopError('validation_error', 'value MUST be JSON-serializable.', 400, {});
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
    throw new OpenwopError('validation_error', `value exceeds the ${MAX_VALUE_BYTES}-byte UI-state cap.`, 400, {});
  }
  return { resourceType, value: redacted };
}

export async function putUiState(
  tenantId: string,
  subjectRef: string,
  resourceType: string,
  resourceId: string,
  key: string,
  value: unknown,
): Promise<UiStateEntry> {
  const clean = sanitizeForWrite(resourceType, resourceId, key, value);
  const entry: UiStateEntry = {
    tenantId, subjectRef, resourceType: clean.resourceType, resourceId, key,
    value: clean.value, updatedAt: new Date().toISOString(),
  };
  await store.put(entry);
  return entry;
}

/** The caller's UI-state rows for one resource (or all of a resourceType when
 *  resourceId omitted). Always scoped to (tenantId, subjectRef) — the caller's own. */
export async function listUiState(
  tenantId: string,
  subjectRef: string,
  resourceType?: string,
  resourceId?: string,
): Promise<UiStateEntry[]> {
  let prefix = `${tenantId}:${subjectRef}:`;
  if (resourceType && isUiStateResourceType(resourceType)) {
    prefix += `${resourceType}:`;
    if (resourceId) prefix += `${resourceId}:`;
  }
  return store.listByPrefix(prefix);
}

export async function deleteUiState(
  tenantId: string,
  subjectRef: string,
  resourceType: string,
  resourceId: string,
  key: string,
): Promise<boolean> {
  return store.delete(`${tenantId}:${subjectRef}:${resourceType}:${resourceId}:${key}`);
}

/** Test-only: clear the store. */
export async function __clearUiState(): Promise<void> {
  await store.__clear();
}
