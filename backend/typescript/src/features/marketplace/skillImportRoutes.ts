/**
 * ADR 1044 — SKILL.md import routes (host extension, non-normative).
 *
 *   POST /marketplace/skills/import/preview   convert + scan + validate, no writes
 *   POST /marketplace/skills/import           re-run, check approval, install
 *   GET  /marketplace/skills/imported         this workspace's imports
 *
 * Gate: the `marketplace` toggle AND its default-off `marketplace.skill-import`
 * sub-toggle; a workspace owner/admin or the host operator (the predicate
 * `routes.ts` passes in — the same one feature-bundle activation uses). Every
 * refusal is `skill_import_refused` with a closed `reason`.
 */

import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireFeatureEnabled, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { installSkillImport, listImportedSkills, previewSkillImport } from './skillImport/service.js';
import type { SkillImportInput } from './skillImport/bundle.js';

const BASE = '/host/openwop-app/marketplace/skills';
export const SKILL_IMPORT_TOGGLE = 'marketplace.skill-import';

function sourceOf(body: unknown): SkillImportInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return { skillMd: b.skillMd, files: b.files, zipBase64: b.zipBase64 };
}

export function registerSkillImportRoutes(deps: RouteDeps, canAdminister: (req: Request) => Promise<boolean>): void {
  const { app, storage } = deps;

  const gate = async (req: Request): Promise<{ tenantId: string; userId: string }> => {
    await requireFeatureEnabled(req, 'marketplace', 'Marketplace');
    await requireFeatureEnabled(req, SKILL_IMPORT_TOGGLE, 'Skill import');
    const user = await resolveCallerUser(req);
    if (!(await canAdminister(req))) {
      throw new OpenwopError('forbidden_scope', 'Only a workspace owner or admin can import skills.', 403, { requiredScope: 'host:members:manage' });
    }
    return { tenantId: tenantOf(req), userId: user.userId };
  };

  app.post(`${BASE}/import/preview`, async (req, res, next) => {
    try {
      await gate(req);
      res.json({ preview: await previewSkillImport(sourceOf(req.body)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/import`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { preview } = await installSkillImport(sourceOf(req.body), {
        tenantId, userId, storage, expectedSha256: b.expectedSha256, acknowledgeWarnings: b.acknowledgeWarnings,
      });
      res.status(201).json({ agentId: preview.agentId, persona: preview.persona, toolAllowlist: preview.toolAllowlist, verified: false, sourceSha256: preview.sourceSha256 });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/imported`, async (req, res, next) => {
    try {
      const { tenantId } = await gate(req);
      res.json({ skills: await listImportedSkills(tenantId, storage) });
    } catch (err) { next(err); }
  });
}
