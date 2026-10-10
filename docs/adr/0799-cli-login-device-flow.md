# ADR 0799 — sign the CLI in by a code, not a copied key

Status: Accepted (2026-10-01; app side implemented in the PR that adds this file. The `openwop login` command ships from the CLI repository — see § Implementation record)

- **Follows:** ADR 0800 (API keys tab), ADR 0795 (key authority and lifetime),
  ADR 0798 (visibility, rotation, workspace rules). Tracker row `KEY-16`.
- **Composes:** ADR 0785 (Claude Code device pairing — the same flow, reused as
  a pattern), ADR 0270 (developer keys).
- **Toggle:** none. It mints an ordinary developer key; that surface is always on.
- **Wire:** untouched. `/v1/host/openwop-app/cli-login/*` is a host extension.
  The CLI fails closed on a host that does not serve it. No RFC.

## Context

After ADR 0800 a person can create a key for the CLI and paste two lines into a
shell. That works, and it is the weakest part of the flow: a long-lived secret
travels through a clipboard, a terminal history and a dotfile, chosen and named
by hand. Every CLI that grew past this ended up with a device sign-in
(`gh auth login`, `gcloud auth login`, `az login`).

This host already has one. Claude Code pairing (ADR 0785) starts a request,
shows a short code, has a signed-in person approve it, and mints a key when the
device collects it.

## Decision

### D1 — a device-code sign-in that mints an ordinary key

```
openwop login         POST …/cli-login/start      → deviceCode (secret), userCode (shown)
person, signed in     types the userCode on Access → API keys → approve / deny
openwop login         POST …/cli-login/poll       → the key, once
```

- `start` and `poll` need no credential: the device code is one, and the host
  keeps only its hash. Both are on the public-path list. `start` is limited to
  ten per address per ten minutes, on top of the global budget.
- **The person types the code.** `start` answers a `verificationPath` WITHOUT
  the code (RFC 8628 §5.4): a link that carried it would be a one-click lure —
  start a sign-in, mail the victim the link. The same choice ADR 0785 made.
- Approving requires a signed-in PERSON (`auth.kind === 'subject'`): not an
  anonymous session, not a key, not an operator env key. Before deciding, the
  person is shown what is asking: the label the CLI sent, the address it came
  from, the time, and the workspace the key will be minted in.
- **The key is minted at `poll`**, after a compare-and-swap consumes the
  approved request. The secret is never stored, two racing polls get one key
  between them, and a second poll is a 404.
- The key is an ordinary developer key: named `CLI: <label>`, owned by the
  approver, with every protocol scope plus `workspace:read` and
  `workspace:write` (the "CLI — act as me" preset), listed and revocable on the
  tab like any other. A workspace with keys turned off cannot approve one.

### D2 — a short life, renewed by signing in again

Decided with the user: **30 days** (`OPENWOP_CLI_LOGIN_KEY_DAYS`), bounded by
the workspace's and the deployment's cap. Renewal is `openwop login` again. A
refresh token was weighed and rejected: it is a second long-lived secret on the
same disk, which is what this flow exists to avoid.

### D3 — sign out: a key may revoke itself

`POST …/cli-login/logout`, called WITH the key, revokes that key. It is the one
key-management act a key is allowed (ADR 0800 D1 refuses the rest): it can only
remove authority, and only its own. Any key may use it, whatever it declared,
so the route is on the vendor floor's own-gate list.

## Alternatives weighed

- *OAuth authorization-code with a loopback redirect.* The usual choice for a
  desktop CLI; it needs a browser on the same machine and a registered
  redirect. The device flow works over SSH and in containers, and this host
  already implements it once.
- *Have the CLI open the browser with the code in the URL.* Convenient, and the
  lure described above. The CLI may open the page; it never puts the code in it.
- *Reuse the Claude Code pairing routes.* They are behind that feature's toggle
  and operator gate, carry a consent record, and mint device keys with a
  different scope set and lifecycle. Sharing the PATTERN keeps both honest;
  sharing the rows would couple a core credential path to an optional feature.

## Risks

| Risk | Mitigation |
|---|---|
| Someone is talked into typing an attacker's code | The page shows what is asking and from where, and says to approve only if you just ran `openwop login` yourself. The key is listed, named, and revocable; it lasts 30 days |
| A pending request is guessed | 8 characters from a 28-symbol alphabet, 10 minutes, ten starts per address; an unknown code is a uniform 404 |
| The poll response is cached by an intermediary | `Cache-Control: no-store` on the response that carries the key |
| `start` floods the store | Rows age out after a day (`registerKvAgeOut`); per-address limit |

## Implementation record

| Decision | What | Witness |
|---|---|---|
| D1 | `features/developer-keys/cliLogin.ts`, `cliLoginRoutes.ts`; `start` and `poll` on the public-path list | `test/adr0799-cli-login.test.ts` § sign-in (4), § who may approve (4) |
| D2 | `CLI_LOGIN_SCOPES`, `OPENWOP_CLI_LOGIN_KEY_DAYS`, capped by `keyMintPolicy` | the approve case asserts the 30-day expiry |
| D3 | the logout route; the own-gate entry in `middleware/keyVendorGate.ts` | § sign out (2) |
| Tab | `CliLoginCard` on the API keys tab, four locales | `ApiKeysPage.test.tsx` § approve a CLI sign-in (5) |
| CLI | `openwop login` / `openwop logout` | the CLI repository's own tests and release |

The v1-reliance baseline (ADR 0642) rises by one, 722 → 723, on purpose: the
route family is mounted where every host-extension family is mounted today, and
the one literal is `CLI_LOGIN_BASE` in `features/developer-keys/paths.ts`. It is
reachable at the version-agnostic `/host/openwop-app/cli-login/*` root as well,
which is the path the CLI should call.

## Open questions

- [ ] Should approving show the scopes as a list a person can narrow, instead of
      one fixed set?
- [ ] An "expires in N days — sign in again" hint from the CLI itself.
- [ ] Publish the CLI release that carries `openwop login`, then update
      openwop.dev's CLI page to lead with it.
