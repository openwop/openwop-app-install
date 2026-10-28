/**
 * ADR 0946 D2/D5 — `diversity`: concept distance over the closed axes, then
 * execution distance (copy and image) between members that compete in the
 * same ad set. Members close on both counts form a cluster; a cluster larger
 * than one is needs_review ("likely to be treated as one ad").
 *
 * Honesty: this is a proxy for platform grouping (Meta Andromeda), not its
 * internals. Copy distance uses the supplied embeddings when present (their
 * model id is recorded), else token Jaccard; image distance uses the ADR 0945
 * perceptual hash when present, else it is reported `not_measured`. With
 * neither, two members of the same concept in one ad set count as near.
 */
import { findNearDuplicates } from '../similarity.js';
import { toFinding, type ContentFinding } from '../findings.js';
import type { CreativeConcept, CreativeRulesInput, DiversityReport } from './types.js';

export const AXES = ['angle', 'personaId', 'hook', 'visual', 'format'] as const;
/** Concepts at or under this distance (share of differing axes) count as the same idea. */
export const CONCEPT_NEAR = 0.2;
/** Copy similarity at or over this counts as near (cosine or Jaccard). */
export const COPY_NEAR = 0.8;
/** Perceptual-hash Hamming distance (of 64 bits) at or under this counts as near. */
export const IMAGE_NEAR_BITS = 10;

export function conceptDistance(a: CreativeConcept, b: CreativeConcept): number {
  let differ = 0;
  for (const axis of AXES) if ((a.axes[axis] ?? '') !== (b.axes[axis] ?? '')) differ += 1;
  return differ / AXES.length;
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? null : dot / Math.sqrt(na * nb);
}

function hamming(a: string, b: string): number | null {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length || !/^[0-9a-f]+$/i.test(b)) return null;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { bits += x & 1; x >>= 1; }
  }
  return bits;
}

const copyText = (copy: Record<string, string> | undefined): string => Object.keys(copy ?? {}).sort().map((k) => copy?.[k] ?? '').join(' ');

export function scoreDiversity(input: CreativeRulesInput, rulesetVersion: string): { report: DiversityReport; findings: ContentFinding[] } {
  const concepts = new Map(input.concepts.map((c) => [c.conceptId, c]));
  const pairs: number[] = [];
  for (let i = 0; i < input.concepts.length; i++) for (let j = i + 1; j < input.concepts.length; j++) pairs.push(conceptDistance(input.concepts[i], input.concepts[j]));
  const axisCoverage: Record<string, number> = {};
  for (const axis of AXES) axisCoverage[axis] = new Set(input.concepts.map((c) => c.axes[axis] ?? '')).size;

  const vectors = input.embeddings?.vectors ?? {};
  let copyMeasured = false;
  let imageMeasured = false;
  const near = (i: number, j: number): boolean => {
    const a = input.members[i]; const b = input.members[j];
    const ca = concepts.get(a.conceptId); const cb = concepts.get(b.conceptId);
    const cd = a.conceptId === b.conceptId ? 0 : ca && cb ? conceptDistance(ca, cb) : 1;
    if (cd > CONCEPT_NEAR) return false;
    let measured = false;
    let close = false;
    const ta = copyText(a.copy); const tb = copyText(b.copy);
    if (ta && tb) {
      measured = true; copyMeasured = true;
      const cos = vectors[a.memberId] && vectors[b.memberId] ? cosine(vectors[a.memberId], vectors[b.memberId]) : null;
      const sim = cos ?? (findNearDuplicates([ta, tb], 0)[0]?.similarity ?? 0);
      if (sim >= COPY_NEAR) close = true;
    }
    const ha = a.media?.perceptualHash; const hb = b.media?.perceptualHash;
    if (ha && hb) {
      const d = hamming(ha, hb);
      if (d !== null) { measured = true; imageMeasured = true; if (d <= IMAGE_NEAR_BITS) close = true; }
    }
    return measured ? close : true;
  };

  // Union-find within each ad set.
  const parent = input.members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const setOf = (i: number): string => input.members[i].adSet ?? input.members[i].channel;
  for (let i = 0; i < input.members.length; i++) {
    for (let j = i + 1; j < input.members.length; j++) {
      if (setOf(i) === setOf(j) && near(i, j)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  input.members.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const clusters = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ adSet: setOf(g[0]), memberIds: g.map((i) => input.members[i].memberId).sort() }))
    .sort((a, b) => a.memberIds[0].localeCompare(b.memberIds[0]));

  const findings = clusters.map((c) => toFinding({
    ruleSet: 'diversity', ruleId: 'diversity.cluster', severity: 'medium', action: 'needs_review',
    assetId: c.memberIds[0], field: `adSet.${c.adSet}`, introduced: true,
    span: { start: 0, end: c.memberIds.length, text: c.memberIds.join(',') },
    message: `These ${c.memberIds.length} members are likely to be treated as one ad in ${c.adSet}.`,
    recommendation: `Replace ${c.memberIds.length - 1} of them with a different concept, hook or visual.`,
  }));

  const report: DiversityReport = {
    rulesetVersion,
    conceptDistance: {
      mean: pairs.length ? Math.round((pairs.reduce((s, d) => s + d, 0) / pairs.length) * 100) / 100 : 0,
      min: pairs.length ? Math.min(...pairs) : 0,
      axisCoverage,
    },
    clusters,
    copyMeasure: copyMeasured ? (input.embeddings ? 'embedding' : 'jaccard') : 'not_measured',
    imageMeasure: imageMeasured ? 'perceptual_hash' : 'not_measured',
    ...(input.embeddings ? { embeddingModel: input.embeddings.model } : {}),
    scoredAt: input.asOf,
  };
  return { report, findings };
}
