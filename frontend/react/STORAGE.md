# Browser storage policy

This app caches a small amount of state in the browser for UX preferences,
cold-start resilience, and developer diagnostics. This document is the
authoritative classification of **what is stored, where, and why**. The
registry in [`src/platform/storage.ts`](src/platform/storage.ts) (`STORAGE_KEYS`) is the
machine-readable mirror of this table; keep them in sync.

## Hard invariant

**No secret or credential material is ever written to browser storage.** The
BYOK credential *value* lives only in the backend secret resolver. The browser
keeps the credential *ref name* (class `ref`). Two guards enforce this:

- `src/byok/lib/useBYOKConfig.ts` whitelists the persisted fields and is tested
  by `src/byok/lib/__tests__/byokPersist.test.ts`.
- The in-app network recorder redacts request bodies on secret-bearing routes
  before buffering/mirroring — `src/devtools/networkRecorder.ts`
  (`redactRequestBody`), tested by
  `src/devtools/__tests__/networkRecorder.test.ts`. It is also **default-off in
  production** (opt in with `VITE_ENABLE_NETWORK_RECORDER=1`).

## Classification

| Class | Meaning | Area | Retention |
|---|---|---|---|
| `ref` | Opaque server-side reference names (never the secret itself) | localStorage | indefinite |
| `pref` | UI preferences | localStorage | indefinite |
| `content` | User-authored content cached for offline/cold-start | localStorage | until user clears |
| `diag` | Developer diagnostics | sessionStorage / localStorage | tab lifetime / timestamp |
| `secret` | **Prohibited in the browser** | — | — |

## Key registry

| Key | Area | Class | Purpose |
|---|---|---|---|
| `openwop.theme` | local | pref | forced light/dark/system override |
| `openwop.sidebar.collapsed` | local | pref | nav rail collapsed |
| `openwop.admin.railCollapsed` | local | pref | admin rail collapsed |
| `openwop.runs.density` | local | pref | runs table density |
| `openwop:demo-banner:dismissed` | local | pref | demo banner dismissed |
| `openwop:notification-prefs:v1` | local | pref | notification preferences |
| `openwop.appGate.unlocked` | local | pref | demo gate unlocked |
| `openwop-thoughts-anim` | local | pref | reasoning animation pref |
| `openwop.sample.byok.activeConfig` | local | ref | provider/model/credentialRef **name** only |
| `openwop.sample.byok.pendingManaged` | local | ref | pending managed-provider id |
| `openwop.sample.chat.session` | local | content | current chat thread (cold-start cache) |
| `openwop.sample.chat.sessions-index` | local | content | session header index for History drawer |
| `openwop.sample.prompts.user` | local | content | user-authored prompts |
| `openwop.sample.builder.workflows*` | local | content | draft workflows + migration flags |
| `openwop.networkRecorder.v1` | session | diag | credential-redacted traffic mirror; prod-default-off |
| `openwop.sample.lastSuccessAt` | local | diag | cold-start warm-window timestamp hint |

### Dynamic (per-tenant) keys

Some chat keys are suffixed with the tenant id and built from a static prefix
by their owning module (all class `pref`/`content`):

- `openwop.sample.chat.leftRail.activeTab.<tenant>`
- `openwop.sample.chat.progressPanel.{open,focusedRunMsgId}.<tenant>`
- `openwop.sample.chat.activeAgentsPanel.open.<tenant>`
- `MarkdownEditor` autosave keys (caller-supplied prefix; draft text only)

## Adding a key

1. Add an entry to `STORAGE_KEYS` in `src/platform/storage.ts` with its class.
2. Add a row here.
3. If the value could ever contain user input that may include a secret, it is
   class `secret` → it does not go in the browser. Store a server-side ref
   instead.
