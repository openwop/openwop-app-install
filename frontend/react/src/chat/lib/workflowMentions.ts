/**
 * Workflow @-mention catalog for the chat input.
 *
 * Sources (deduped by `workflowId`, backend-first):
 *   - Hardcoded sample workflows (demo mode only — so mentions work
 *     without any builder-saved entries).
 *   - The caller's REAL backend-owned workflows (the ADR 0163 per-tenant
 *     ownership index, `GET /v1/host/openwop-app/workflows`). These are the
 *     source of truth — durable, multi-device, assignable. The index is
 *     async, so it's fetched into a module-level cache by
 *     {@link refreshWorkflowMentionCache} (warmed on composer mount + on
 *     picker-open) and merged here synchronously, mirroring the
 *     `agentMentions.ts` async-cache-feeds-sync-picker precedent.
 *   - Every localStorage-saved workflow with ≥1 node NOT already covered by
 *     the backend index (offline drafts / pre-migration legacy). The backend
 *     entry wins on collision since `backendStore.saveWorkflow` write-through
 *     keeps both copies under the same id.
 *
 * The chat input's `@` autocomplete renders one entry per workflow,
 * filters by `displayName` substring, and inserts the entry's `slug`
 * into the prompt (e.g. `@hello-uppercase `). The slug is a stable,
 * whitespace-free token the LLM sees in the user's message; if the
 * Tools toggle is on, the matching `toolName` is also advertised in
 * the run's `inputs.tools` list so the LLM can invoke the workflow
 * via `tool_use` when it decides to act on the mention.
 *
 * Slug collisions (two workflows with names that slugify identically)
 * resolve by appending `-2`, `-3`, … in the order returned.
 */

import i18n from '../../i18n/index.js';
import { listSavedWorkflows } from '../../builder/persistence/localStore.js';
import { listWorkflowSummaries } from '../../workflows/workflowsClient.js';
import { demoModeCached } from '../../client/demoMode.js';

export interface WorkflowMentionEntry {
  /** Human-readable name shown in the popover row. */
  displayName: string;
  /** Whitespace-free token inserted after `@`. Stable across renders
   *  for the same workflow id. */
  slug: string;
  /** One-line description shown under the name in the popover. */
  description: string;
  /** Anthropic-safe tool name matching `buildAvailableTools()` output. */
  toolName: string;
  /** OpenWOP workflow id the backend dispatches when the LLM calls the tool. */
  workflowId: string;
}

interface ExampleSource {
  displayName: string;
  description: string;
  workflowId: string;
}

/** Built lazily (not as a module-level const) so the i18n strings resolve
 *  against the ACTIVE locale at call time, not whatever locale was active at
 *  module-load. */
function exampleSources(): ExampleSource[] {
  return [
    {
      displayName: i18n.t('chat:exampleWorkflowName'),
      description: i18n.t('chat:exampleWorkflowDescription'),
      workflowId: 'openwop-app.uppercase',
    },
  ];
}

/** The caller's backend-owned workflows, cached for the SYNC picker.
 *  Populated by {@link refreshWorkflowMentionCache}; empty until the first
 *  successful fetch (so the picker degrades to demo + localStorage exactly
 *  as before — fail-safe). */
let backendWorkflowCache: { id: string; name: string; nodeCount: number }[] = [];

/** Fetch the caller's tenant-scoped owned workflows into the module cache so
 *  the sync {@link listWorkflowMentions} can include them. Best-effort: on any
 *  error the cache is left as-is (stale-but-usable beats empty). Warmed on
 *  composer mount + when the `/` picker opens; safe to call repeatedly. */
export async function refreshWorkflowMentionCache(): Promise<void> {
  try {
    const rows = await listWorkflowSummaries();
    backendWorkflowCache = rows.map((r) => ({ id: r.workflowId, name: r.name, nodeCount: r.nodeCount }));
  } catch {
    /* leave the cache untouched — backend down ⇒ demo + localStorage only */
  }
}

export function listWorkflowMentions(): WorkflowMentionEntry[] {
  const out: WorkflowMentionEntry[] = [];
  const usedSlugs = new Set<string>();
  const seenIds = new Set<string>();

  function push(displayName: string, description: string, workflowId: string): void {
    // Cloned templates carry " (from template)" — strip from the slug so
    // the `@mention` token stays short. Keep displayName so users can tell
    // which workflow originated from a template.
    const slugSource = displayName.replace(/\s*\(from template\)\s*$/i, '');
    const baseSlug = slugify(slugSource);
    let slug = baseSlug;
    let n = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${n++}`;
    }
    usedSlugs.add(slug);
    seenIds.add(workflowId);
    out.push({
      displayName,
      slug,
      description,
      toolName: sanitizeToolName(workflowId),
      workflowId,
    });
  }

  // Built-in sample workflows are demo scaffolding — show them only on the
  // public showcase deployment, never on a clean / white-label install.
  if (demoModeCached()) {
    for (const s of exampleSources()) {
      push(s.displayName, s.description, s.workflowId);
    }
  }
  // The caller's REAL owned workflows (backend ownership index) — the SoT,
  // listed ahead of local drafts so the durable copy wins on a collision.
  for (const wf of backendWorkflowCache) {
    if (seenIds.has(wf.id)) continue;
    push(wf.name, i18n.t('chat:workflowNodeCount', { count: wf.nodeCount }), wf.id);
  }
  // localStorage drafts NOT already covered by the backend index (offline /
  // pre-migration legacy). Skip any id the backend index already surfaced.
  for (const wf of listSavedWorkflows()) {
    if (wf.nodes.length === 0 || seenIds.has(wf.id)) continue;
    const steps = wf.nodes.map((n) => n.name).join(' → ');
    push(wf.name, i18n.t('chat:workflowNodeSummary', { count: wf.nodes.length, steps }), wf.id);
  }
  return out;
}

/** Returns the matched mention plus any trailing text the user typed
 *  after the `@<slug>` token. When `trailing` is non-empty, the chat
 *  dispatcher uses it to override the workflow's default first input
 *  field — so `@hello-uppercase hello` runs the workflow with
 *  `inputs.text = "hello"` instead of the template's default.
 *
 *  `null` means "this message isn't a workflow trigger" and the
 *  message routes through the normal LLM path. */
export interface MentionMatch {
  entry: WorkflowMentionEntry;
  /** Text after the `@<slug>` token; null when the message is a bare
   *  mention. Whitespace-only trailing strings collapse to null. */
  trailing: string | null;
}

export function detectMention(text: string): MentionMatch | null {
  const stripped = text.trim();
  // Capture the slug, then optionally capture everything after one or
  // more spaces. Examples that match:
  //   "@hello-uppercase"            → trailing: null
  //   "@hello-uppercase hello"      → trailing: "hello"
  //   "@hello-uppercase  hi there"  → trailing: "hi there"
  const match = /^@([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/i.exec(stripped);
  if (!match) return null;
  const slug = match[1]?.toLowerCase() ?? '';
  const entry = listWorkflowMentions().find((e) => e.slug === slug);
  if (!entry) return null;
  const trailingRaw = (match[2] ?? '').trim();
  return { entry, trailing: trailingRaw.length > 0 ? trailingRaw : null };
}

/** Slash-prefixed workflow dispatch — the new canonical syntax as of
 *  the 2026-05-28 mention-symbol swap (`@` moves to agents, `/` becomes
 *  the unified menu for built-in commands AND workflows). Mirrors
 *  `detectMention` but on `^/slug` instead of `^@slug`.
 *
 *  Order of checks at the submit site: `findCommand(text)` first
 *  (built-in commands take precedence so a workflow can never shadow
 *  `/clear`), then this; otherwise the message routes through the
 *  normal LLM send. */
export function detectWorkflowSlashMention(text: string): MentionMatch | null {
  const stripped = text.trim();
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/i.exec(stripped);
  if (!match) return null;
  const slug = match[1]?.toLowerCase() ?? '';
  const entry = listWorkflowMentions().find((e) => e.slug === slug);
  if (!entry) return null;
  const trailingRaw = (match[2] ?? '').trim();
  return { entry, trailing: trailingRaw.length > 0 ? trailingRaw : null };
}

/** Where the `/` command+workflow picker should trigger, given the raw composer
 *  text, and with what query. Supports an OPTIONAL leading `@agent ` hand-off
 *  prefix, so "@devon /upp" still opens the picker (the prefix is preserved when
 *  a row is applied) — fixing the bug where a `/` after an `@mention` showed
 *  nothing. Returns null when no slash token is active at the trailing position
 *  (e.g. a space after the query → "args mode", which hides the picker). */
export interface SlashTrigger {
  /** The leading `@agent ` text to preserve on apply (empty when none). */
  prefix: string;
  /** The text typed after the `/` (may be empty for a bare `/`). */
  query: string;
}
export function detectSlashTrigger(text: string): SlashTrigger | null {
  // optional "@slug " hand-off, then "/", then a no-space query to end-of-input.
  const m = /^(@[a-z0-9][a-z0-9-]*\s+)?\/(\S*)$/i.exec(text.trimStart());
  if (!m) return null;
  return { prefix: m[1] ?? '', query: m[2] ?? '' };
}

/** Back-compat wrapper for any caller that only wants the bare-mention
 *  signal. Returns the entry only when there's no trailing text. */
export function detectBareMention(text: string): WorkflowMentionEntry | null {
  const m = detectMention(text);
  return m && m.trailing === null ? m.entry : null;
}

/** Case-insensitive substring filter on `displayName`. Returns input
 *  order so the sample sources stay pinned to the top. */
export function filterMentions(
  entries: ReadonlyArray<WorkflowMentionEntry>,
  query: string,
): WorkflowMentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.displayName.toLowerCase().includes(q));
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'workflow';
}

function sanitizeToolName(id: string): string {
  // Mirrors availableTools.sanitizeToolName so the slug-inserted
  // mention text aligns with the tool name passed to the LLM.
  return `wf_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}
