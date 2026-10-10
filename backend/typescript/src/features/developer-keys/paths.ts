/**
 * ADR 0798 D8 — the one developer-keys path that needs no credential. Its own
 * module so the auth middleware can name it on the public-path list without
 * importing the feature's routes.
 */
export const DEVELOPER_KEYS_BASE = '/host/openwop-app/developer-keys';
export const LEAKED_KEYS_PATH = `${DEVELOPER_KEYS_BASE}/leaked`;

/** ADR 0799 — CLI sign-in. `start` and `poll` are the CLI's own and need no credential. */
const CLI_LOGIN_BASE = '/host/openwop-app/cli-login';
export const CLI_LOGIN_PATHS = {
  start: `${CLI_LOGIN_BASE}/start`,
  poll: `${CLI_LOGIN_BASE}/poll`,
  requests: `${CLI_LOGIN_BASE}/requests`,
  logout: `${CLI_LOGIN_BASE}/logout`,
} as const;
