# White-labeling the app

This reference app (the React SPA behind `app.openwop.dev`) is designed to
be re-skinned and re-deployed under your own brand **without forking core
logic**. Brand identity is isolated into three small seams:

| Seam | What it controls | How you change it |
|---|---|---|
| `VITE_BRAND_*` env vars | Brand **strings + asset paths**: product name, wordmark, footer, assistant persona, icon mark, lockup, favicon, document title, fonts, privacy domain/URLs | Set env vars at build time (no code edit) |
| `src/brand/brand.css` | Brand **colors + typography** (CSS custom properties) | Uncomment + set tokens in one file |
| Asset files in `public/` | The icon mark / lockup image, and any custom favicon/font files you reference | Drop in replacements |

The stock build with no overrides renders the standard OpenWOP identity,
byte-for-byte. Everything below is opt-in.

> **Why not just edit `global.css`?** The editorial palette in
> `src/styles/global.css :root` is the app's base design system (see `DESIGN.md §2`); editing it
> forks the base. Re-brand in `src/brand/brand.css` instead — it loads *after*
> `global.css` and wins the cascade without touching the synced block.

---

## 1. Rebrand the strings + assets (`VITE_BRAND_*`)

Set these as environment variables for the build — in
`.env.production`, a `.env.production.local` override, your CI, or on the
command line. Vite inlines `VITE_*` vars at **build time**, so you must
rebuild after changing them. Any var left unset falls back to the OpenWOP
default in `src/brand/defaults.ts`.

| Env var | Default | Controls |
|---|---|---|
| `VITE_BRAND_PRODUCT_NAME` | `OpenWOP` | Plain-text product name (prose) |
| `VITE_BRAND_MARK_PRE` | `Open` | Wordmark — text before the emphasis |
| `VITE_BRAND_MARK_EMPHASIS` | `WOP` | Wordmark — emphasized (italic) span; set empty to drop |
| `VITE_BRAND_MARK_SUB` | `workflow engine` | Wordmark — muted sub-label |
| `VITE_BRAND_TAGLINE` | `workflow engine` | Short descriptor |
| `VITE_BRAND_FOOTER_TEXT` | *(blank)* | Footer line |
| `VITE_BRAND_ASSISTANT_NAME` | `OpenWOP` | Name the in-app AI assistant refers to itself by |
| `VITE_BRAND_MARK_SRC` | `/OpenWOP.svg` | Square icon mark for the sidebar header + PWA manifest (path under `public/` or a URL) |
| `VITE_BRAND_LOCKUP_SRC` | *(blank)* | Optional full lockup asset for marketing/brand surfaces; not rendered by the default sidebar |
| `VITE_BRAND_LOGO_SRC` | `/OpenWOP.svg` | Deprecated alias for `VITE_BRAND_MARK_SRC` (kept so existing forks keep working) |
| `VITE_BRAND_FAVICON_SRC` | *(inline SVG)* | Favicon — a URL or `data:` URI |
| `VITE_BRAND_DOCUMENT_TITLE` | `workflow-engine — OpenWOP Reference UI` | Browser tab `<title>` |
| `VITE_BRAND_FONTS_HREF` | *(Google Fonts triple)* | Web-font stylesheet `<link href>` |
| `VITE_BRAND_PRIMARY_DOMAIN` | `app.openwop.dev` | Domain shown in the privacy disclosure |
| `VITE_BRAND_INSTANCE_NAME` | `OpenWOP` | Workspace / instance name shown in the sidebar chrome |
| `VITE_BRAND_HOME_URL` | `https://openwop.dev/` | "Learn more" link (privacy footer) |
| `VITE_BRAND_REPO_URL` | `https://github.com/openwop/openwop` | Source-repo link (privacy footer) |
| `VITE_BRAND_THEME_COLOR` | `#1a1a17` | PWA manifest + mobile browser chrome color |
| `VITE_BRAND_DEFAULT_THEME` | `system` | Initial app theme when the visitor has not chosen one (`system`, `light`, or `dark`) |
| `VITE_BRAND_APP_GATE_MODE` | `none` | App-wide pre-render gate (`none`, `password`, or `sign-in`) — see the security caveat below |
| `VITE_BRAND_APP_GATE_PASSWORD` | *(blank)* | Password value for AppGate when `mode=password` |

> **AppGate `password` mode is demo friction, NOT authentication.** The
> password is a `VITE_*` var, so it is inlined in plain text into the shipped
> JS bundle (anyone can read it from the source), and the unlock is a
> client-side localStorage flag — the backend API stays reachable without it.
> Use it to keep a public demo URL semi-private. For real protection use
> `mode=sign-in` (Firebase Auth) **plus** a backend auth posture
> (`OPENWOP_DEPLOY_POSTURE=auth`), or front the whole deployment with your
> own access control (IAP, VPN, basic auth at the proxy).

**Example `.env.production.local`:**

```dotenv
VITE_OPENWOP_BASE_URL=/api
VITE_BRAND_PRODUCT_NAME=Acme Flow
VITE_BRAND_MARK_PRE=Acme
VITE_BRAND_MARK_EMPHASIS=Flow
VITE_BRAND_MARK_SUB=automation
VITE_BRAND_ASSISTANT_NAME=Acme Flow
VITE_BRAND_DOCUMENT_TITLE=Acme Flow — Workflow Automation
VITE_BRAND_MARK_SRC=/acme-mark.svg
VITE_BRAND_LOCKUP_SRC=/acme-lockup.svg
VITE_BRAND_PRIMARY_DOMAIN=flow.acme.example
VITE_BRAND_INSTANCE_NAME=Acme Workspace
VITE_BRAND_HOME_URL=https://acme.example/
VITE_BRAND_REPO_URL=https://github.com/acme/flow
VITE_BRAND_DEFAULT_THEME=light
```

### Swapping the icon mark, lockup + favicon

1. Drop a **square icon mark** into `public/` (e.g. `public/acme-mark.svg`) and
   set `VITE_BRAND_MARK_SRC=/acme-mark.svg`. This is the asset used in the
   28×28 sidebar slot and the generated PWA manifest.
2. If you also have a full wordmark/lockup asset, drop it into `public/` and set
   `VITE_BRAND_LOCKUP_SRC=/acme-lockup.svg`. The stock sidebar renders the text
   wordmark from `VITE_BRAND_MARK_PRE/EMPHASIS/SUB`, so do **not** point the
   square mark at a full lockup or the brand will appear twice.
3. For the favicon, either set `VITE_BRAND_FAVICON_SRC` to a `/`-rooted
   path of a file in `public/`, or paste a `data:` URI inline.
4. The header mark's `alt` is intentionally empty + `aria-hidden` — the
   adjacent wordmark already names the product to screen readers, so the
   image is decorative. Keep it that way to avoid double-announcing.

### Brandable-surface checklist + the pre-deploy guard

Every surface that carries the OpenWOP identity, with the var/file to override
it. A forgotten field ships OpenWOP branding silently — so run the guard below.

| Surface | Override |
|---|---|
| Product name / wordmark | `VITE_BRAND_PRODUCT_NAME`, `VITE_BRAND_MARK_PRE/EMPHASIS/SUB` |
| Header icon mark | `VITE_BRAND_MARK_SRC` (+ drop the square SVG in `public/`; `VITE_BRAND_LOGO_SRC` remains a deprecated alias) |
| Optional full lockup | `VITE_BRAND_LOCKUP_SRC` (+ drop the lockup SVG in `public/`) |
| **Favicon** | `VITE_BRAND_FAVICON_SRC` (commonly missed → ships the OpenWOP "O") |
| PWA manifest + mobile `theme-color` | `VITE_BRAND_THEME_COLOR` (the `manifest.webmanifest` is auto-stamped at build from product name + icon mark + this color — no hand-authored manifest) |
| Document `<title>` | `VITE_BRAND_DOCUMENT_TITLE` |
| Tagline / footer / assistant name | `VITE_BRAND_TAGLINE`, `VITE_BRAND_FOOTER_TEXT`, `VITE_BRAND_ASSISTANT_NAME` |
| Domain / home / repo links | `VITE_BRAND_PRIMARY_DOMAIN`, `VITE_BRAND_HOME_URL`, `VITE_BRAND_REPO_URL` |
| Fonts | `VITE_BRAND_FONTS_HREF` |
| Instance / workspace label | `VITE_BRAND_INSTANCE_NAME` |
| Default theme | `VITE_BRAND_DEFAULT_THEME` |
| App gate config | `VITE_BRAND_APP_GATE_MODE`, `VITE_BRAND_APP_GATE_PASSWORD` |
| Colors / type | `src/brand/brand.css` (§2 below) |
| Backend / Firebase config | a scrubbed `.env.production` — start from **`.env.production.example`**, never the upstream's `.env.production` (it points at the steward's backend) |

**Verify before you ship** — after `npm run build`, run the guard from the repo
root; it fails if any OpenWOP default leaked into your bundle:

```sh
( cd frontend/react && npm run build )
bash scripts/check-branding.sh frontend/react/dist
```

(The guard is a *fork* tool — the upstream OpenWOP build legitimately carries
these strings, so it's expected to report leaks there.)

---

## 2. Rebrand the colors + typography (`src/brand/brand.css`)

Open `src/brand/brand.css` — it ships empty (all tokens commented). Set
only the tokens you want to change; everything else inherits the stock
palette. In most cases you only need `--clay` (the accent) and maybe
`--paper` / `--ink`: the accent's alpha variants re-tint themselves from
`--clay` via `color-mix`.

```css
:root {
  --clay:   #2563eb;        /* your brand accent — buttons, links, active nav */
  --paper:  #ffffff;        /* page background */
  --ink:    #0f172a;        /* primary text */

  --serif:  "Fraunces", Georgia, serif;       /* headings + wordmark */
  --sans:   "Inter", system-ui, sans-serif;   /* body + UI */
}
```

If you change the font families, also point `VITE_BRAND_FONTS_HREF` at a
stylesheet that actually loads them (or self-host the fonts and reference
your own CSS), or the families won't render.

**Token catalog** (see the comments in `brand.css` for the full set):
`--clay`, `--paper`, `--paper-2`, `--ink`, `--ink-2`, `--ink-3`, `--rule`
(palette); `--serif`, `--sans`, `--mono` (type); `--color-success`,
`--color-warning`, `--color-danger`, `--color-ai` (functional status —
keep legible on your `--paper`); `--color-flag-*`, `--color-trace-*`
(registry/trace category accents).

---

## 3. What you can vs. can't (yet) change cleanly

| ✅ Clean seam | ⚠️ Needs manual review |
|---|---|
| Product name, wordmark, footer, assistant persona | The **privacy page** (`src/PrivacyPage.tsx`) — its domain/URLs are tokenized, but the cookie name, retention windows, Cloud Run specifics, and steward contact are deployment/legal content you should rewrite for your service |
| Icon mark, optional lockup, favicon, document title, fonts, instance name, default theme | The **in-memory host banner** (`src/builder/InMemoryHostBanner.tsx`) — "anonymous / resets after 24h" copy is tied to the in-memory deployment mode; review if you run a persistent backend |
| Accent + surface palette, typography, status/trace colors | Backend-set strings (e.g. the `openwop.session` cookie name) live in the server, not this SPA |
| Privacy domain + home/repo links | `package.json` `name`/`description` — internal, not user-facing; rename if forking |

Vendor brand marks (the Google `g` and GitHub octocat in the sign-in
buttons) are **never re-colored** — they must render in their canonical
fills per `DESIGN.md §8`. Don't theme them.

---

## 4. Backend (server) white-labeling

The backend follows the same principle: **no brand string is hard-coded into a
default that a white-label host would have to override.** Seed *content* lives
in data files, and the runtime fallbacks are brand-neutral. Configure via env
(all preserve-on-update — use an incremental `gcloud run services update`, not
`--set-env-vars`, so you don't wipe other secrets/config):

| Env var | Default | Controls |
|---|---|---|
| `OPENWOP_SERVICE_NAME` | `openwop-workflow-engine` | Service name in `/.well-known/openwop` + the OpenAPI `info.title` |
| `OPENWOP_SERVICE_DESCRIPTION` | `An OpenWOP-compatible workflow and agent orchestration host.` | OpenAPI `info.description` (brand-neutral by default — no marketing URL) |
| `OPENWOP_SERVICE_VENDOR` | `openwop-app` | `service.vendor` in `/.well-known/openwop` — set this so your discovery doc doesn't advertise the reference-sample vendor tag |
| `OPENWOP_MANAGED_SYSTEM_PROMPT` | *(brand-neutral generic assistant prompt)* | Grounding prompt for the managed "try it free" chat tier. **The code fallback is generic** — set this to your own grounding (the reference deploy supplies the OpenWOP blurb here) |
| `OPENWOP_DEMO_MODE` | `false` | **Demo-deployment switch.** Off (the default) = production-grade clean: NO auto-seed, NO synthetic `__showcase__` data — a fresh install boots empty, every surface reads only the tenant's own real data. Set `true` only for a public showcase (e.g. app.openwop.dev), which boot-seeds the showcase tenant + lets dashboards fall back to it — that data is BADGED illustrative in the UI. |
| `OPENWOP_DEMO_SEED_ENABLED` | `true` | Whether explicit, user-triggered seeding (the `/example-data` dashboard + "Load example data" actions) is available at all. Set `false` to remove the capability entirely. Independent of `OPENWOP_DEMO_MODE`. |
| `OPENWOP_DEPLOY_POSTURE` | `cookie-per-visitor` | Backend auth posture: `bearer-shared`, `cookie-per-visitor`, or `auth` |
| `OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED` | *(derived)* | Optional override for the managed free-tier sign-in wall (`true`/`false`); demo postures allow anon by default, `auth` requires sign-in |
| `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP` | *(unset = off)* | Operator spend backstop: total managed-tier tokens per day across ALL tenants. **Set this on any login-free public demo** — the per-tenant cap alone is evadable on cookie-per-visitor deploys (every fresh cookie jar is a fresh anon tenant) |
| `OPENWOP_SESSION_COOKIE_NAME` | `__session` | Session cookie name (already un-branded; Firebase Hosting requires `__session`) |
| `OPENWOP_VAPID_SUBJECT` | `mailto:admin@openwop.dev` | Web-push contact (RFC 8030) |
| `OPENWOP_AUTHORIZATION_ENFORCEMENT` | `false` | **Turn ON for multi-member workspaces (ADR 0015).** When `true`, the protocol surface (runs/artifacts) fail-closes on each member's RFC 0049 role scopes and the host advertises `capabilities.authorization`. Leave off for the single-user demo; set `true` for a real B2B deployment so shared-workspace roles are enforced on the wire. |
| `OPENWOP_SUPERADMIN_TENANTS` | *(unset)* | CSV of tenant ids that may administer **feature toggles** (the platform/back-office plane). Out-of-band by design — NOT self-service, distinct from a workspace's own owner/admin. Leave unset unless you operate the instance. |

### Onboard your team — B2B workspaces (ADR 0015)

A self-hosted instance is multi-tenant by **workspace**: the workspace is the
isolation boundary (the tenant), a user can belong to several, and a role
(`viewer` / `editor` / `admin` / `owner`) is assigned per workspace. A solo user
gets a personal workspace automatically; a company shares one workspace.

For a team deployment:

1. **Require sign-in + enforce roles.** Set `OPENWOP_DEPLOY_POSTURE=auth`,
   `OPENWOP_DEMO_MODE=false`, and `OPENWOP_AUTHORIZATION_ENFORCEMENT=true` (plus
   the OIDC + `OPENWOP_BYOK_KMS_KEY` + `OPENWOP_STORAGE_DSN` config that `auth`
   posture requires).
2. **First user creates the company workspace.** After signing in, use the
   sidebar workspace switcher → **+ New workspace…**; the creator becomes its
   `owner`.
3. **Invite the team.** Switch into the workspace, then add members under
   **Organizations** (`/orgs`) with the role each should hold; or send an
   email invitation (it binds the accepting user as a member).
4. **Members switch in.** Each teammate signs in and selects the shared
   workspace from the switcher; their role gates what they can do. A non-member
   cannot enter (membership-gated, fail-closed).

Personal workspaces stay private (the owner is implicit); only shared workspaces
are role-governed. See `docs/adr/0015-workspace-as-tenant-b2b.md`.

### Example data

The example seed runs through `seedEverything(tenant)` and currently covers the
registered stock domains: user-agent inventory, roster, boards, cards,
schedules, and org chart. The persona content (Sally, Marcus, …), boards, cards,
schedules, and org-chart positions live in
**`backend/typescript/src/host/seed-data/exampleAgents.json`** — the
brand-authoring surface. Edit that JSON to ship your own example content (it's
type-checked at build time and bundled into the image), or leave it unseeded.
**A clean install boots empty by default** (`OPENWOP_DEMO_MODE` off): nothing is
auto-seeded, and example data is loaded only on demand from `/example-data`. The
silent auto-seed-on-page-load fires **only** when the host advertises
`demoMode: true` (the public showcase), so a white-label deploy never seeds
behind the user's back. Workforces follow the same data file —
**`seed-data/workforces.json`**, where each entry's `historyRunCount` controls
how much synthetic history (if any) it ships. Each
persona also takes an optional
**`autonomyLevel`** (`"auto"` default, `"guided"`, or `"review"`): a `review`
persona ships in "agents propose, humans dispose" mode — its heartbeat queues
a proposal to the approval inbox rather than running it; a `guided` persona
runs routine picks immediately but proposes when the picked card is
**high priority** (the stock seed ships **Devon** guided). This field is
host-extension ONLY — never serialize it onto the normative
`/v1/agents/roster` response (`agent-roster-entry.schema.json` is
`additionalProperties: false`; leaking it fails conformance). The stock seed
ships **Nora** in
`review` so the approval flow is demonstrable out of the box). See
[`seed-data/SEEDING.md`](../../backend/typescript/src/host/seed-data/SEEDING.md).

> **Protocol identifiers are NOT branding** and must stay: `core.openwop.*`
> capability IDs, `/.well-known/openwop`, the `x-openwop-device-token` header,
> `Capabilities-Etag`, and `anon:`/`user:` tenant prefixes are the OpenWOP wire
> protocol your host implements — not a product name. Leave them as-is.

### Note for the reference `app.openwop.dev` deploy

Because the managed system-prompt fallback is now brand-neutral, the reference
deployment should set `OPENWOP_MANAGED_SYSTEM_PROMPT` to retain its OpenWOP
grounding blurb (incremental env update, no rebuild needed).

---

## 5. Build + deploy your white-label instance

The app is **two independent deploys** — backend (Cloud Run) and frontend
(Firebase Hosting). Full recipe + prerequisites in
[`../../DEPLOY.md`](../../DEPLOY.md); the white-label-relevant steps:

1. **Backend** (unchanged by re-branding — deploy first so new SPA calls
   resolve):

   ```sh
   gcloud run deploy <your-backend> --source . \
     --region <region> --project <project> --quiet
   ```

2. **Frontend** — build with your brand env in place, then deploy:

   ```sh
   ( cd frontend/react && npm run build )   # reads .env.production[.local]
   firebase deploy --only hosting:<target> --project <project>
   ```

   The production build **aborts** unless `VITE_OPENWOP_BASE_URL` is set
   and non-default (guards against shipping a localhost-pointed bundle).

3. **Verify**: load the page and confirm the tab title, header wordmark,
   icon mark, and footer all show your brand; `curl https://<your-domain>/`
   should reference the same `assets/index-<hash>.js` your local `dist/`
   just built.

---

## File map

| File | Role |
|---|---|
| `src/chrome/features.tsx` | **The feature manifest** — declare your pages once (`{path, element, tier: workspace\|admin, chrome, nav}`); routes, the two-tier nav (workspace rail + Admin console), width rules, and the ⌘K catalog all derive. A fork re-shapes the whole IA in this one file |
| `src/chrome/AdminLayout.tsx` | The admin tier's embedded collapsible rail (pathless layout route; deep links unchanged) |
| `src/brand/defaults.ts` | Default brand values + `VITE_BRAND_*` → field mapping (pure data; shared by client + Vite plugin) |
| `src/brand/brand.ts` | Client-resolved `brand` singleton (layers `import.meta.env` over defaults) |
| `src/brand/BrandMark.tsx` | The header icon mark + wordmark component |
| `src/brand/brand.css` | The color/type override layer (loads after `global.css`) |
| `vite.config.ts` → `openwop-brand-html` | Stamps title/favicon/fonts into `index.html` at build time |
