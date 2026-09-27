/**
 * Human-readable display name for a pack id (display only — the dotted id stays
 * the canonical identifier, shown alongside as a technical sub-line).
 *
 *   core.openwop.a2a               → "A2A"
 *   core.openwop.agent-examples    → "Agent Examples"
 *   core.openwop.agents            → "Agents"
 *   core.openwop.agents.code-reviewer → "Code Reviewer"
 *   feature.crm.nodes              → "CRM Nodes"
 */

// Segments that are namespace scaffolding, not part of the human name.
const NS_PREFIX = new Set(['core', 'feature', 'openwop']);
// Kind tokens dropped only when a specific name follows (…agents.code-reviewer).
const KIND = new Set(['agents', 'nodes']);
// Tokens that read better fully uppercased than title-cased.
const ACRONYMS = new Set([
  'a2a', 'a2ui', 'ai', 'api', 'cad', 'cdp', 'cms', 'crm', 'csm', 'css', 'faq', 'html',
  'http', 'kb', 'llm', 'mcp', 'ocr', 'pdf', 'pii', 'rss', 'scim', 'seo', 'sql', 'sso',
  'stt', 'tts', 'ucp', 'ui', 'ux',
]);

const titleWord = (w: string): string =>
  ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);

export function prettyPackName(packName: string): string {
  const parts = packName.split('.').filter(Boolean);
  let i = 0;
  while (i < parts.length - 1 && NS_PREFIX.has(parts[i] ?? '')) i++;
  if (i < parts.length - 1 && KIND.has(parts[i] ?? '')) i++;
  const words = parts.slice(i).flatMap((p) => p.split(/[-_]/)).filter(Boolean).map(titleWord);
  return words.join(' ') || packName;
}
