/**
 * ADR 0794 — the ONE grammar and the ONE mint for workflow ids.
 *
 *     wf.<origin>.<name>[.<suffix>]
 *
 * `origin` is a closed set recording HOW the workflow came to exist, which never
 * changes after creation. The human name lives in `metadata.name`; an id never
 * follows a retitle.
 *
 * This is the only module allowed to build or pattern-match a workflow id
 * (`workflow-id-grammar.test.ts` is the ratchet). Before it there were five mint
 * sites and two separators (`wf_…` from the builder, `wf.…` from the server), and
 * three chat readers that took the SPELLING for the kind — every server-minted
 * workflow ran with no step count, no step names and no builder link.
 *
 * Pure: `node:crypto` only. It must stay importable from anywhere without a cycle.
 */
import { createHash, randomUUID } from 'node:crypto';

export const WORKFLOW_ID_ORIGINS = ['seed', 'copy', 'blank', 'dup', 'fork', 'sub', 'cadence'] as const;
export type WorkflowIdOrigin = (typeof WORKFLOW_ID_ORIGINS)[number];

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/** 64 random bits. The registry is ONE keyspace for every tenant, so a clash is
 *  a refused save for someone; 32 bits (the old suffix) reaches even odds near
 *  77k ids. Random mints that can check the registry also retry (`mintUnique`). */
const rand16 = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

/** A seeded starter: ONE shared definition per chain, so the id is deterministic
 *  (a re-seed is idempotent by id). In the shared namespace — see below. */
export function seedWorkflowId(chainId: string): string {
  return `wf.seed.${slug(chainId)}`;
}

/** A tenant's own copy of a chain template ("Use template"). Random, so no other
 *  tenant can predict and pre-register it. */
export function copyWorkflowId(chainId: string): string {
  return `wf.copy.${slug(chainId)}.${rand16()}`;
}

/** A workflow started in the builder. No name segment: it has no name yet, and
 *  the id must not change when it gets one (ADR 0794 D4). The browser mints the
 *  same shape (`builder/persistence/workflowId.ts`, parity-tested). */
export function blankWorkflowId(): string {
  return `wf.blank.${rand16()}`;
}

/** A duplicate made in the builder from one of the tenant's own workflows. Minted
 *  in the browser like `blank`; here for the parity test and server callers. */
export function dupWorkflowId(): string {
  return `wf.dup.${rand16()}`;
}

/** A tenant-owned fork of a shared definition. Never in a shared namespace. */
export function forkWorkflowId(sharedId: string): string {
  const name = slug(sharedId.replace(/^(wf\.seed\.|openwop-app\.|walkthrough\.|tmpl\.)/, '')).slice(0, 60) || 'workflow';
  return `wf.fork.${name}.${rand16()}`;
}

/** RFC 0133 §1.3 step 2 — the deterministic, TENANT-SCOPED, version-pinned child
 *  workflow id, keyed on exactly `(tenantId, childChainId, version)`. The string
 *  shape is not wire-normative; the keying, determinism and tenant scope are. */
export function subWorkflowId(tenantId: string, childChainId: string, version: string): string {
  const h = createHash('sha256').update(`${tenantId}\0${childChainId}@${version}`).digest('hex').slice(0, 12);
  return `wf.sub.${slug(childChainId)}.${h}`;
}

/** A tenant's scheduled strategy cadence over `chainId`. Deterministic per tenant. */
export function cadenceWorkflowId(tenantId: string, chainId: string): string {
  const tenant = createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
  return `wf.cadence.${slug(chainId)}.${tenant}`;
}

/** The origin an id was minted with, or null when it is not in this grammar
 *  (`tmpl.*`, `openwop-app.*`, `walkthrough.*` are other families — ADR 0794 D7). */
export function workflowIdOrigin(workflowId: string): WorkflowIdOrigin | null {
  const m = /^wf\.([a-z]+)\./.exec(workflowId);
  const origin = m?.[1];
  return (WORKFLOW_ID_ORIGINS as readonly string[]).includes(origin ?? '') ? (origin as WorkflowIdOrigin) : null;
}

/**
 * What an id IS, for the surfaces that list workflows and must not read the
 * spelling themselves. The walkthroughs page used to filter the caller's
 * workflows with `startsWith('walkthrough.')`; it now reads `kind` off the
 * summary, which the list route stamps from here.
 */
export type WorkflowKind = 'workflow' | 'walkthrough';
export function workflowKind(workflowId: string): WorkflowKind {
  return workflowId.startsWith('walkthrough.') ? 'walkthrough' : 'workflow';
}

/**
 * Reserved PUBLIC workflow-id namespaces (ADR 0163 / M7): seeded chains
 * (`wf.seed.*`), premade templates (`tmpl.*`), and the built-in examples + host
 * system defs (`openwop-app.*`). ONE definition per id is shared by every tenant
 * that owns (or reads) it. Single-sourced (ADR 0788) for the M7 read guard, the
 * collab room guard and the MCP registry. It lives beside the mint (ADR 0794 D2)
 * because it is an AUTHORIZATION rule that depends on the grammar: the two must
 * not be able to drift.
 */
export const PUBLIC_WORKFLOW_ID = /^(wf\.seed\.|tmpl\.|openwop-app\.)/;

/**
 * ADR 0789 — ids whose ONE definition row is shared by every tenant that owns or
 * reads it, so no tenant route may ever write it. The public namespaces above,
 * plus the two seeded demo walkthroughs (`demoWalkthroughsSeed.ts`), named
 * EXACTLY and never as `walkthrough.*`: a tenant's own tours live in the same
 * namespace and are one-owner, tenant-minted ids a prefix would wrongly capture.
 *
 * Why a namespace and not "owned by more than one tenant": the second is a full
 * ownership scan on the 1.5 s autosave path, and it is FALSE for the first tenant
 * ever seeded — exactly the tenant whose write would poison every later seed.
 * Every seeder's ids are test-pinned to this predicate
 * (`seeded-workflow-tenant-isolation.test.ts`).
 */
export const SHARED_WORKFLOW_ID = /^(wf\.seed\.|tmpl\.|openwop-app\.)|^walkthrough\.(campaign-studio\.first-brief|chat\.first-message)$/;
export function isSharedWorkflowId(workflowId: string): boolean {
  return SHARED_WORKFLOW_ID.test(workflowId);
}

/**
 * Origins only the SERVER mints. `sub` and `cadence` are deterministic from the
 * tenant id, and `seed` from the chain id, so a tenant that could CREATE one
 * through a route could register it before its rightful owner does (the pre-squat
 * ADR 0789 closed for `wf.seed.*`). `copy` and `fork` are random, but a client has
 * no business choosing one. A tenant route may still SAVE such an id it already
 * owns — it may never be the first writer.
 */
const SERVER_MINTED: readonly WorkflowIdOrigin[] = ['seed', 'copy', 'fork', 'sub', 'cadence'];
export function isServerMintedWorkflowId(workflowId: string): boolean {
  const origin = workflowIdOrigin(workflowId);
  return origin !== null && SERVER_MINTED.includes(origin);
}

/** Mint with `mint()` until `taken` says the id is free. Random ids make a clash
 *  negligible; this makes it harmless — without it a clash is a refused save that
 *  reads as "workflow not found". Throws after `attempts` (never observed). */
export async function mintUnique(mint: () => string, taken: (id: string) => Promise<boolean>, attempts = 4): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const id = mint();
    if (!(await taken(id))) return id;
  }
  throw new Error('workflow id mint: no free id after retries');
}

/* ── Other workflow-id families (ADR 0794 D7) ─────────────────────────────────
 * Not folded into `wf.` — their spellings are referenced by packs, chains and
 * fixtures. Their MINTS live here so there is one place that builds a workflow
 * id of any family, and the ratchet covers them. Static ids (`tmpl.<category>.
 * <name>`, `openwop-app.<name>`) are declared where they are defined. */

/** A workflow the compose tool drafted for an agent. */
export function composedWorkflowId(): string {
  return `agent-wf-${randomUUID()}`;
}

/** A walkthrough the tour-author tool wrote. Tenant-owned, never shared. */
export function authoredWalkthroughId(): string {
  return `walkthrough.authored.${randomUUID()}`;
}
