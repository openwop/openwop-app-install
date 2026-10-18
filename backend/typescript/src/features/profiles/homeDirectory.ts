/**
 * ADR 0888 D1 — the HOME-scope directory, one function for the route and the run
 * lane (`PROF2CD-4`: the route skipped orphan profiles and the surface did not, so
 * the two lanes listed different people for the same reader).
 *
 * An ORPHAN is a profile whose owning user no longer exists in the tenant; listing
 * it renders an opaque id and leaks that the account is gone.
 */

import { listUsers } from '../users/usersService.js';
import { listProfiles, type Profile } from './profilesService.js';

export interface HomeDirectoryEntry {
  profile: Profile;
  displayName?: string;
}

export async function listHomeDirectory(tenantId: string): Promise<HomeDirectoryEntry[]> {
  const [profiles, users] = await Promise.all([listProfiles(tenantId), listUsers(tenantId)]);
  const names = new Map(users.map((u) => [u.userId, u.displayName]));
  return profiles
    .filter((p) => names.has(p.userId))
    .map((p) => {
      const displayName = names.get(p.userId);
      return { profile: p, ...(displayName ? { displayName } : {}) };
    });
}
