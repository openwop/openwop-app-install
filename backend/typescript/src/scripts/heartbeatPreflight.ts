/**
 * Heartbeat activation pre-flight (ADR 0313 blast-radius enumerator).
 *
 * READ-ONLY. Reproduces the EXACT card-selection + autonomy-policy logic of
 * `heartbeatService.runHeartbeatOnce` (same `resolveAgentPolicy` /
 * `resolveConnectionReadiness` / `getAgentProfile` / `autonomyOf` /
 * `effectiveHeartbeatIntervalMs`), but instead of dispatching it CLASSIFIES each
 * armed To Do card as **would-auto-run** vs **would-propose** — so an operator
 * can see precisely what flipping `OPENWOP_HEARTBEAT_DEFAULT_MS` on would execute
 * without a human, BEFORE flipping it. Never calls `startWorkflowRun` /
 * `createApproval` / any write.
 *
 * See docs/research/heartbeat-activation-preflight.md for the predicate + safe
 * activation procedure.
 *
 * Usage (via tsx, like `npm run seed:tenant`):
 *   OPENWOP_HEARTBEAT_DEFAULT_MS=600000 OPENWOP_STORAGE_DSN=<dsn> \
 *     npm run heartbeat:preflight -- [--tenant <id>] [--json]
 *
 * Against prod, tunnel the DSN with cloud-sql-proxy first and point
 * OPENWOP_STORAGE_DSN at 127.0.0.1 (see CLAUDE.md / the prod-superadmin memory).
 * Set OPENWOP_HEARTBEAT_DEFAULT_MS to the value you INTEND to activate with, so
 * the effective-cadence resolution matches what activation would compute (absent
 * ⇒ the built-in 10-min default; `0` ⇒ still opt-in, so nothing enrolls).
 *
 * Flags:
 *   --tenant <id>   only this tenant (else ALL tenants with a roster)
 *   --json          machine-readable output (else a human summary)
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { initHostExtPersistence } from '../host/hostExtPersistence.js';
import { openStorage } from '../storage/index.js';
import { initInMemorySurfaces } from '../host/inMemorySurfaces.js';
import { configureSecretResolver } from '../byok/secretResolver.js';
import { BACKEND_FEATURES } from '../features/index.js';
import { registerToggleDefault } from '../host/featureToggles/registry.js';
import { listRoster, listRosterTenants, autonomyOf } from '../host/rosterService.js';
import {
  effectiveHeartbeatIntervalMs,
  resolveHeartbeatAdminConfig,
  agentTurnFallback,
} from '../host/heartbeatService.js';
import { listBoardsForSubject, listCards } from '../host/kanbanService.js';
import { resolveConnectionReadiness } from '../host/connectionReadiness.js';
import { resolveAgentPolicy } from '../host/agentPolicyResolver.js';
import { getAgentProfile } from '../host/agentProfileService.js';

interface Hit {
  tenantId: string;
  rosterId: string;
  persona: string;
  autonomy: 'auto' | 'guided' | 'review';
  boardId: string;
  cardId: string;
  cardTitle: string;
  priority: string;
  workflowId: string;
  verdict: string;
}

interface Args { tenant?: string; json: boolean }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dsn = process.env.OPENWOP_STORAGE_DSN ?? 'memory://';

  // Boot the minimum the selection path needs — host-ext persistence + in-memory
  // surfaces + the compiled toggle defaults (so gated reads resolve as at app boot).
  const storage = await openStorage(dsn);
  const dataDir = dsn.startsWith('sqlite://') ? dirname(resolvePath(dsn.slice('sqlite://'.length))) : resolvePath('./data');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir });
  configureSecretResolver({ storage, dataDir });
  for (const feature of BACKEND_FEATURES) {
    if (feature.toggleDefault) registerToggleDefault(feature.toggleDefault);
  }

  const admin = await resolveHeartbeatAdminConfig();
  const fallbackRegistered = agentTurnFallback() !== null;
  const tenants = args.tenant ? [args.tenant] : await listRosterTenants();

  const autoRun: Hit[] = [];
  const propose: Hit[] = [];
  let enrolledMembers = 0;
  let membersOff = 0;

  for (const tenantId of tenants) {
    for (const entry of await listRoster(tenantId)) {
      if (!entry.enabled) continue;
      // Exactly the activation gate: absent/0 → host default (enrolled); -1 → off.
      if (effectiveHeartbeatIntervalMs(entry, admin) <= 0) { membersOff += 1; continue; }
      enrolledMembers += 1;

      const autonomy = autonomyOf(entry);
      const boards = await listBoardsForSubject(tenantId, { kind: 'agent', id: entry.rosterId });
      for (const board of boards) {
        const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do');
        if (!todo) continue;
        const cards = (await listCards(board.id)).filter((c) => c.columnId === todo.id);
        for (const card of cards) {
          // Mirror runHeartbeatOnce: armed = card/column workflow; else the D2 bare
          // fallback (ALWAYS proposes — safe). Skip unarmed cards when no fallback.
          const explicitWorkflowId = card.workflowId ?? todo.triggerWorkflowId;
          const isBareFallback = !explicitWorkflowId;
          const workflowId = explicitWorkflowId ?? (fallbackRegistered ? '(agent-turn fallback)' : undefined);
          if (!workflowId) continue; // unarmed + no fallback ⇒ heartbeat skips it entirely

          // The SAME policy chain the daemon uses — agentProfile never/hitl/allowlist +
          // connection readiness — so the classification can't drift from real behavior.
          const readiness = await resolveConnectionReadiness(tenantId, entry.rosterId);
          const profile = await getAgentProfile(tenantId, entry.rosterId);
          const policy = resolveAgentPolicy({ profile, actionClass: explicitWorkflowId ?? workflowId, level: autonomy, readiness });
          if (policy.verdict === 'deny') continue; // permissions.never ⇒ neither runs nor proposes

          const mustPropose = isBareFallback || policy.verdict === 'review' || (policy.verdict === 'guided' && card.priority === 'high');
          const hit: Hit = {
            tenantId, rosterId: entry.rosterId, persona: entry.persona, autonomy,
            boardId: board.id, cardId: card.id, cardTitle: card.title,
            priority: card.priority ?? 'normal', workflowId, verdict: policy.verdict,
          };
          (mustPropose ? propose : autoRun).push(hit);
        }
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      dsn: dsn.split('@').pop() ?? dsn,
      heartbeatDefaultMs: process.env.OPENWOP_HEARTBEAT_DEFAULT_MS ?? '(absent ⇒ built-in 10-min default)',
      fallbackRegistered,
      tenants: tenants.length,
      enrolledMembers, membersOff,
      wouldAutoRun: autoRun, wouldPropose: propose.length,
    }, null, 2) + '\n');
  } else {
    const line = (h: Hit): string => `    [${h.autonomy}/${h.verdict}] ${h.persona} — "${h.cardTitle}" (${h.priority}) → ${h.workflowId}  ${h.tenantId}`;
    process.stdout.write(`Heartbeat pre-flight — ${dsn.split('@').pop() ?? dsn}\n`);
    process.stdout.write(`  activation value: OPENWOP_HEARTBEAT_DEFAULT_MS=${process.env.OPENWOP_HEARTBEAT_DEFAULT_MS ?? '(absent ⇒ 10-min default)'}\n`);
    process.stdout.write(`  tenants scanned: ${tenants.length} · enrolled members: ${enrolledMembers} · off (-1): ${membersOff} · fallback registered: ${fallbackRegistered}\n\n`);
    process.stdout.write(`  WOULD AUTO-RUN at activation (no human): ${autoRun.length}\n`);
    for (const h of autoRun) process.stdout.write(line(h) + '\n');
    process.stdout.write(`\n  would propose (safe — awaits approval): ${propose.length}\n`);
    if (autoRun.length === 0) process.stdout.write(`\n  ✓ Nothing auto-runs. Activation is a non-event for armed cards.\n`);
    else process.stdout.write(`\n  ⚠ ${autoRun.length} card(s) auto-execute within one interval (bounded by the 120/hr budget). Set those agents to review/guided (or heartbeatIntervalMs=-1) first if unwanted.\n`);
  }
}

void main().catch((err) => {
  process.stderr.write(`heartbeat-preflight failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
