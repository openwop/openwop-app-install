/**
 * ADR 0942 D4 — the autonomy policy frozen into a run at start.
 *
 * `run.metadata.campaignAutonomy` carries the compiled rules inline, so a replay
 * never depends on the policy row surviving. It is reserved (a caller can never
 * supply it), copied verbatim by `:fork`, inherited verbatim by sub-workflow
 * children and re-stamped from the source row on a redrive.
 *
 * `run.metadata.campaignForkPosture = 'attended'` marks a branch fork or a
 * redrive (D10.4): every external-effect class is floored at `approve`, and grants
 * from the source run never cover the new run's effects. It is inherited by
 * children like the stamp.
 *
 * The reader re-validates the stamp and recomputes its hash. A stamp that does
 * not verify is treated as absent, and a bound run with no usable stamp resolves
 * to the fail-closed fallback (`review-everything@1`), never to "no policy".
 *
 * P2b — a run is bound when it carries the ADR 0941 campaign tag OR the ADR 0921
 * campaign-ops client stamp (`openwop-app.campaignOps.orgId`, host-written and
 * reserved). A CLIENT-bound run (no campaign: a multi-campaign client report,
 * lead grading, a journey) freezes the client's default policy, and its stamp
 * carries `orgId` with no `campaignId`.
 */
import { policyHash } from './presets.js';
import { validateRules } from './validate.js';
import { PRESET_IDS, type PresetId, type ResolvedPolicy } from './types.js';
import type { PolicySource } from './store.js';
import type { ResolveFloors } from './resolve.js';

export const AUTONOMY_STAMP_KEY = 'campaignAutonomy';
export const FORK_POSTURE_KEY = 'campaignForkPosture';
/** The ADR 0941 run tag key (owned by campaign-orchestration; read here by shape only). */
const CAMPAIGN_RUN_TAG_KEY = 'campaignOrchestration';
/** The ADR 0921 campaign-ops client stamp key (owned by campaign-ops; read here by shape only). */
const CLIENT_RUN_STAMP_KEY = 'openwop-app.campaignOps';
/** The host-written MCP origin marker (`host/mcpSemantics.ts`). */
const MCP_ORIGIN_SOURCE = 'mcp-server-mount';

export interface FrozenAutonomy {
  v: 1;
  policyId: string;
  version: number;
  name: string;
  basePreset?: PresetId;
  hash: string;
  rules: ResolvedPolicy['rules'];
  source: PolicySource;
  /** Absent on a CLIENT-bound run (P2b): the policy is the client's default. */
  campaignId?: string;
  orgId: string;
  resolvedAt: string;
  /** D10.3: the run was started over the MCP server mount. */
  mcpOrigin?: true;
  /** The run tag named a campaign that does not exist under its org; the fallback applied. */
  dangling?: true;
}

export function buildAutonomyStamp(args: {
  policy: ResolvedPolicy; source: PolicySource; campaignId?: string; orgId: string; resolvedAt: string;
  mcpOrigin?: boolean; dangling?: boolean;
}): FrozenAutonomy {
  const { policy } = args;
  return {
    v: 1,
    policyId: policy.policyId,
    version: policy.version,
    name: policy.name,
    ...(policy.basePreset ? { basePreset: policy.basePreset } : {}),
    hash: policy.hash,
    rules: structuredClone(policy.rules),
    source: args.source,
    ...(args.campaignId ? { campaignId: args.campaignId } : {}),
    orgId: args.orgId,
    resolvedAt: args.resolvedAt,
    ...(args.mcpOrigin ? { mcpOrigin: true as const } : {}),
    ...(args.dangling ? { dangling: true as const } : {}),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A campaign run tag, by shape (ADR 0941 D2b): `campaignId` + `orgId`. */
export function isCampaignBound(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  const tag = metadata?.[CAMPAIGN_RUN_TAG_KEY];
  return isObj(tag) && typeof tag.campaignId === 'string' && tag.campaignId.length > 0 && typeof tag.orgId === 'string' && tag.orgId.length > 0;
}

/** P2b — the campaign-ops client stamp's org, by shape (ADR 0921 D3): the run acts for that client. */
export function clientBoundOrg(metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  const stamp = metadata?.[CLIENT_RUN_STAMP_KEY];
  return isObj(stamp) && typeof stamp.orgId === 'string' && stamp.orgId.length > 0 ? stamp.orgId : null;
}

/** The gate and effect chokepoints share one client-scope check. A corrupt
 * host stamp cannot ask approvers from a different org or become tenant-wide. */
export function autonomyOrgOf(raw: unknown, stamp: FrozenAutonomy | null): string | null {
  const metadata = isObj(raw) ? raw : {};
  const tag = isObj(metadata[CAMPAIGN_RUN_TAG_KEY]) ? metadata[CAMPAIGN_RUN_TAG_KEY] : null;
  const clientOrg = clientBoundOrg(metadata);
  if ((metadata[CAMPAIGN_RUN_TAG_KEY] !== undefined && !isCampaignBound(metadata))
    || (metadata[CLIENT_RUN_STAMP_KEY] !== undefined && clientOrg === null)) return null;
  const orgs = [stamp?.orgId, tag?.orgId, clientOrg]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const org = orgs[0];
  return org && orgs.every(value => value === org) && metadata.approverOrgId === org ? org : null;
}

/** Parse + verify a stamp. `null` when absent, malformed, or its hash does not match its rules. */
export function parseAutonomyStamp(raw: unknown): { stamp: FrozenAutonomy; policy: ResolvedPolicy } | { stamp: null; reason: 'absent' | 'malformed' | 'hash_mismatch' } {
  if (raw === undefined) return { stamp: null, reason: 'absent' };
  if (!isObj(raw) || raw.v !== 1 || typeof raw.policyId !== 'string' || typeof raw.version !== 'number' || typeof raw.hash !== 'string'
    || (raw.campaignId !== undefined && (typeof raw.campaignId !== 'string' || raw.campaignId.length === 0))
    || typeof raw.orgId !== 'string' || raw.orgId.length === 0) {
    return { stamp: null, reason: 'malformed' };
  }
  if (raw.basePreset !== undefined && !(PRESET_IDS as readonly unknown[]).includes(raw.basePreset)) return { stamp: null, reason: 'malformed' };
  let rules: ResolvedPolicy['rules'];
  try {
    rules = validateRules(raw.rules);
  } catch {
    return { stamp: null, reason: 'malformed' };
  }
  const basePreset = raw.basePreset as PresetId | undefined;
  if (policyHash(basePreset, rules) !== raw.hash) return { stamp: null, reason: 'hash_mismatch' };
  const source: PolicySource = raw.source === 'campaign' || raw.source === 'client' ? raw.source : 'default';
  // Rebuilt from validated fields only: nothing unverified rides along.
  const stamp: FrozenAutonomy = {
    v: 1,
    policyId: raw.policyId,
    version: raw.version,
    name: typeof raw.name === 'string' ? raw.name : raw.policyId,
    ...(basePreset ? { basePreset } : {}),
    hash: raw.hash,
    rules,
    source,
    ...(typeof raw.campaignId === 'string' ? { campaignId: raw.campaignId } : {}),
    orgId: raw.orgId,
    resolvedAt: typeof raw.resolvedAt === 'string' ? raw.resolvedAt : '',
    ...(raw.mcpOrigin === true ? { mcpOrigin: true as const } : {}),
    ...(raw.dangling === true ? { dangling: true as const } : {}),
  };
  return {
    stamp,
    policy: { policyId: stamp.policyId, version: stamp.version, name: stamp.name, ...(basePreset ? { basePreset } : {}), rules, hash: stamp.hash },
  };
}

export interface RunAutonomy {
  /** The run belongs to a campaign or a client (the run tag, the client stamp, or an autonomy stamp). Unbound ⇒ no policy applies. */
  bound: boolean;
  /** The frozen policy; `null` on a bound run ⇒ the resolver's fail-closed fallback. */
  policy: ResolvedPolicy | null;
  /** D10.3/D10.4 floors that come from the run itself. */
  floors: Pick<ResolveFloors, 'mcpOrigin' | 'forkPosture'>;
  /** Why `policy` is null on a bound run. */
  reason?: 'absent' | 'malformed' | 'hash_mismatch';
  stamp: FrozenAutonomy | null;
}

/**
 * What a gate or chokepoint needs from a run (P2/P3). Reads only host-written
 * state: the reserved stamp and posture, the fork route's `forkMode`, and the MCP
 * constructor's `source`. Live `forkMode` backs up the stamped posture for a fork
 * whose contributor failed (contributors are fail-soft).
 */
export function runAutonomyOf(run: { metadata?: unknown; forkMode?: 'replay' | 'branch' }): RunAutonomy {
  const metadata = isObj(run.metadata) ? run.metadata : {};
  const parsed = parseAutonomyStamp(metadata[AUTONOMY_STAMP_KEY]);
  // Malformed host-owned scope is still bound: corruption cannot downgrade an
  // enabled policy gate to legacy. decideGate refuses unresolved/conflicting orgs.
  const bound = metadata[CAMPAIGN_RUN_TAG_KEY] !== undefined || metadata[CLIENT_RUN_STAMP_KEY] !== undefined || metadata[AUTONOMY_STAMP_KEY] !== undefined;
  const mcpOrigin = (parsed.stamp?.mcpOrigin === true) || metadata.source === MCP_ORIGIN_SOURCE;
  const attended = metadata[FORK_POSTURE_KEY] === 'attended' || run.forkMode === 'branch';
  return {
    bound,
    policy: parsed.stamp ? parsed.policy : null,
    floors: { ...(mcpOrigin ? { mcpOrigin: true } : {}), ...(attended ? { forkPosture: 'attended' as const } : {}) },
    ...(parsed.stamp ? {} : { reason: parsed.reason }),
    stamp: parsed.stamp,
  };
}
