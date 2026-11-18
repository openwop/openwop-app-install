/**
 * Issue 5911 — a workflow's display name, for every surface that shows one.
 *
 * `workflowName` (roleTemplates.ts) knows only the built-in template ids, so a
 * workflow a person made (`wf.blank.…`, `wf.copy.…`) rendered as its raw id in
 * the inbox's approval rows, the agent drawer and the agent workspace. This reads
 * the caller's own workflows (`GET /workflows`, tenant-scoped on the server) and
 * resolves: the tenant's name, then the built-in name, then a generic "Unnamed
 * workflow". The list is client-scoped (ADR 1132), so another client's workflow is
 * simply absent from it: it reads as unnamed, never as its raw `wf.*` id. Only when
 * the read FAILED (nothing is known) does the id show, as before. Archived workflows
 * are read too: a request for one still names it.
 *
 * The read is LAZY: it happens only once a surface asks for an id that is not a
 * built-in, so a page showing only built-ins (or nothing) costs no request. One read
 * is shared by every surface within a short window. A failed read falls back to the
 * built-in names and is retried on the next mount, never cached.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../i18n/index.js';
import { listWorkflowSummaries } from '../workflows/workflowsClient.js';
import { isKnownWorkflow, workflowName } from './roleTemplates.js';

type Names = ReadonlyMap<string, string>;
const SHARE_MS = 30_000;
let shared: { at: number; names: Promise<Names | null> } | null = null;

/** The caller's own workflow names, read once per short window; null when the read failed. */
export function loadWorkflowNames(read: () => Promise<ReadonlyArray<{ workflowId: string; name?: string }>> = () => listWorkflowSummaries({ includeArchived: true })): Promise<Names | null> {
  if (shared && Date.now() - shared.at < SHARE_MS) return shared.names;
  const names = read().then(
    (rows) => new Map(rows.filter((w) => typeof w.name === 'string' && w.name.trim() !== '').map((w) => [w.workflowId, w.name as string])) as Names,
    () => { shared = null; return null; },
  );
  shared = { at: Date.now(), names };
  return names;
}

/** Test seam. */
export function __resetWorkflowNames(): void { shared = null; }

/** `(workflowId) => display name`: the tenant's name, else the built-in's, else the id. */
export function useWorkflowNames(): (workflowId: string) => string {
  // undefined: not read yet; null: the read failed; a map: the caller's own names.
  const [names, setNames] = useState<Names | null | undefined>(undefined);
  // Set during render when an id needs the tenant's names; the effect below reads it.
  const wanted = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);
  useEffect(() => {
    if (!wanted.current || names !== undefined) return;
    wanted.current = false;
    void loadWorkflowNames().then((n) => { if (!cancelled.current) setNames(n); });
  });
  return useCallback((workflowId: string) => {
    if (!workflowId || isKnownWorkflow(workflowId)) return workflowName(workflowId);
    if (names === undefined) { wanted.current = true; return workflowName(workflowId); }
    if (names === null) return workflowId;
    return names.get(workflowId) ?? i18n.t('common:workflowUnnamed');
  }, [names]);
}
