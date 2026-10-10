/**
 * ADR 0768 follow-up B4 — what a conversation drew on, from what the client
 * already holds (no server read): the web sources its turns CITED
 * (`meta.citations`, de-duplicated by URL, with how many turns cited each) and
 * the files the user SENT (attachments on user turns). Nothing is inferred: a
 * source appears only because a turn recorded it.
 */
import type { ChatMessage, ContentPart } from '../types.js';

export interface WebSource { url: string; title?: string; snippet?: string; turns: number }
export interface FileSource { name: string; mimeType: string; url?: string }
export interface ConversationSources { web: WebSource[]; files: FileSource[]; key: string }

export const EMPTY_SOURCES: ConversationSources = { web: [], files: [], key: '' };

export function collectSources(messages: readonly ChatMessage[]): ConversationSources {
  const web = new Map<string, WebSource>();
  const files: FileSource[] = [];
  const seenFiles = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      const cited = new Set<string>();
      for (const c of m.meta?.citations ?? []) {
        if (!c.url || cited.has(c.url)) continue; // count a URL once per turn
        cited.add(c.url);
        const prev = web.get(c.url);
        if (prev) prev.turns += 1;
        else web.set(c.url, { url: c.url, ...(c.title ? { title: c.title } : {}), ...(c.snippet ? { snippet: c.snippet } : {}), turns: 1 });
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const p of m.content as readonly ContentPart[]) {
        if (p.type !== 'file' && p.type !== 'image') continue;
        const name = p.type === 'file' ? (p.name ?? '') : (p.alt ?? '');
        const id = `${p.type}:${name}:${p.url ?? ''}`;
        if (seenFiles.has(id)) continue;
        seenFiles.add(id);
        files.push({ name, mimeType: p.mimeType, ...(p.url ? { url: p.url } : {}) });
      }
    }
  }
  const webList = [...web.values()];
  const key = `${webList.map((w) => `${w.url}#${w.turns}`).join('|')}::${files.map((f) => `${f.name}@${f.url ?? ''}`).join('|')}`;
  return { web: webList, files, key };
}

/** How many distinct sources the tab would list. */
export const sourceCount = (s: ConversationSources): number => s.web.length + s.files.length;
