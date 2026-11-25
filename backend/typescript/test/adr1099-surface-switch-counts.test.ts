/**
 * ADR 1099 D1 — for a SIGNED-IN invite, a collaboration surface whose switch is
 * OFF admits no org, even when its org rule says every org is open.
 *
 * The `project` kind's surface (features/projects/clientPortal.ts) has the org
 * rule "the org exists in this tenant". `createCollaborator` used to ask only the
 * org rule (`anyOrgOpen`), so with projects.client-portal off every org read as
 * open to a direct call. The route was safe (it checks the switch first). It now
 * uses `anySurfaceAdmits`, the check the invite's accept lane (sharing
 * `collab_invite`) already made.
 *
 * Not changed, on purpose: `createLinkOnlyCollaborator` and `grantAccess`'s first
 * check keep the org rule alone. A link-only collaborator never signs in, so the
 * signed-in switch does not govern it (the ADR 0924 client approver is minted
 * with campaign-ops.external-collab off), and `grantAccess` re-checks the kind's
 * owner and org rule before minting.
 *
 * Here: a probe surface whose org rule is always open, switched off. The
 * signed-in steps refuse; switching it on admits the same call (so the refusal
 * is the switch, not a broken fixture).
 *
 * Sabotage notes: dropping `enabledFor` from `anySurfaceAdmits`, or pointing
 * `createCollaborator` back at `anyOrgOpen`, reds the switched-off case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  anySurfaceAdmits, createCollaborator, registerGrantResourceKind,
} from '../src/host/externalCollaborators.js';

const T = 't-surface-switch';
const ORG = 'org-surface-switch';
let on = false;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  registerGrantResourceKind('surface-switch-probe', {
    featureId: null,
    actions: ['view'],
    async exists() { return true; },
    async project() { return { title: 'Probe', body: {} }; },
    surface: {
      async enabledFor() { return on; },
      async orgOpen() { return true; }, // "the org exists", as the project surface says
    },
  });
});

const invite = (email: string) => ({ tenantId: T, orgId: ORG, kind: 'client-stakeholder' as const, email, displayName: 'Reviewer', createdBy: 'owner-1' });

describe('a surface that is switched off admits no org for a signed-in invite', () => {
  it('refuses the signed-in steps: the invite and its acceptance', async () => {
    on = false;
    expect(await anySurfaceAdmits(T, ORG), 'the accept lane').toBe(false);
    await expect(createCollaborator(invite('a@example.test'))).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('admits the same call once the switch is on', async () => {
    on = true;
    try {
      expect(await anySurfaceAdmits(T, ORG)).toBe(true);
      const c = await createCollaborator(invite('c@example.test'));
      expect(c.status).toBe('invited');
    } finally { on = false; }
  });
});
