/**
 * ADR 0853 D7 — the seam a feature uses to hear that a document gained a new
 * version, without the documents feature importing it (ADR 0630).
 *
 * `addVersion` calls `notifyDocumentVersionAdded` once per version it actually
 * inserts (never for an idempotent replay), after the current-version pointer
 * moved. Observers are FAIL-SOFT: one that throws is logged and skipped, so a
 * consumer can never fail the save. Observers must be idempotent: the same
 * text can be announced again in a later version.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.documentVersionObservers');

export interface DocumentVersionAdded {
  tenantId: string;
  orgId: string;
  documentId: string;
  title: string;
  kind: string;
  /** The document's finer owner (ADR 0045/0046), when it has one. */
  ownerSubject?: { kind: string; id: string };
  version: number;
  content: string;
  /** The previous version's content ('' for the first version). */
  previousContent: string;
  producedBy: { kind: 'user' | 'agent' | 'run'; id: string };
}

type Observer = (e: DocumentVersionAdded) => Promise<void>;
const observers = new Map<string, Observer>();

/** Keyed, so a repeat boot replaces rather than duplicates. */
export function registerDocumentVersionObserver(key: string, fn: Observer): void {
  observers.set(key, fn);
}

export async function notifyDocumentVersionAdded(e: DocumentVersionAdded): Promise<void> {
  for (const [key, fn] of observers) {
    try {
      await fn(e);
    } catch (err) {
      log.warn('document_version_observer_failed', { observer: key, tenantId: e.tenantId, documentId: e.documentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
