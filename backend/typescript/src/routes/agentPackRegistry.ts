/**
 * Agent-pack registry browser — host-extension surface backing
 * the Agents-tab "Install from registry" flow (phase E3, 2026-05-28).
 *
 * Endpoints:
 *   GET  /v1/host/openwop-app/registry/agent-packs
 *     → list known agent packs + whether each is currently installed
 *       in this host's AgentRegistry (i.e. any of its agents are
 *       registered).
 *   POST /v1/host/openwop-app/registry/agent-packs/install
 *     → body: { name, version? } — fetch + verify + register via the
 *       existing `installPackFromRegistry` machinery. No-ops cleanly
 *       when the pack is already installed.
 *
 * "Known" comes from scanning the local packs/ directory for entries
 * matching `core.openwop.agents.*`. A future iteration could query the
 * public registry catalog directly, but the local scan covers the
 * sample's typical case and avoids tying this surface to a registry
 * fetch on every page load.
 */

import type { Express } from 'express';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenwopError } from '../types.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { assertInstallable, installFromConfiguredRegistry } from '../packs/installLane.js';
import { isSuperadmin, requireSuperadmin } from '../host/superadmin.js';
import { createLogger } from '../observability/logger.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';

const log = createLogger('routes.agentPackRegistry');

interface AgentPackSummary {
  /** Pack name, e.g. `core.openwop.agents.code-reviewer`. */
  name: string;
  /** Pack version pinned in this host's local mirror, e.g. `1.0.0`. */
  version: string;
  /** From `pack.json` `description`. */
  description?: string;
  /** Personas the pack ships (extracted from `agents[]`). Drives the
   *  card body so users can see what they'd be installing without
   *  navigating into the registry. */
  personas: string[];
  /** True when at least one of the pack's agents is currently
   *  registered in the in-process `AgentRegistry`. */
  installed: boolean;
}

export function registerAgentPackRegistryRoutes(app: Express): void {
  app.get('/host/openwop-app/registry/agent-packs', async (req, res, next) => {
    try {
      // ADR 0826 D8 — this list answered an ANONYMOUS caller 200. It now needs a
      // signed-in caller, the same posture as the marketplace `/listings` browse.
      await resolveCallerUser(req);
      const packs = scanLocalAgentPacks();
      // UX_UPGRADE-agents AG-G1 — the list tells the caller whether they may
      // INSTALL, computed from the SAME predicate the install route enforces
      // (`isSuperadmin`, the boolean behind `requireSuperadmin`). The UI used to
      // offer Install to everyone, so a non-superadmin's only feedback was a
      // 403 with a developer hint. One predicate, read + write agree — the
      // CLAUDE.md rule for a route and its UI sharing an access check.
      res.json({ packs, total: packs.length, canInstall: isSuperadmin(req) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/registry/agent-packs/install', async (req, res, next) => {
    try {
      // (2026-07 vuln-scan M10) A host-global pack install hot-reloads code into the
      // running host — an operator-only action. Gate on superadmin, matching the
      // sibling workflow-chain-pack installer (routes/workflows.ts).
      requireSuperadmin(req, 'Agent-pack registry install');
      const body = (req.body ?? {}) as { name?: unknown; version?: unknown };
      if (typeof body.name !== 'string' || !body.name.startsWith('core.openwop.agents.')) {
        throw new OpenwopError(
          'validation_error',
          'This route installs `core.openwop.agents.*` packs only. Use the regular pack-install surface for other namespaces.',
          400,
        );
      }
      // ADR 0826 D4 — the ONE install lane (path-safe name, SemVer, tombstone,
      // revoked version, configured registry + keys, mapped errors). The prefix
      // check above admits `…agents.x/../../y`; the lane's name guard refuses it.
      const target = assertInstallable({
        name: body.name,
        version: typeof body.version === 'string' && body.version.length > 0 ? body.version : '1.0.0',
      });
      const result = await installFromConfiguredRegistry(target);
      const version = target.version;
      log.info('agent_pack_install_completed', {
        name: body.name,
        version,
        installed: result.installed,
      });
      res.status(200).json({
        name: body.name,
        version,
        installed: result.installed,
        alreadyInstalled: !result.installed,
      });
    } catch (err) {
      next(err);
    }
  });
}

/** Scan the host's local packs directory for `core.openwop.agents.*`
 *  entries. Returns one summary per pack; installation status comes
 *  from the in-process AgentRegistry. */
function scanLocalAgentPacks(): AgentPackSummary[] {
  const packDir = resolveDefaultPackDir();
  let entries: string[] = [];
  try {
    // Accept both real directories AND symlinks pointing at one.
    // `mountLocalPacks.ts` installs every `core.openwop.*` pack as a
    // symlink into the runtime pack dir, and `Dirent.isDirectory()`
    // returns `false` for symlinks even when their target IS a
    // directory — so a `d.isDirectory()`-only filter silently drops
    // every mounted pack. The agents-tab "Install from registry" page
    // was rendering empty for that reason on the Cloud Run revision
    // even after the packs/ COPY landed.
    entries = readdirSync(packDir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.startsWith('core.openwop.agents.'))
      .map((d) => d.name);
  } catch {
    // No packs dir on disk — return empty rather than 500. The UI
    // surfaces this as "no packs available locally" and points users
    // at the public registry.
    return [];
  }
  const registryAgents = getAgentRegistry().list();
  const out: AgentPackSummary[] = [];
  for (const dir of entries) {
    const packJsonPath = join(packDir, dir, 'pack.json');
    try {
      const raw = readFileSync(packJsonPath, 'utf-8');
      const pack = JSON.parse(raw) as {
        name?: string;
        version?: string;
        description?: string;
        agents?: Array<{ persona?: string; label?: string }>;
      };
      if (!pack.name || !pack.version) continue;
      const personas = (pack.agents ?? [])
        .map((a) => a.label ?? a.persona ?? '')
        .filter((p): p is string => p.length > 0);
      const installed = registryAgents.some((ra) =>
        ra.packName === pack.name && ra.packVersion === pack.version,
      );
      out.push({
        name: pack.name,
        version: pack.version,
        description: pack.description,
        personas,
        installed,
      });
    } catch {
      // Skip malformed pack.json — surfaces as "missing" rather than
      // failing the whole list.
    }
  }
  // Stable order: installed last, then alphabetical. Puts the "needs
  // attention" rows at the top of the page.
  return out.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
