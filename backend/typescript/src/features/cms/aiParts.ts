/**
 * Sending one CMS section to the model in parts (ADR 1112 P3, shared by translate and rewrite
 * in P6). One implementation of: what the model is sent, how a section too large for one reply
 * is split, the part budget, running the parts under one deadline with the first failure
 * stopping the rest, the per-part reply check, and joining the replies. The callers own their
 * prompts, their per-part attempt and repair, their typed errors, and the restore + sanitize
 * they run once on the joined reply.
 */

import { SECTION_ITEM_BASE_KEYS } from './designSections.js';
import type { SectionType } from './cmsService.js';

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * ADR 1112 P2 (code review) — the model answers in at most 2,000 tokens, roughly 8,000
 * characters of JSON, so a section far larger than that cannot come back whole. A payload
 * up to this size goes as one part.
 */
export const AI_SECTION_MAX_CHARS = 12_000;
/** Past one part, each part holds at most this much payload, so its reply fits with room to spare. */
export const AI_BATCH_CHARS = 5_000;
/** One section takes at most this many parts (model calls, before repairs). */
export const AI_SECTION_MAX_BATCHES = 8;
const AI_BATCH_CONCURRENCY = 4;
/** Parts run under one deadline, so an editor's request returns inside the hosting proxy's 60 s. */
export const AI_PARTS_DEADLINE_MS = 45_000;

/**
 * What the model is sent. For a scheduleSim, list items lose every behaviour key but `id` and
 * `key`: `restoreItemStates` puts them back from the base after the reply, and the ids are what
 * align the reply to the base. Other section types are sent whole.
 */
export function sectionPayload(sectionType: SectionType, data: Raw): Raw {
  if (sectionType !== 'scheduleSim') return data;
  const drop = new Set((SECTION_ITEM_BASE_KEYS.scheduleSim?.all ?? []).filter((k) => k !== 'id' && k !== 'key'));
  const strip = (v: unknown, inList: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => strip(x, true));
    if (!isObj(v)) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !(inList && drop.has(k))).map(([k, x]) => [k, strip(x, false)]));
  };
  return strip(data, false) as Raw;
}

/** The parts, or why there can be none: `batches` is set when the part budget is the limit. */
export type PartsPlan = { ok: true; parts: Raw[] } | { ok: false; chars: number; batches?: number };

/**
 * One payload when it fits AI_SECTION_MAX_CHARS; else (scheduleSim only) the decisions split in
 * order into parts of at most AI_BATCH_CHARS, the first carrying everything else.
 */
export function planParts(sectionType: SectionType, data: Raw): PartsPlan {
  const payload = sectionPayload(sectionType, data);
  const size = (x: unknown): number => JSON.stringify(x).length;
  const chars = size(payload);
  if (chars <= AI_SECTION_MAX_CHARS) return { ok: true, parts: [payload] };
  const { decisions, ...rest } = payload;
  if (sectionType !== 'scheduleSim' || !Array.isArray(decisions) || size(rest) > AI_BATCH_CHARS) return { ok: false, chars };
  const parts: Raw[] = [];
  let part: unknown[] = [];
  let used = size(rest);
  for (const d of decisions) {
    const n = size(d) + 1;
    if (part.length > 0 && used + n > AI_BATCH_CHARS) {
      parts.push(parts.length === 0 ? { ...rest, decisions: part } : { decisions: part });
      part = [];
      used = size({ decisions: [] });
    }
    part.push(d);
    used += n;
  }
  parts.push(parts.length === 0 ? { ...rest, decisions: part } : { decisions: part });
  if (parts.length > AI_SECTION_MAX_BATCHES) return { ok: false, chars, batches: parts.length };
  return { ok: true, parts };
}

/**
 * A part must answer every decision it was sent, with the same ids: parts are joined in order,
 * and a list without ids aligns by position, so one dropped item would shift them all, and a
 * changed id aligns to nothing.
 */
export function partReplyMismatch(part: Raw, reply: Raw): boolean {
  if (!Array.isArray(part.decisions)) return false;
  if (!Array.isArray(reply.decisions) || reply.decisions.length !== part.decisions.length) return true;
  const got = reply.decisions as unknown[];
  return !part.decisions.every((x, i) => !isObj(x) || x.id === undefined || (isObj(got[i]) && got[i].id === x.id));
}

/** The parts were stopped: by the caller's own signal, or by the parts' deadline. */
export class PartsStopped extends Error {
  constructor(readonly by: 'caller' | 'deadline', readonly parts: number) {
    super(`ai parts stopped (${by})`);
    this.name = 'PartsStopped';
  }
}

/**
 * Run `call` over the parts, AI_BATCH_CONCURRENCY at a time, replies in part order. More than
 * one part runs under AI_PARTS_DEADLINE_MS; a caller's signal stops one part or several. The
 * first failure aborts the rest. A stop throws PartsStopped; any other failure is rethrown.
 */
export async function runParts(parts: readonly Raw[], call: (part: Raw, signal: AbortSignal | undefined) => Promise<Raw>, opts?: { signal?: AbortSignal }): Promise<Raw[]> {
  const outer = opts?.signal;
  const stop = parts.length > 1 || outer ? new AbortController() : undefined;
  let by: 'caller' | 'deadline' | undefined;
  const timer = parts.length > 1 && stop ? setTimeout(() => { by ??= 'deadline'; stop.abort(); }, AI_PARTS_DEADLINE_MS) : undefined;
  const onOuter = (): void => { by ??= 'caller'; stop?.abort(); };
  if (outer?.aborted) onOuter(); else outer?.addEventListener('abort', onOuter, { once: true });
  const out = new Array<Raw>(parts.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < parts.length) {
      const i = next++;
      try {
        out[i] = await call(parts[i]!, stop?.signal);
      } catch (err) {
        stop?.abort();
        throw err;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(AI_BATCH_CONCURRENCY, parts.length) }, worker));
  } catch (err) {
    if (by) throw new PartsStopped(by, parts.length);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
  return out;
}

/** Parts join in order: the first carries everything but the later decisions. */
export function joinParts(replies: readonly Raw[]): Raw {
  return replies.length === 1 ? replies[0]! : { ...replies[0]!, decisions: replies.flatMap((r) => r.decisions as unknown[]) };
}
