# API keys

An API key lets a tool that is not a browser — the OpenWOP CLI, a script, a CI
job, another service — call a workspace as you. This page is the reference for
people who use keys and for operators who run the host. The decisions behind it
are ADR 0800, ADR 0795 and ADR 0798.

- [Create a key](#create-a-key)
- [Sign the CLI in without a key](#sign-the-cli-in-without-a-key)
- [Use it](#use-it)
- [What a key can do](#what-a-key-can-do)
- [Lifetime, rotation and revocation](#lifetime-rotation-and-revocation)
- [Workspace rules](#workspace-rules)
- [If a key leaks](#if-a-key-leaks)
- [Operator settings](#operator-settings)

## Create a key

You need a signed-in account. An anonymous demo session cannot create a key.

1. Open **Access → API keys** (`/access?tab=api-keys`).
2. Name the key after where it will live ("Laptop — CLI", "CI deploy").
3. Choose what it may do (below) and how long it lasts.
4. **Create key.** The key is shown **once**. Copy it now; the host stores only a
   hash and cannot show it again.

| Choice | For | Scopes |
|---|---|---|
| **Run workflows** (default) | Scripts and automation | `runs:create` `runs:read` `runs:cancel` `artifacts:read` `approvals:respond` |
| **Read only** | Dashboards, monitors | `runs:read` `artifacts:read` |
| **CLI — act as me** | The OpenWOP CLI on your own machine | every protocol scope, plus `workspace:read` and `workspace:write` |

"Run workflows" and "Read only" reach runs, artifacts and approvals and nothing
else in the workspace. Commands that touch the rest of it — `openwop agents
list`, memory, provider keys — need the CLI key.

Keys for AI clients (MCP) are created on the **AI clients** tab and appear in the
same list.

## Sign the CLI in without a key

With a CLI that has `openwop login`:

```sh
export OPENWOP_BASE_URL=https://<your-host>/api
openwop login
```

It prints a short code. Open **Access → API keys**, type the code under *Sign in
the OpenWOP CLI*, check that it is your own terminal asking, and approve. The
CLI saves a key that lasts 30 days and is listed on the tab as `CLI: <name>`.
`openwop logout` revokes it. Sign in again to renew.

Approve a code only if you just ran `openwop login` yourself.

## Use it

Send the key as a bearer token:

```
Authorization: Bearer owk_…
```

With the OpenWOP CLI:

```sh
export OPENWOP_BASE_URL=https://<your-host>/api
export OPENWOP_API_KEY=owk_…
openwop runs create <workflowId>
```

The CLI reads the key from `--api-key`, then `OPENWOP_API_KEY`, then its saved
config (`openwop config set host.apiKey owk_…`).

A key goes in the header, not the URL. `?apiKey=` is accepted only on the
run-events stream, for clients that cannot set a header.

## What a key can do

- **Never more than you.** A key holds what you hold, limited to the scopes it
  declares. If your access is reduced, the key's is too, at once.
- **Exactly the scopes it declares.** A key without `runs:read` can start a run
  and cannot read it back. Choose a preset unless you know which scopes a call
  needs.
- **Not manage keys.** A key cannot create, list, rotate or revoke keys, and
  cannot act as another member. Those need a signed-in person.
- **One workspace.** A key works only in the workspace it was created in.

Creating a key through the API (`POST /v1/host/openwop-app/developer-keys`)
requires `scopes`. Use `["*"]` for a key with your full authority; a scope the
host does not know is refused by name.

## Lifetime, rotation and revocation

- **Expiry.** A key lasts 90 days unless you choose otherwise, up to the host's
  maximum (366 days by default). A key that is still being used in its last 14
  days puts one notice in your inbox, and the list flags it.
- **Rotate.** *Rotate* gives you a replacement with the same access. The old key
  keeps working for up to 24 hours so you can switch over, then stops.
- **Revoke.** *Revoke* stops a key immediately and cannot be undone.
- **When you leave.** If you are removed from a shared workspace, the keys you
  created there are revoked. If your account is deleted, they are deleted.
- **Housekeeping.** Revoked and expired keys disappear from the host after 90 days.

Each key shows a short hint (`owk_AbCd…WxYz`), when it was last used and from
where, so a key you find in a config file can be matched to its row.

## Workspace rules

A workspace admin or owner can, on the same tab:

- **Turn API keys off** for the workspace. No key can be created and none works
  until they are turned back on. Revoking stays possible.
- **Set a shorter maximum lifetime** than the host's.

Creating, rotating and revoking a key, and changing these rules, are recorded on
the workspace's audit chain.

## If a key leaks

Revoke it on the tab. If you cannot sign in, or you found someone else's key,
report it — no account needed:

```sh
curl -X POST https://<your-host>/api/v1/host/openwop-app/developer-keys/leaked \
  -H 'content-type: application/json' \
  -d '{"tokens":["owk_…"]}'
```

A live key in the report is revoked, its owner is notified, and the reason is
recorded. Holding the whole key is what makes this safe to leave open: anyone
who has it could already use it.

Keys end in a checksum, so a scanner can tell a real key from a look-alike
without calling the host. The pattern to match:

```
owk_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{6}
```

The endpoint accepts the array-of-`{ token, type, url }` shape that secret-
scanning programmes send and answers `true_positive` / `false_positive` per token.

## Operator settings

All optional. Defaults are the secure ones.

| Variable | Default | Effect |
|---|---|---|
| `OPENWOP_API_KEY_DEFAULT_LIFETIME_DAYS` | `90` | Lifetime when a request names none |
| `OPENWOP_API_KEY_MAX_LIFETIME_DAYS` | `366` | Longest lifetime a key may be given |
| `OPENWOP_API_KEY_ALLOW_NO_EXPIRY` | off | `true` lets a request ask for a key that never expires |
| `OPENWOP_API_KEY_ROTATION_OVERLAP_HOURS` | `24` | How long a rotated key keeps working |
| `OPENWOP_API_KEY_RETENTION_DAYS` | `90` | How long a revoked or expired key is kept |
| `OPENWOP_CLI_LOGIN_KEY_DAYS` | `30` | Lifetime of a key minted by `openwop login` |
| `OPENWOP_RATELIMIT_APIKEY_REQS_PER_MIN` | `600` | Requests per minute per key; `0` turns the per-key limit off |
| `OPENWOP_KEY_AUTHORITY` | `enforce` | A key's authority is its issuer's, narrowed. `report` logs what would change and changes nothing; `off` is the old behaviour |
| `OPENWOP_KEY_VENDOR_GATE` | `enforce` | A key needs `workspace:read` / `workspace:write` on the app's own routes. `report` / `off` as above |
| `OPENWOP_KEY_QUERY_PARAM` | `enforce` | A key in `?apiKey=` is refused outside the run-events stream. `report` / `off` as above |

`report` writes one `key_policy_would_change` log line per distinct case. Use it
to measure before enforcing on a deployment that already has keys in use.

A superadmin can list every key on the host by shape — how many declare
nothing, never expire, or were issued by another key — at
`GET /v1/host/openwop-app/developer-keys/inventory`. It returns no names, hints
or secrets.
