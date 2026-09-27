/**
 * E-signature target rendering + content-hash binding (ADR 0402 §b).
 *
 * A sign request binds to a CONTENT HASH of what is being signed. The target is
 * owned by another feature (a commerce quote, or a document) — that feature stays
 * the source of truth for the content; this module only COMPOSES their existing
 * public projections into (a) a deterministic byte serialization to hash and
 * (b) a human-readable markdown rendering for the signing page + certificate.
 *
 * The kind-switch is contained here so a future third target kind (or a promotion
 * to a `registerSignTarget` registration seam, the submission-sink precedent)
 * is a localized change. The commerce read is a DYNAMIC import: crm↔commerce is
 * already a bidirectional module edge (commerceService imports crm; crm
 * leadScoreService imports commerce), so a call-time import avoids any eval-time
 * cycle (the `commerceService.ts` dynamic-import-of-sharing precedent).
 *
 * The hash is over the deterministic SOURCE serialization — NEVER the rendered
 * PDF (pdfkit stamps a CreationDate, so PDF bytes are not byte-stable).
 *
 * @see docs/adr/0402-crm-booking-and-esign.md §b
 */

import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';

export type SignTargetKind = 'commerce_quote' | 'document';
export const SIGN_TARGET_KINDS: SignTargetKind[] = ['commerce_quote', 'document'];

export interface SignTarget {
  kind: SignTargetKind;
  id: string;
}

export interface RenderedTarget {
  /** Human-readable markdown shown on the signing page + folded into the cert. */
  markdown: string;
  /** Deterministic canonical serialization the content hash is taken over. */
  canonical: string;
  /** A short title for the certificate / calendar / UI. */
  title: string;
}

/** Stable stringify: object keys sorted recursively, so the serialization is
 *  independent of property insertion order. Money is pre-normalized to fixed
 *  strings by the callers below, so no float-precision drift enters the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hashCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const money = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '0.00');

/**
 * Render + serialize a sign target. Reads the owning feature's public projection
 * (never a private/PII field). Throws `not_found` if the target is missing or not
 * in a signable state for this (tenant, org).
 */
export async function renderTarget(tenantId: string, orgId: string, target: SignTarget): Promise<RenderedTarget> {
  if (target.kind === 'commerce_quote') {
    const { getQuote, projectQuotePublic } = await import('../commerce/quotes.js');
    const q = await getQuote(tenantId, orgId, target.id);
    if (!q) throw new OpenwopError('not_found', 'Quote not found.', 404, { target: target.id });
    const pub = projectQuotePublic(q) as { quoteId: string; status: string; lines: { name: string; quantity: number; unitPrice: number }[]; subtotal: number; total: number; currency: string; note?: string; expiresAt?: string; version: number };
    // Canonical: money as fixed strings (float-precision-safe), stable-keyed.
    const canonicalObj = {
      kind: 'commerce_quote',
      quoteId: pub.quoteId,
      version: pub.version,
      currency: pub.currency,
      lines: pub.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: money(l.unitPrice) })),
      subtotal: money(pub.subtotal),
      total: money(pub.total),
      ...(pub.note ? { note: pub.note } : {}),
      ...(pub.expiresAt ? { expiresAt: pub.expiresAt } : {}),
    };
    const rows = pub.lines.map((l) => `| ${l.name} | ${l.quantity} | ${money(l.unitPrice)} ${pub.currency} |`).join('\n');
    const markdown = [
      `## Quote ${pub.quoteId} (v${pub.version})`,
      '',
      '| Item | Qty | Unit price |',
      '| --- | --- | --- |',
      rows,
      '',
      `**Subtotal:** ${money(pub.subtotal)} ${pub.currency}`,
      `**Total:** ${money(pub.total)} ${pub.currency}`,
      ...(pub.note ? ['', pub.note] : []),
    ].join('\n');
    return { markdown, canonical: stableStringify(canonicalObj), title: `Quote ${pub.quoteId}` };
  }

  // document
  const { getDocument, getVersion } = await import('../documents/documentsService.js');
  const doc = await getDocument(tenantId, orgId, target.id);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { target: target.id });
  if (!doc.currentVersionId) throw new OpenwopError('not_found', 'Document has no content to sign.', 404, { target: target.id });
  const version = await getVersion(tenantId, orgId, target.id, doc.currentVersionId);
  if (!version) throw new OpenwopError('not_found', 'Document has no content to sign.', 404, { target: target.id });
  const content = version.content;
  const canonicalObj = { kind: 'document', documentId: target.id, versionId: doc.currentVersionId, content };
  return { markdown: content, canonical: stableStringify(canonicalObj), title: doc.title };
}
