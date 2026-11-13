/**
 * ADR 1109 D2 — what a request says, read from `interrupt.data` in one place.
 * Mirrors the backend's `requestWordsOf` (`notifications/notify.ts`): `title` on
 * its own, the text from `prompt`, then `description`, then `summary`.
 */
export interface RequestWords { title?: string; text?: string }

const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function requestWords(data: unknown): RequestWords {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  const title = nonBlank(d.title);
  const text = nonBlank(d.prompt) ?? nonBlank(d.description) ?? nonBlank(d.summary);
  return { ...(title ? { title } : {}), ...(text ? { text } : {}) };
}
