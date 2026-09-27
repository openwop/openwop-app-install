/**
 * VOC evidence service (ADR 0403 Phase 1) — the quote-level evidence store the
 * market-intel pipeline is built on. Every evidence item MUST carry a
 * resolvable `sourceRef` (documentId + locator + contentHash) — an extracted
 * quote with no source is a typed validation finding, never a bare string
 * (the grounding invariant; the ADR 0356 proposals-with-citations pattern one
 * layer deeper).
 *
 * Store: `campaign-brief:voc-evidence`, tenant+brief keyed (the Persona
 * precedent — CTI-1 isolation; a foreign-tenant id reads null → uniform 404 at
 * the route). Quotes can contain customer PII (a review naming a person), so
 * the entity is declared to the ADR 0381 data-classification seam.
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';

export const VOC_SENTIMENTS = ['pain', 'desire', 'objection', 'praise'] as const;
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];

export const VOC_SOURCE_KINDS = ['kb', 'notebook', 'web', 'manual'] as const;
export type VocSourceKind = (typeof VOC_SOURCE_KINDS)[number];

/** The citation back to real source material — the non-negotiable. */
export interface VocSourceRef {
  /** The KB/notebook document id (or URL for `web`). */
  documentId: string;
  sourceKind: VocSourceKind;
  /** Where in the source (chunk index, line range, timestamp…) — free-form but required. */
  locator: string;
  /** sha256 of the resolved source text at extraction time — the replay-stable
   *  snapshot identity (a re-run against changed source is VISIBLE, never silent). */
  contentHash: string;
}

export interface VocEvidence {
  id: string;
  tenantId: string;
  orgId: string;
  briefId: string;
  /** The verbatim quote, ORIGINAL language (a translated "quote" is no longer
   *  a citation — ADR 0403 OQ-2). */
  quote: string;
  sourceRef: VocSourceRef;
  /** Free-text theme v1 (OQ-3 defers a closed vocabulary until a rollup consumer exists). */
  theme: string;
  sentiment: VocSentiment;
  /** Optional pointer at the persona this evidence appears to support. */
  personaHint?: string;
  createdBy: string;
  createdAt: string;
}

// PII posture (ADR 0403 matrix row 8): a VOC quote can name a real person.
declarePiiFields('campaign-brief.voc-evidence', ['quote']);

const evidence = new DurableCollection<VocEvidence>('campaign-brief:voc-evidence', (e) => `${e.tenantId}::${e.briefId}::${e.id}`);

const QUOTE_MAX = 2000;
const THEME_MAX = 200;
const LOCATOR_MAX = 300;
const DOC_ID_MAX = 500;
const HASH_MAX = 128;
const PERSONA_HINT_MAX = 120;
const MAX_PER_EXTRACTION = 100;

/** The bounds the artifact-type pack schema must mirror — the parity test pins
 *  `packs/feature.campaign-brief.artifact-types` to THIS SSoT (a drifted schema
 *  would lie to the model about what persists). */
export const VOC_LIMITS = {
  quoteMax: QUOTE_MAX, themeMax: THEME_MAX, locatorMax: LOCATOR_MAX,
  documentIdMax: DOC_ID_MAX, contentHashMax: HASH_MAX, personaHintMax: PERSONA_HINT_MAX,
  maxPerExtraction: MAX_PER_EXTRACTION,
} as const;

const SENTIMENT_SET = new Set<string>(VOC_SENTIMENTS);
const SOURCE_KIND_SET = new Set<string>(VOC_SOURCE_KINDS);

export interface VocEvidenceInput {
  quote?: unknown;
  sourceRef?: unknown;
  theme?: unknown;
  sentiment?: unknown;
  personaHint?: unknown;
}

export interface VocValidationFinding {
  index: number;
  field: string;
  message: string;
}

/**
 * Closed-world validation of ONE candidate item. Returns the normalized item or
 * a finding — the caller decides drop-with-finding vs typed failure (the node
 * drops + flags; an all-dropped extraction is a typed failure upstream).
 */
export function validateVocCandidate(raw: VocEvidenceInput, index: number):
  | { ok: true; item: Pick<VocEvidence, 'quote' | 'sourceRef' | 'theme' | 'sentiment'> & { personaHint?: string } }
  | { ok: false; finding: VocValidationFinding } {
  const quote = cleanString(raw.quote, QUOTE_MAX);
  if (!quote) return { ok: false, finding: { index, field: 'quote', message: 'Evidence must carry a non-empty verbatim quote.' } };
  const ref = raw.sourceRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, finding: { index, field: 'sourceRef', message: 'Evidence without a resolvable sourceRef is not evidence (grounding invariant).' } };
  }
  const r = ref as Record<string, unknown>;
  const documentId = cleanString(r.documentId, DOC_ID_MAX);
  const locator = cleanString(r.locator, LOCATOR_MAX);
  // NOT cleanString: the secret-shape scrub eats any ≥40-char opaque blob —
  // which every sha256 digest is. A hash is structural, not free text; hold it
  // to a strict hex shape instead (closed-world, and un-scrubbable).
  const rawHash = typeof r.contentHash === 'string' ? r.contentHash.trim().toLowerCase() : '';
  const contentHash = /^[a-f0-9]{16,128}$/.test(rawHash) ? rawHash : '';
  const sourceKind = typeof r.sourceKind === 'string' && SOURCE_KIND_SET.has(r.sourceKind) ? (r.sourceKind as VocSourceKind) : null;
  if (!documentId || !locator || !contentHash || !sourceKind) {
    return { ok: false, finding: { index, field: 'sourceRef', message: 'sourceRef requires documentId, sourceKind (kb|notebook|web|manual), locator, and a hex contentHash.' } };
  }
  const sentiment = typeof raw.sentiment === 'string' && SENTIMENT_SET.has(raw.sentiment) ? (raw.sentiment as VocSentiment) : null;
  if (!sentiment) return { ok: false, finding: { index, field: 'sentiment', message: `sentiment must be one of: ${VOC_SENTIMENTS.join(', ')}.` } };
  const theme = cleanString(raw.theme, THEME_MAX);
  if (!theme) return { ok: false, finding: { index, field: 'theme', message: 'A short theme label is required.' } };
  const personaHint = optionalCleanString(raw.personaHint, PERSONA_HINT_MAX);
  return { ok: true, item: { quote, sourceRef: { documentId, sourceKind, locator, contentHash }, theme, sentiment, ...(personaHint ? { personaHint } : {}) } };
}

/** DATA-1 (grade-data, generator class 2): the SAME verbatim quote from the
 *  SAME source snapshot is the same fact — a deterministic id makes a re-run
 *  of extract-voc idempotent instead of a duplicate generator. */
export function deterministicEvidenceId(tenantId: string, briefId: string, contentHash: string, quote: string): string {
  const normQuote = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  return `ev-${createHash('sha256').update(`${tenantId}::${briefId}::${contentHash}::${normQuote}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Persist a batch of VALIDATED evidence for a brief (the node's narrow write).
 *  Idempotent: an already-stored quote (same source snapshot) returns the
 *  EXISTING row untouched — re-running an extraction never duplicates facts. */
export async function persistVocEvidence(
  tenantId: string,
  orgId: string,
  briefId: string,
  createdBy: string,
  items: ReadonlyArray<Pick<VocEvidence, 'quote' | 'sourceRef' | 'theme' | 'sentiment'> & { personaHint?: string }>,
): Promise<VocEvidence[]> {
  if (items.length === 0) {
    throw new OpenwopError('validation_error', 'No valid evidence to persist (every candidate failed the grounding invariant).', 422);
  }
  if (items.length > MAX_PER_EXTRACTION) {
    throw new OpenwopError('validation_error', `An extraction persists at most ${MAX_PER_EXTRACTION} evidence items.`, 413, { max: MAX_PER_EXTRACTION });
  }
  const now = new Date().toISOString();
  const out: VocEvidence[] = [];
  for (const item of items) {
    const id = deterministicEvidenceId(tenantId, briefId, item.sourceRef.contentHash, item.quote);
    const existing = await evidence.get(`${tenantId}::${briefId}::${id}`);
    if (existing) { out.push(existing); continue; }
    const row: VocEvidence = { id, tenantId, orgId, briefId, ...item, createdBy, createdAt: now };
    await evidence.put(row);
    out.push(row);
  }
  return out;
}

export async function listVocEvidence(tenantId: string, briefId: string, filter?: { sentiment?: VocSentiment; theme?: string }): Promise<VocEvidence[]> {
  const all = await evidence.listByPrefix(`${tenantId}::${briefId}::`);
  return all
    .filter((e) => e.tenantId === tenantId
      && (!filter?.sentiment || e.sentiment === filter.sentiment)
      && (!filter?.theme || e.theme.toLowerCase().includes(filter.theme.toLowerCase())))
    // DEBT-2 (grade pass): same-batch rows share createdAt — tiebreak on id so
    // listing order is stable across calls.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function getVocEvidence(tenantId: string, briefId: string, evidenceId: string): Promise<VocEvidence | null> {
  const e = await evidence.get(`${tenantId}::${briefId}::${evidenceId}`);
  return e && e.tenantId === tenantId ? e : null;
}

/** Curation: an operator prunes a bad quote (uniform 404 on a foreign row). */
export async function deleteVocEvidence(tenantId: string, briefId: string, evidenceId: string): Promise<boolean> {
  const e = await getVocEvidence(tenantId, briefId, evidenceId);
  if (!e) return false;
  await evidence.delete(`${tenantId}::${briefId}::${evidenceId}`);
  return true;
}

/** Cascade owner: a deleted brief takes its evidence with it (wired by briefService.deleteBrief). */
export async function deleteVocForBrief(tenantId: string, briefId: string): Promise<number> {
  const all = await evidence.listByPrefix(`${tenantId}::${briefId}::`);
  for (const e of all) await evidence.delete(`${e.tenantId}::${e.briefId}::${e.id}`);
  return all.length;
}

/** Test-only. */
export async function __resetVocStore(): Promise<void> {
  await evidence.__clear();
}
