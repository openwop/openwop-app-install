/**
 * localStorage CRUD for SavedWorkflow records. Keyed under
 * `openwop-app.builder.workflows` as a single JSON object
 * `{ [workflowId]: SavedWorkflow }`. Quota failures swallow silently.
 */

import type { SavedWorkflow } from '../schema/workflow.js';
import i18n from '../../i18n/index.js';
import {
  STORAGE_KEYS, getStorageSubject, readRaw, scopedSpec, writeScoped,
  type ScopedEnvelope,
} from '../../platform/storage.js';

const LS_MIGRATION_STRIPPED_FROM_TEMPLATE_SUFFIX = 'openwop-app.builder.workflows.migration.stripFromTemplate';
const LS_MIGRATION_MOCK_AI_TO_CHAT = 'openwop-app.builder.workflows.migration.mockAiToChat';

type Index = Record<string, SavedWorkflow>;

/** ADR 0434 Phase 3 — draft workflows are subject-scoped. Signed in they live
 *  at `<key>:<uid>`; anonymously they stay at the bare key, which is where all
 *  pre-Phase-3 data already sits (so nothing needs migrating). Both the raw
 *  legacy shape and the versioned envelope are accepted on read; writes
 *  normalize to the envelope. */
const LS_SPEC = STORAGE_KEYS.builderWorkflows;
const LS_VERSION = 1;

function isIndex(v: unknown): v is Index {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readIndex(): Index {
  const subject = getStorageSubject();
  try {
    const raw = readRaw(scopedSpec(LS_SPEC, subject));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Envelope (post-Phase-3 write) — honor its subject stamp.
    const env = parsed as Partial<ScopedEnvelope<unknown>>;
    if (isIndex(parsed) && 'v' in env && 'data' in env) {
      if (env.v !== LS_VERSION) return {};
      if ((env.subject ?? null) !== subject) return {}; // never another user's drafts
      return isIndex(env.data) ? env.data : {};
    }
    // Legacy raw index (pre-Phase-3, anonymous by definition).
    return isIndex(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Returns true iff the index was actually persisted. The boolean lets the
 *  one-time migrations avoid marking themselves complete when the write
 *  silently failed (quota/disabled) — otherwise the flag would be set on
 *  un-migrated data and the migration would never re-run (BLD-5). */
function writeIndex(idx: Index): boolean {
  try {
    if (!writeScoped(LS_SPEC, getStorageSubject(), LS_VERSION, idx)) {
      throw new Error('quota or storage unavailable');
    }
    return true;
  } catch (err) {
    // Quota exceeded (or storage disabled). The current session keeps
    // working from zustand state, but the workflow won't survive a
    // page reload. Warn so dev iterations notice instead of silently
    // losing work.
    console.warn('[openwop-builder] workflow persist failed:', err);
    return false;
  }
}

export function listSavedWorkflows(): SavedWorkflow[] {
  // One-time migration: strip trailing " (from template)" from names
  // of workflows seeded under the older clone behavior. The current
  // `cloneTemplateToUserWorkflow` no longer appends the suffix, but
  // existing localStorage entries from previous app versions still
  // carry it. Migrate once + flag so we don't churn writes on every
  // read. Pure rename — workflow ids + behavior unchanged.
  stripFromTemplateSuffixMigration();
  mockAiToChatMigration();
  return Object.values(readIndex()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// One-time migration: rewrite legacy `mock-ai` nodes to `chat`. The
// real-LLM-by-default pivot (2026-05-23) replaced the deterministic
// mock node with the chat-responder, which defaults to the managed
// `openwop-free` tile when no credentialRef is set. Saved workflows
// from the previous templates still carry `kind: 'mock-ai'`, which the
// catalog no longer surfaces — leaving them un-renamed produces a
// "Unknown node kind" error on save. Pure kind rename + drop any
// stale `*PromptRef` config that was mock-specific.
function mockAiToChatMigration(): void {
  try {
    if (localStorage.getItem(LS_MIGRATION_MOCK_AI_TO_CHAT) === '1') return;
  } catch { return; }
  const idx = readIndex();
  let mutated = false;
  for (const id of Object.keys(idx)) {
    const wf = idx[id];
    if (!wf) continue;
    let nodesMutated = false;
    const newNodes = wf.nodes.map((n) => {
      if (n.kind !== 'mock-ai') return n;
      nodesMutated = true;
      return { ...n, kind: 'chat' };
    });
    if (nodesMutated) {
      idx[id] = { ...wf, nodes: newNodes };
      mutated = true;
    }
  }
  // Only mark the migration done if there was nothing to persist OR the write
  // actually succeeded — otherwise re-run next load against the un-migrated data
  // (the rename is idempotent, so re-running is safe) (BLD-5).
  if (!mutated || writeIndex(idx)) {
    try { localStorage.setItem(LS_MIGRATION_MOCK_AI_TO_CHAT, '1'); } catch { /* ignore */ }
  }
}

function stripFromTemplateSuffixMigration(): void {
  try {
    if (localStorage.getItem(LS_MIGRATION_STRIPPED_FROM_TEMPLATE_SUFFIX) === '1') return;
  } catch { return; }
  const idx = readIndex();
  let mutated = false;
  for (const id of Object.keys(idx)) {
    const wf = idx[id];
    if (!wf) continue;
    const stripped = wf.name.replace(/\s*\(from template\)\s*$/i, '');
    if (stripped !== wf.name) {
      idx[id] = { ...wf, name: stripped };
      mutated = true;
    }
  }
  // Same crash-safety as the mock-ai migration: don't flag complete if the
  // persist silently failed (BLD-5). The suffix strip is idempotent.
  if (!mutated || writeIndex(idx)) {
    try { localStorage.setItem(LS_MIGRATION_STRIPPED_FROM_TEMPLATE_SUFFIX, '1'); } catch { /* ignore */ }
  }
}

export function getSavedWorkflow(id: string): SavedWorkflow | undefined {
  return readIndex()[id];
}

export function upsertSavedWorkflow(wf: SavedWorkflow): void {
  const idx = readIndex();
  idx[wf.id] = wf;
  writeIndex(idx);
}

export function deleteSavedWorkflow(id: string): void {
  const idx = readIndex();
  delete idx[id];
  writeIndex(idx);
}

export function newWorkflowId(): string {
  return `wf_${crypto.randomUUID().slice(0, 8)}`;
}

export function renameSavedWorkflow(id: string, name: string): void {
  const idx = readIndex();
  const wf = idx[id];
  if (!wf) return;
  idx[id] = { ...wf, name, updatedAt: new Date().toISOString() };
  writeIndex(idx);
}

export function duplicateSavedWorkflow(id: string): SavedWorkflow | undefined {
  const idx = readIndex();
  const src = idx[id];
  if (!src) return undefined;
  const now = new Date().toISOString();
  const copy: SavedWorkflow = {
    ...src,
    id: newWorkflowId(),
    name: i18n.t('builder:workflowNameSuffixCopy', { name: src.name }),
    createdAt: now,
    updatedAt: now,
  };
  idx[copy.id] = copy;
  writeIndex(idx);
  return copy;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'workflow';
}

export function exportSavedWorkflowAsJSON(
  id: string,
): { filename: string; blob: Blob } | undefined {
  const wf = getSavedWorkflow(id);
  if (!wf) return undefined;
  const filename = `${slugify(wf.name)}-${wf.id}.json`;
  const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
  return { filename, blob };
}
