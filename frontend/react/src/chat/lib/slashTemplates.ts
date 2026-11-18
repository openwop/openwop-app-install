/**
 * Chain templates in the chat `/` picker (the picker-templates ADR; extends
 * ADR 0163 and ADR 0764).
 *
 * The picker lists what the caller OWNS (`workflowMentions.ts`). A chain
 * template is not owned until it is instantiated, so before this a user typing
 * "campaign" was told nothing matched while the gallery held a dozen campaign
 * templates. This module adds the third group, **Templates**, under three rules:
 *
 *  1. **Query-only.** A bare `/` shows no templates; a typed query that matches
 *     shows at most {@link TEMPLATE_ROW_CAP} rows plus one "Browse all
 *     templates…" row.
 *  2. **A template row never runs.** Its apply action is an "open preflight"
 *     intent ({@link slashRowIntent}). `/` only ever dispatches an owned, frozen
 *     definition, and a chain id has none; the shared `TemplatePreflightModal`
 *     collects inputs, connections and the client, then the ONE instantiate path
 *     (`instantiateChain`) mints the owned copy. Test-pinned.
 *  3. **No pick that ends in a 403, no pick that duplicates.** A chain whose
 *     required features are off is left out; without workflow-write the row is
 *     shown disabled ("Ask an admin to add this template"); and when the caller
 *     already owns a copy (`fromChainId` on the ownership summary) the owned
 *     workflow is offered in place of the template.
 *
 * The catalog is the same host-global read the builder gallery uses
 * (`listChainCatalog`), cached at module level and warmed when the picker
 * opens, mirroring the workflow mention cache.
 */
import type { ChainTemplate } from '../../builder/persistence/backendStore.js';
import { listChainCatalog } from '../../workflows/workflowsClient.js';
import type { CommandRegistration } from '../registry/CommandRegistry.js';
import type { WorkflowMentionEntry } from './workflowMentions.js';

/** At most this many template rows, then the "Browse all templates…" row. */
export const TEMPLATE_ROW_CAP = 3;

let catalogCache: ChainTemplate[] = [];
let inflight: Promise<boolean> | null = null;

/** Fetch the chain catalog into the module cache. Resolves `true` on a fresh
 *  read and `false` when it failed (the cache is left as it was: stale but
 *  usable beats empty). Concurrent calls share one request. */
export function refreshChainTemplateCache(): Promise<boolean> {
  if (inflight) return inflight;
  const read = (async (): Promise<boolean> => {
    try {
      catalogCache = await listChainCatalog();
      return true;
    } catch {
      return false;
    }
  })();
  inflight = read;
  // Cleared after the assignment above, never inside the read: a read that
  // fails synchronously would otherwise clear before it was stored, and pin
  // every later refresh to its settled result.
  void read.then(() => { if (inflight === read) inflight = null; });
  return read;
}

/** The cached catalog (empty until the first successful refresh). */
export function listCachedChainTemplates(): readonly ChainTemplate[] {
  return catalogCache;
}

/** One cached template by chain id. */
export function cachedChainTemplate(chainId: string): ChainTemplate | undefined {
  return catalogCache.find((c) => c.chainId === chainId);
}

/** What the picker needs to know about the caller to offer a template. */
export interface TemplateGate {
  /** The caller holds `workspace:write` (the `from-chain` route's gate). */
  canWrite: boolean;
  /** The caller has this feature enabled. */
  featureEnabled: (featureId: string) => boolean;
}

/** True when every toggle-gated feature the chain reads is enabled for the
 *  caller. A chain whose feature is off is not offered at all: it would
 *  instantiate, then fail at its first gated node. */
export function templateAvailable(chain: ChainTemplate, featureEnabled: (featureId: string) => boolean): boolean {
  return (chain.requirements?.requiredFeatures ?? []).every((f) => featureEnabled(f.id));
}

function templateMatches(chain: ChainTemplate, q: string): boolean {
  return chain.label.toLowerCase().includes(q) || chain.chainId.toLowerCase().includes(q);
}

/** One template row in the picker. */
export interface TemplateRowModel {
  chainId: string;
  label: string;
  description: string;
  /** The caller lacks workflow-write: shown, but cannot be picked. */
  disabled: boolean;
}

export interface TemplatePickerGroup {
  /** At most {@link TEMPLATE_ROW_CAP} template rows the caller does not own a copy of. */
  templates: TemplateRowModel[];
  /** Owned copies of matching templates, offered in place of the template row
   *  (the Workflows group lists them, with a "From template" chip). */
  ownedInstead: WorkflowMentionEntry[];
  /** The query matched at least one template, so the group (and its
   *  "Browse all templates…" row) renders. */
  show: boolean;
}

const NO_TEMPLATES: TemplatePickerGroup = { templates: [], ownedInstead: [], show: false };

/** The Templates group for a typed query. Pure, so the picker's rules are
 *  unit-testable without rendering. */
export function buildTemplateGroup(
  catalog: readonly ChainTemplate[],
  owned: readonly WorkflowMentionEntry[],
  query: string,
  gate: TemplateGate,
): TemplatePickerGroup {
  const q = query.trim().toLowerCase();
  if (!q) return NO_TEMPLATES; // a bare `/` shows no templates
  const matched = catalog.filter((c) => templateAvailable(c, gate.featureEnabled) && templateMatches(c, q));
  if (matched.length === 0) return NO_TEMPLATES;
  const templates: TemplateRowModel[] = [];
  const ownedInstead: WorkflowMentionEntry[] = [];
  for (const chain of matched) {
    const mine = owned.find((w) => w.fromChainId === chain.chainId);
    if (mine) {
      if (!ownedInstead.includes(mine)) ownedInstead.push(mine);
      continue;
    }
    if (templates.length < TEMPLATE_ROW_CAP) {
      templates.push({ chainId: chain.chainId, label: chain.label, description: chain.description, disabled: !gate.canWrite });
    }
  }
  return { templates, ownedInstead, show: true };
}

/** A row in the unified `/` menu. */
export type SlashRow =
  | { kind: 'command'; cmd: CommandRegistration }
  | { kind: 'workflow'; wf: WorkflowMentionEntry }
  | { kind: 'template'; tpl: TemplateRowModel }
  | { kind: 'browse-templates'; disabled: boolean };

/** What applying a row does. Only `insert` puts text in the composer, and only
 *  command and owned-workflow rows produce it; the submit path then runs
 *  whatever owned workflow the inserted slug names. */
export type SlashIntent =
  | { kind: 'insert'; text: string }
  | { kind: 'open-preflight'; chainId: string; prefix: string }
  | { kind: 'browse-templates'; prefix: string }
  | { kind: 'none' };

/** The template intents the composer hands to the overlay. */
export type TemplateIntent = Extract<SlashIntent, { kind: 'open-preflight' | 'browse-templates' }>;

/**
 * The apply action for a row, given the leading `@agent ` prefix to keep.
 *
 * INVARIANT: a template row yields `open-preflight`, never `insert`, so a
 * chain id can never reach the composer, and so never reaches the run path.
 * A disabled row yields `none`.
 */
export function slashRowIntent(row: SlashRow, prefix: string): SlashIntent {
  switch (row.kind) {
    case 'command':
      return { kind: 'insert', text: `${prefix}${row.cmd.name} ` };
    case 'workflow':
      return { kind: 'insert', text: `${prefix}/${row.wf.slug} ` };
    case 'template':
      return row.tpl.disabled ? { kind: 'none' } : { kind: 'open-preflight', chainId: row.tpl.chainId, prefix };
    case 'browse-templates':
      return row.disabled ? { kind: 'none' } : { kind: 'browse-templates', prefix };
  }
}
