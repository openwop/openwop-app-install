/**
 * Pure helpers + types for the builder shell: host-limit fetching,
 * pre-flight capability/limit collection, and advertised-limit
 * formatting. Extracted from BuilderShell.tsx (pure extraction — no
 * behavior change).
 */

import { useEffect, useState } from 'react';
import { getCapabilities } from '../client/runsClient.js';
import { catalogEntry } from './palette/catalogRegistry.js';
import i18n from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

/** Host-advertised engine limits from `capabilities.limits` (RFC 0009 +
 *  RFC 0058). Optional fields are absent when the host doesn't advertise. */
export interface HostLimits {
  envelopesPerTurn?: number;
  clarificationRounds?: number;
  schemaRounds?: number;
  maxNodeExecutions?: number;
  maxRunDurationMs?: number;
  maxLoopIterations?: number;
}

/** Fetch `capabilities.limits` once on mount. `null` while in flight or
 *  if the host omits the block entirely. */
export function useHostLimits(): HostLimits | null {
  const [limits, setLimits] = useState<HostLimits | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((c) => {
        if (cancelled) return;
        // capabilities.limits is REQUIRED in v1, but the optional fields
        // (maxNodeExecutions, maxRunDurationMs, maxLoopIterations) MAY be
        // omitted. We carry the whole block through unchanged.
        const block = (c as { capabilities?: { limits?: HostLimits } }).capabilities?.limits;
        if (block && typeof block === 'object') setLimits(block);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, []);
  return limits;
}

export interface PreflightIssue {
  nodeId: string;
  name: string;
  missing: readonly string[];
}

/** Hard ceilings the workflow shape will breach when the host advertises
 *  them. Stays empty when the host omits the optional limit. RFC 0009 +
 *  RFC 0058: any breach surfaces at run time as `cap.breached` + an
 *  error code (`HOST_CAPABILITY_MISSING` / `run_timeout` / `loop_limit_exceeded`),
 *  so we lift the same check to author time. */
export interface LimitIssue {
  kind: 'maxNodeExecutions';
  advertised: number;
  actual: number;
  message: string;
}

/** Pre-flight: which graph nodes need a host surface the connected host
 *  doesn't advertise? The catalog already cross-references advertised
 *  host surfaces (CapabilitiesPanel / NodePalette), so we read the
 *  per-node `missingHostSurfaces` and flag them before run — catching
 *  HOST_CAPABILITY_MISSING failures at author time (RFC 0009/0011). */
export function collectPreflightIssues(nodes: ReadonlyArray<{ id: string; kind: string; name: string }>): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const n of nodes) {
    const entry = catalogEntry(n.kind);
    const missing = entry?.missingHostSurfaces ?? [];
    if (missing.length > 0) issues.push({ nodeId: n.id, name: n.name, missing });
  }
  return issues;
}

/** Pre-flight: does the workflow's static shape exceed an advertised
 *  engine limit? Today we check `maxNodeExecutions` — a workflow whose
 *  node count already exceeds the per-run ceiling cannot complete even
 *  a single linear pass. Loop / fork dynamics aren't statically
 *  knowable, so this is intentionally conservative — false negatives
 *  on those are acceptable; false positives would be worse. */
export function collectLimitIssues(
  nodes: ReadonlyArray<{ id: string; kind: string }>,
  limits: HostLimits | null,
): LimitIssue[] {
  if (!limits) return [];
  const issues: LimitIssue[] = [];
  // Client-only annotations (sticky notes, etc.) are stripped from the
  // backend definition by `serializeWithIdMap`, so they don't count
  // against the per-run node-execution ceiling.
  const executableCount = nodes.filter((n) => !catalogEntry(n.kind)?.clientOnly).length;
  const cap = limits.maxNodeExecutions;
  if (typeof cap === 'number' && executableCount > cap) {
    issues.push({
      kind: 'maxNodeExecutions',
      advertised: cap,
      actual: executableCount,
      message: i18n.t('builder:limitMaxNodeExecutionsMessage', {
        actual: formatNumber(executableCount),
        cap: formatNumber(cap),
      }),
    });
  }
  return issues;
}

/** Render the optional advertised limits (RFC 0009 + RFC 0058) as a
 *  short, human-readable line so the user knows the ceilings their run
 *  will execute under. Omits any field the host doesn't advertise. */
export function formatAdvertisedLimits(limits: HostLimits | null): string {
  if (!limits) return '';
  const parts: string[] = [];
  if (typeof limits.maxNodeExecutions === 'number') {
    parts.push(i18n.t('builder:limitNodeExecutions', { n: formatNumber(limits.maxNodeExecutions) }));
  }
  if (typeof limits.maxRunDurationMs === 'number') {
    const sec = Math.round(limits.maxRunDurationMs / 1000);
    parts.push(i18n.t('builder:limitWallClock', { seconds: formatNumber(sec) }));
  }
  if (typeof limits.maxLoopIterations === 'number') {
    parts.push(i18n.t('builder:limitLoopIterations', { n: formatNumber(limits.maxLoopIterations) }));
  }
  if (parts.length === 0) return '';
  return i18n.t('builder:hostLimitsInEffect', { parts: parts.join(', ') });
}
