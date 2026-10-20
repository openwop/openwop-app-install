/**
 * Campaign ops content hashing (ADR 0922 D3 / ADR 0923 D6): sha256 over the
 * RFC 8785 canonical JSON of a value, so the same content always hashes the same
 * regardless of key order.
 */
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../../host/jcs.js';

export function contentHashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJSON(value)).digest('hex')}`;
}
