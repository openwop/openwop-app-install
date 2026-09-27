/**
 * User-authored prompt store (localStorage).
 *
 * Sits alongside the bundled `BUNDLED_PROMPTS` library:
 * - Bundled samples are read-only (versioned with the app).
 * - User prompts persist per-browser under
 *   `openwop-app.prompts.user` and are CRUD-able from
 *   `/prompts`. New prompts get a `user:` prefix in their
 *   templateId so they're distinguishable from samples and don't
 *   collide with a future BE-side canonical store.
 *
 * Envelope: `{ v: 1, items: [...] }` — `useChatSessions`-style
 * version-gated payload. Reader drops entries whose envelope
 * version doesn't match the current schema so a future shape
 * change doesn't render with stale data.
 */

import type { PromptTemplate } from './types.js';
import { STORAGE_KEYS, getStorageSubject, readRaw, removeRaw, scopedSpec, writeRaw } from '../platform/storage.js';

const LS_VERSION = 1;

interface Envelope {
  v: number;
  items: PromptTemplate[];
}

/** ADR 0434 Phase 3 — prompts are subject-scoped: signed in at `<key>:<uid>`,
 *  anonymously at the bare key (where all pre-Phase-3 data already sits).
 *
 *  This key carries the HIGHEST data-loss risk of the four `content` keys: it
 *  is local-ONLY, with no backend counterpart, so a dropped write is
 *  unrecoverable. Hence the subject stamp is checked on read (never show
 *  another user's prompts) and adoption unions rather than replaces. */
const LS_SPEC = STORAGE_KEYS.promptsUser;

function readEnvelope(): PromptTemplate[] {
  const subject = getStorageSubject();
  try {
    const raw = readRaw(scopedSpec(LS_SPEC, subject));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Envelope> & { subject?: string | null };
    if (parsed.v !== LS_VERSION) return [];
    // Pre-Phase-3 payloads have no `subject` field and live at the bare key, so
    // they are anonymous by definition — accept those only when anonymous.
    if ('subject' in parsed && (parsed.subject ?? null) !== subject) return [];
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items;
  } catch {
    return [];
  }
}

function writeEnvelope(items: readonly PromptTemplate[]): void {
  try {
    const env: Envelope & { subject: string | null } = {
      v: LS_VERSION,
      subject: getStorageSubject(),
      items: [...items],
    };
    writeRaw(scopedSpec(LS_SPEC, getStorageSubject()), JSON.stringify(env));
  } catch {
    /* over-quota — silently drop, the UI will surface state via reload */
  }
}

export function listUserPrompts(): PromptTemplate[] {
  return readEnvelope();
}

/** Create or overwrite a user prompt. Returns the persisted entry. */
export function upsertUserPrompt(prompt: PromptTemplate): PromptTemplate {
  const items = readEnvelope();
  const idx = items.findIndex((p) => p.templateId === prompt.templateId);
  if (idx >= 0) items[idx] = prompt;
  else items.unshift(prompt);
  writeEnvelope(items);
  return prompt;
}

export function deleteUserPrompt(templateId: string): void {
  const items = readEnvelope().filter((p) => p.templateId !== templateId);
  writeEnvelope(items);
}

/** `user:` prefix marks a prompt as user-authored. Sample IDs never
 *  use this prefix so a sample with the same slug doesn't collide. */
export function isUserPromptId(templateId: string): boolean {
  return templateId.startsWith('user:');
}

/** Generate a stable templateId from a user-supplied name. Slug-style,
 *  collision-checked against existing entries (appends `-2`, `-3`, …). */
export function suggestUserPromptId(
  name: string,
  existingIds: readonly string[],
): string {
  const base = `user:${slugify(name) || 'prompt'}`;
  if (!existingIds.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Adopt anonymously-authored prompts into `subject`'s scope (ADR 0434 P3, grade
 * fix IDN-1). Lives here rather than in the adoption module because the
 * envelope shape (`{ v, subject, items }`) is this module's business.
 *
 * This key matters more than the others: it is local-ONLY with no backend
 * counterpart, so prompts written before sign-up are otherwise stranded at the
 * anonymous key permanently. Union by `templateId`, signed-in copy wins, and
 * the anonymous source is cleared only after the merged write is confirmed.
 */
export function adoptAnonUserPrompts(subject: string): void {
  const anonSpec = scopedSpec(LS_SPEC, null);
  const raw = readRaw(anonSpec);
  if (!raw) return;
  let anonItems: PromptTemplate[];
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (parsed.v !== LS_VERSION || !Array.isArray(parsed.items)) return;
    anonItems = parsed.items;
  } catch {
    return;
  }
  if (anonItems.length === 0) { removeRaw(anonSpec); return; }

  const userSpec = scopedSpec(LS_SPEC, subject);
  let userItems: PromptTemplate[] = [];
  try {
    const existing = readRaw(userSpec);
    if (existing) {
      const parsed = JSON.parse(existing) as Partial<Envelope>;
      if (parsed.v === LS_VERSION && Array.isArray(parsed.items)) userItems = parsed.items;
    }
  } catch { /* treat as empty */ }

  const byId = new Map<string, PromptTemplate>();
  for (const p of anonItems) byId.set(p.templateId, p);
  for (const p of userItems) byId.set(p.templateId, p); // signed-in wins a collision
  const merged: Envelope & { subject: string | null } = {
    v: LS_VERSION, subject, items: [...byId.values()],
  };
  if (!writeRaw(userSpec, JSON.stringify(merged))) return; // quota — keep the source
  removeRaw(anonSpec);
}
