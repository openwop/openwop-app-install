/**
 * A5 — a real, self-contained, deterministic text embedding for the reference
 * host (no external model / API key).
 *
 * Feature hashing (the "hashing trick"): tokenize → hash each token to a bucket
 * with a sign → accumulate with sublinear term weighting → L2-normalize. The
 * result is a fixed-dimension unit vector whose cosine similarity tracks lexical
 * overlap, so it drives the existing `host.db.vector` cosine store end-to-end.
 * Deterministic (replay-safe) and dependency-free. A production host swaps this
 * for a learned model; the wire shape (`{ embedding: number[] }`) is identical.
 */

import { createHash } from 'node:crypto';

export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1';
export const DEFAULT_EMBEDDING_DIMS = 256;

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'are', 'be', 'for', 'on', 'by', 'with', 'as', 'at', 'it']);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

/** Stable 32-bit bucket + sign for a token (SHA-256 derived → deterministic
 *  across processes, unlike a runtime string hash). */
function bucketAndSign(token: string, dims: number): { bucket: number; sign: 1 | -1 } {
  const h = createHash('sha256').update(token).digest();
  const idx = h.readUInt32BE(0) % dims;
  const sign = (h[4]! & 1) === 0 ? 1 : -1;
  return { bucket: idx, sign };
}

/** Embed text into a deterministic L2-normalized vector of length `dims`. */
export function embedText(text: string, dims: number = DEFAULT_EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const counts = new Map<string, number>();
  for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, tf] of counts) {
    const { bucket, sign } = bucketAndSign(tok, dims);
    vec[bucket]! += sign * (1 + Math.log(tf)); // sublinear TF
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i += 1) vec[i]! /= norm;
  return vec;
}
